// Milestone E: the gateway endpoints the public page uses (trace lookup, live numbers), and the
// page itself behind lab-web's nginx.
// Usage: LAB_URL=http://127.0.0.1:8088 WEB_URL=http://127.0.0.1:8090 pnpm test:contract
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.LAB_URL ?? 'http://127.0.0.1:8088';
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:8090';

type PublicSpan = { service: string; name: string; kind: string; parentSpanId: string; attributes: Record<string, unknown> };

describe('GET /api/traces/:id', () => {
  it('returns the visitor’s trace with only allow-listed attributes', async () => {
    const sentAt = Date.now();
    const res = await fetch(`${BASE}/api/go/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'demo-002', quantity: 1, scenario: 'slow-db' }),
    });
    assert.equal(res.status, 202);
    const traceId = res.headers.get('x-trace-id')!;

    let spans: PublicSpan[] = [];
    for (let i = 0; i < 30 && !spans.some((s) => s.name === 'order.process'); i++) {
      await sleep(1000);
      const t = await fetch(`${BASE}/api/traces/${traceId}?at=${sentAt}`);
      if (t.status === 200) spans = ((await t.json()) as { spans: PublicSpan[] }).spans;
      else assert.equal(t.status, 404, 'not found yet is the only acceptable miss');
    }
    const root = spans.find((s) => s.parentSpanId === '');
    assert.equal(root?.service, 'gateway');
    assert.ok(spans.some((s) => s.service === 'worker-go' && s.kind === 'consumer'));
    const insert = spans.find((s) => s.attributes['db.operation.name'] === 'INSERT' || /insert/i.test(String(s.attributes['db.query.text'] ?? '')));
    assert.ok(insert, 'the INSERT span is there');
    const keys = new Set(spans.flatMap((s) => Object.keys(s.attributes)));
    for (const leaked of ['server.address', 'server.port', 'net.peer.name', 'process.command_args']) {
      assert.ok(!keys.has(leaked), `${leaked} must not be exposed`);
    }
  });

  it('rejects malformed IDs and unknown traces', async () => {
    assert.equal((await fetch(`${BASE}/api/traces/not-a-trace`)).status, 400);
    assert.equal((await fetch(`${BASE}/api/traces/${'0'.repeat(31)}1?at=${Date.now()}`)).status, 404);
  });
});

describe('GET /api/lab/stats', () => {
  it('reports RED numbers per implementation', async () => {
    const res = await fetch(`${BASE}/api/lab/stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { window: string; impls: Record<string, Record<string, number | null>> };
    assert.equal(body.window, '5m');
    for (const impl of ['node', 'go']) {
      assert.deepEqual(Object.keys(body.impls[impl]!).sort(), ['errorPct', 'p50Ms', 'p95Ms', 'rps']);
    }
  });
});

describe('lab-web', () => {
  it('serves the page with security headers and proxies the API', async () => {
    const page = await fetch(`${WEB}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(await page.text(), /<div id="root">/);
    // Client-side routes fall back to the page.
    assert.equal((await fetch(`${WEB}/some/route`)).status, 200);
    const health = await fetch(`${WEB}/api/health`);
    assert.equal(health.status, 200);
  });
});
