// Small client for Tempo's HTTP API, shared by the tracing tests and the experiment scripts.
import { setTimeout as sleep } from 'node:timers/promises';

export const TEMPO = process.env.TEMPO_URL ?? 'http://127.0.0.1:3200';

export type Span = {
  service: string;
  name: string;
  spanId: string;
  parentSpanId: string;
  kind: string;
  /** Milliseconds since the Unix epoch (fractional). */
  startMs: number;
  endMs: number;
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
export type TraceBody = { trace?: { resourceSpans?: OtlpResourceSpans[] }; batches?: OtlpResourceSpans[] };

function attrs(list: OtlpAttr[] = []): Record<string, unknown> {
  return Object.fromEntries(
    list.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? value.doubleValue ?? Number(value.intValue)]),
  );
}

const nsToMs = (ns: string) => Number(BigInt(ns) / 1000n) / 1000;

// The trace-by-id endpoint returns IDs base64-encoded (proto JSON), search returns hex; use hex.
const hexId = (id: string) => (id === '' || /^[0-9a-f]+$/.test(id) ? id : Buffer.from(id, 'base64').toString('hex'));

// Tempo's v2 API wraps resourceSpans in { trace }, the v1 API calls them batches; accept both.
export function flatten(body: TraceBody): Span[] {
  const batches = body.trace?.resourceSpans ?? body.batches ?? [];
  return batches.flatMap((rs) => {
    const service = String(attrs(rs.resource.attributes)['service.name']);
    return rs.scopeSpans.flatMap(({ spans }) =>
      spans.map((s) => {
        const startMs = nsToMs(s.startTimeUnixNano);
        const endMs = nsToMs(s.endTimeUnixNano);
        return {
          service,
          name: s.name,
          spanId: hexId(s.spanId),
          parentSpanId: hexId(s.parentSpanId ?? ''),
          kind: s.kind ?? '',
          startMs,
          endMs,
          durationMs: endMs - startMs,
          attributes: attrs(s.attributes),
        };
      }),
    );
  });
}

/**
 * Fetch one trace. A time window (seconds since the epoch) is optional but makes the lookup much
 * faster, because Tempo then only checks the blocks that cover it.
 */
export async function getTrace(traceId: string, window?: { startSec: number; endSec: number }): Promise<Span[] | undefined> {
  const qs = window ? `?start=${Math.floor(window.startSec)}&end=${Math.ceil(window.endSec)}` : '';
  const res = await fetch(`${TEMPO}/api/v2/traces/${traceId}${qs}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Tempo returned ${res.status} for trace ${traceId}`);
  return flatten((await res.json()) as TraceBody);
}

// Spans arrive in batches (SDK → collector → Tempo), so poll until the trace is complete enough.
export async function waitForTrace(traceId: string, until: (spans: Span[]) => boolean, timeoutMs = 20_000): Promise<Span[]> {
  let spans: Span[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    spans = (await getTrace(traceId)) ?? [];
    if (until(spans)) return spans;
    await sleep(500);
  }
  throw new Error(`trace ${traceId} incomplete after ${timeoutMs / 1000} s: ${spans.map((s) => `${s.service}/${s.name}`).join(', ')}`);
}

/** The gateway's server span: the request as the client saw it. */
export const rootSpan = (spans: Span[]) => spans.find((s) => s.parentSpanId === '' && s.service === 'gateway');

/**
 * Time spent in a span itself, not in its children (overlapping children are merged).
 * Children that run after the parent ended (the async worker) are clipped out.
 */
export function selfTimes(spans: Span[]): Map<string, number> {
  const children = new Map<string, Span[]>();
  for (const s of spans) {
    const list = children.get(s.parentSpanId) ?? [];
    list.push(s);
    children.set(s.parentSpanId, list);
  }
  const out = new Map<string, number>();
  for (const s of spans) {
    const kids = (children.get(s.spanId) ?? [])
      .map((k) => [Math.max(k.startMs, s.startMs), Math.min(k.endMs, s.endMs)] as const)
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    let covered = 0;
    let curStart = -Infinity;
    let curEnd = -Infinity;
    for (const [a, b] of kids) {
      if (a > curEnd) {
        if (curEnd > curStart) covered += curEnd - curStart;
        curStart = a;
        curEnd = b;
      } else {
        curEnd = Math.max(curEnd, b);
      }
    }
    if (curEnd > curStart) covered += curEnd - curStart;
    out.set(s.spanId, Math.max(0, s.durationMs - covered));
  }
  return out;
}

