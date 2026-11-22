// Trace lookup for the public page: reads one trace from Tempo and returns a compact span list.
// Only traces the lab created (root span = the gateway) are returned, and only a fixed set of
// attributes, so the page never shows more than the waterfall needs.
import { config } from './config.ts';

export type PublicSpan = {
  spanId: string;
  parentSpanId: string;
  service: string;
  name: string;
  kind: string;
  /** Milliseconds since the Unix epoch (fractional). */
  startMs: number;
  durationMs: number;
  error: boolean;
  attributes: Record<string, string | number | boolean>;
};

export type PublicTrace = { traceId: string; spans: PublicSpan[] };

// Attributes worth showing to a visitor. Everything else (hosts, ports, SDK versions) is dropped.
const KEEP = new Set([
  'http.request.method', 'http.route', 'http.response.status_code', 'url.path',
  'db.system.name', 'db.operation.name', 'db.query.text', 'db.statement', 'db.collection.name',
  'cache.hit', 'cache.skipped', 'product.id', 'order.id', 'order.updated',
  'lab.impl', 'lab.scenario', 'lab.attempt', 'lab.simulated', 'lab.shed_reason', 'lab.guard.passed',
  'lab.dependency', 'lab.breaker.state', 'lab.breaker.probe', 'lab.breaker.rejected', 'lab.retry.delay_ms',
  'lab.retry.final', 'lab.retry.scheduled', 'lab.retry.exhausted', 'lab.payment.outage', 'lab.client_error', 'messaging.system', 'messaging.operation.type', 'messaging.destination.name',
  'error.type', 'exception.message',
]);

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
  status?: { code?: string };
  events?: { name: string; attributes?: OtlpAttr[] }[];
};
type Batch = { resource: { attributes: OtlpAttr[] }; scopeSpans: { spans: OtlpSpan[] }[] };

const value = (v: OtlpValue) => v.stringValue ?? v.boolValue ?? v.doubleValue ?? Number(v.intValue);
// Trace-by-id returns base64 IDs (proto JSON); the page uses hex like everything else.
const hex = (id = '') => (id === '' || /^[0-9a-f]+$/.test(id) ? id : Buffer.from(id, 'base64').toString('hex'));
const nsToMs = (ns: string) => Number(BigInt(ns) / 1000n) / 1000;
const short = (v: string | number | boolean) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v);

function compact(batches: Batch[]): PublicSpan[] {
  return batches.flatMap((b) => {
    const service = String(b.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue ?? 'unknown');
    return b.scopeSpans.flatMap(({ spans }) =>
      spans.map((s) => {
        const attributes: PublicSpan['attributes'] = {};
        for (const a of s.attributes ?? []) if (KEEP.has(a.key)) attributes[a.key] = short(value(a.value));
        // Recorded exceptions live in span events; keep the message.
        const exc = s.events?.find((e) => e.name === 'exception')?.attributes?.find((a) => a.key === 'exception.message');
        if (exc) attributes['exception.message'] = short(value(exc.value));
        const startMs = nsToMs(s.startTimeUnixNano);
        return {
          spanId: hex(s.spanId),
          parentSpanId: hex(s.parentSpanId),
          service,
          name: s.name,
          kind: (s.kind ?? '').replace('SPAN_KIND_', '').toLowerCase(),
          startMs,
          durationMs: nsToMs(s.endTimeUnixNano) - startMs,
          error: s.status?.code === 'STATUS_CODE_ERROR',
          attributes,
        };
      }),
    );
  }).sort((a, b) => a.startMs - b.startMs);
}

export class TraceNotFound extends Error {}

/**
 * Look up a lab trace. `aroundMs` (when the request was sent) narrows the Tempo search to a few
 * minutes, which is much faster than a lookup over all blocks on a CPU-capped Tempo.
 */
export async function getPublicTrace(traceId: string, aroundMs: number | undefined): Promise<PublicTrace> {
  const qs = aroundMs ? `?start=${Math.floor(aroundMs / 1000) - 60}&end=${Math.ceil(aroundMs / 1000) + 300}` : '';
  const res = await fetch(`${config.tempoUrl}/api/v2/traces/${traceId}${qs}`, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) throw new TraceNotFound('trace not found (yet)');
  if (!res.ok) throw new Error(`Tempo returned ${res.status}`);
  const body = (await res.json()) as { trace?: { resourceSpans?: Batch[] } };
  const spans = compact(body.trace?.resourceSpans ?? []);
  // Only the lab's own traces: the root must be the gateway's server span.
  const root = spans.find((s) => s.parentSpanId === '');
  if (!root || root.service !== 'gateway') throw new TraceNotFound('not a lab trace');
  return { traceId, spans };
}
