// Milestone B: one trace must link gateway → order API → Redis/Postgres → queue → worker,
// for both implementations. Reads traces straight from Tempo.
// Usage: LAB_URL=http://127.0.0.1:8088 TEMPO_URL=http://127.0.0.1:3200 pnpm test:contract
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.LAB_URL ?? 'http://127.0.0.1:8088';
const TEMPO = process.env.TEMPO_URL ?? 'http://127.0.0.1:3200';

type Span = {
  service: string;
  name: string;
  spanId: string;
  parentSpanId: string;
  kind: string;
  durationMs: number;
  attributes: Record<string, unknown>;
};

type OtlpValue = { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number };
type OtlpAttr = { key: string; value: OtlpValue };
type OtlpSpan = {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttr[];
};
type OtlpResourceSpans = {
  resource: { attributes: OtlpAttr[] };
  scopeSpans: { spans: OtlpSpan[] }[];
};

function attrs(list: OtlpAttr[] = []): Record<string, unknown> {
  return Object.fromEntries(
    list.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? value.doubleValue ?? Number(value.intValue)]),
  );
}

// Tempo's v2 API wraps resourceSpans in { trace }, the v1 API calls them batches; accept both.
function flatten(body: { trace?: { resourceSpans?: OtlpResourceSpans[] }; batches?: OtlpResourceSpans[] }): Span[] {
  const batches = body.trace?.resourceSpans ?? body.batches ?? [];
  return batches.flatMap((rs) => {
    const service = String(attrs(rs.resource.attributes)['service.name']);
    return rs.scopeSpans.flatMap(({ spans }) =>
      spans.map((s) => ({
        service,
        name: s.name,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId ?? '',
        kind: s.kind ?? '',
        durationMs: Number((BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1000n) / 1000,
        attributes: attrs(s.attributes),
      })),
    );
  });
}

// Spans arrive in batches (SDK → collector → Tempo), so poll until the worker span is there.
async function fetchTrace(traceId: string, until: (spans: Span[]) => boolean): Promise<Span[]> {
  let spans: Span[] = [];
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${TEMPO}/api/v2/traces/${traceId}`);
    if (res.ok) {
      spans = flatten(await res.json());
      if (until(spans)) return spans;
    }
    await sleep(500);
  }
  throw new Error(`trace ${traceId} incomplete after 20 s: ${spans.map((s) => `${s.service}/${s.name}`).join(', ')}`);
}

async function createOrder(impl: string, scenario = 'none') {
  const res = await fetch(`${BASE}/api/${impl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'demo-005', quantity: 1, scenario }),
  });
  assert.equal(res.status, 202);
  const traceId = res.headers.get('x-trace-id');
  assert.match(traceId ?? '', /^[0-9a-f]{32}$/, 'gateway must return x-trace-id');
  const body = (await res.json()) as { orderId: string };
  return { traceId: traceId!, orderId: body.orderId };
}

const byName = (spans: Span[], service: string, name: string) => {
  const span = spans.find((s) => s.service === service && s.name === name);
  assert.ok(span, `missing span ${service}/${name}; have: ${spans.map((s) => `${s.service}/${s.name}`).join(', ')}`);
  return span;
};

for (const impl of ['node', 'go']) {
  describe(`${impl} trace`, () => {
    it('links the request and the worker in one trace', async () => {
      const { traceId, orderId } = await createOrder(impl);
      const worker = `worker-${impl}`;
      const api = `order-api-${impl}`;
      const spans = await fetchTrace(traceId, (s) =>
        s.some((x) => x.service === 'gateway' && x.parentSpanId === '') &&
        s.some((x) => x.service === worker && x.name === 'order.process') &&
        s.some((x) => x.service === worker && x.name !== 'order.process' && x.name !== 'order.fulfil'));

      // Every hop is present.
      const gatewayServer = byName(spans, 'gateway', 'POST /api/:impl/orders');
      const apiServer = byName(spans, api, 'POST /orders');
      byName(spans, api, 'order.validate');
      const lookup = byName(spans, api, 'product.lookup');
      const persist = byName(spans, api, 'order.persist');
      const enqueue = byName(spans, api, 'order.enqueue');
      const processSpan = byName(spans, worker, 'order.process');
      byName(spans, worker, 'order.fulfil');

      // Parent/child structure across services and across the queue.
      assert.equal(gatewayServer.parentSpanId, '', 'gateway span is the root');
      const gatewayClient = spans.find((s) => s.service === 'gateway' && s.parentSpanId === gatewayServer.spanId &&
        s.spanId === apiServer.parentSpanId);
      assert.ok(gatewayClient, 'order API server span is a child of the gateway HTTP client span');
      assert.equal(processSpan.parentSpanId, enqueue.spanId, 'worker span continues from order.enqueue');

      // Database and cache calls are traced under the business spans.
      assert.ok(spans.some((s) => s.parentSpanId === persist.spanId), 'INSERT span under order.persist');
      assert.ok(spans.some((s) => s.parentSpanId === lookup.spanId), 'cache/DB span under product.lookup');
      assert.ok(spans.some((s) => s.service === worker && s.parentSpanId === processSpan.spanId &&
        s.name !== 'order.fulfil'), 'worker DB/Redis calls under order.process');

      // Business attributes are there for searching.
      assert.equal(apiServer.attributes['lab.impl'], impl);
      assert.equal(apiServer.attributes['order.id'], orderId);
      assert.equal(processSpan.attributes['order.id'], orderId);
      assert.equal(processSpan.kind, 'SPAN_KIND_CONSUMER');
      assert.equal(enqueue.kind, 'SPAN_KIND_PRODUCER');
    });

    it('shows the slow INSERT for slow-db', async () => {
      const { traceId } = await createOrder(impl, 'slow-db');
      const spans = await fetchTrace(traceId, (s) => s.some((x) => x.name === 'order.persist'));
      const persist = byName(spans, `order-api-${impl}`, 'order.persist');
      // The INSERT is the longest child (Go also records a short pool.acquire span here).
      const children = spans.filter((s) => s.parentSpanId === persist.spanId);
      const insert = children.sort((a, b) => b.durationMs - a.durationMs)[0];
      assert.ok(insert, 'INSERT span under order.persist');
      assert.match(insert.name, /INSERT/i);
      assert.ok(insert.durationMs >= 300, `INSERT took ${insert.durationMs} ms, expected >= 300`);
    });
  });
}