/** Spans that run after the queue hop (the consumer span and everything under it). */
export function asyncSpanIds(spans: Span[]): Set<string> {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const result = new Set<string>();
  for (const s of spans) {
    for (let cur: Span | undefined = s; cur; cur = byId.get(cur.parentSpanId)) {
      if (cur.kind === 'SPAN_KIND_CONSUMER') {
        result.add(s.spanId);
        break;
      }
    }
  }
  return result;
}

type SearchSpan = {
  spanID: string;
  name?: string;
  startTimeUnixNano: string;
  durationNanos: string;
  attributes?: OtlpAttr[];
};
type SpanSearchHit = { traceID: string; startTimeUnixNano: string; spanSet?: { spans: SearchSpan[] }; spanSets?: { spans: SearchSpan[] }[] };

const KINDS: Record<string, string> = {
  server: 'SPAN_KIND_SERVER',
  client: 'SPAN_KIND_CLIENT',
  internal: 'SPAN_KIND_INTERNAL',
  producer: 'SPAN_KIND_PRODUCER',
  consumer: 'SPAN_KIND_CONSUMER',
};

/**
 * Every span of every trace that matches `filter`, in one TraceQL search. Much cheaper than one
 * trace-by-id lookup per trace (seconds each on a CPU-capped Tempo). Spans carry structure and
 * timing but only the attributes selected here. Tempo caps a span set at 100 spans; an order
 * trace has about 25.
 */
export async function searchTraceSpans(filter: string, startSec: number, endSec: number, chunkSec = 5): Promise<Map<string, Span[]>> {
  // Busy windows are searched in chunks: one big query can outlast Tempo's 30 s write timeout.
  const out = new Map<string, Span[]>();
  for (let from = startSec; from < endSec; from += chunkSec) {
    const part = await searchChunk(filter, from, Math.min(from + chunkSec, endSec));
    // A trace overlapping two chunks is returned twice; keep the more complete copy.
    for (const [id, spans] of part) if ((out.get(id)?.length ?? 0) < spans.length) out.set(id, spans);
  }
  return out;
}

async function searchChunk(filter: string, startSec: number, endSec: number, limit = 5000): Promise<Map<string, Span[]>> {
  const q = `${filter} && { true } | select(span:name, span:parentID, resource.service.name, span:kind)`;
  const url = new URL(`${TEMPO}/api/search`);
  url.search = new URLSearchParams({ q, start: String(Math.floor(startSec)), end: String(Math.ceil(endSec)), limit: String(limit), spss: '100' }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tempo search returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { traces?: SpanSearchHit[] };
  const out = new Map<string, Span[]>();
  for (const t of body.traces ?? []) {
    const sets = t.spanSets ?? (t.spanSet ? [t.spanSet] : []);
    const seen = new Set<string>();
    const spans: Span[] = [];
    for (const s of sets.flatMap((x) => x.spans)) {
      if (seen.has(s.spanID)) continue;
      seen.add(s.spanID);
      const a = attrs(s.attributes);
      const startMs = nsToMs(s.startTimeUnixNano);
      const durationMs = Number(BigInt(s.durationNanos) / 1000n) / 1000;
      const parent = String(a['span:parentID'] ?? '');
      spans.push({
        service: String(a['service.name'] ?? ''),
        name: s.name ?? String(a['span:name'] ?? a.name ?? ''),
        spanId: s.spanID,
        parentSpanId: /^0*$/.test(parent) ? '' : parent,
        kind: KINDS[String(a.kind)] ?? String(a.kind ?? ''),
        startMs,
        endMs: startMs + durationMs,
        durationMs,
        attributes: a,
      });
    }
    out.set(t.traceID, spans);
  }
  return out;
}
