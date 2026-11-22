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
          spanId: s.spanId,
          parentSpanId: s.parentSpanId ?? '',
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

export async function getTrace(traceId: string): Promise<Span[] | undefined> {
  const res = await fetch(`${TEMPO}/api/v2/traces/${traceId}`);
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

export type SearchHit = { traceID: string; startTimeUnixNano: string; durationMs?: number };

/** TraceQL search over a time window (seconds since the epoch). */
export async function searchTraces(q: string, startSec: number, endSec: number, limit = 5000): Promise<SearchHit[]> {
  const url = new URL(`${TEMPO}/api/search`);
  url.search = new URLSearchParams({ q, start: String(Math.floor(startSec)), end: String(Math.ceil(endSec)), limit: String(limit), spss: '1' }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tempo search returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { traces?: SearchHit[] };
  return body.traces ?? [];
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
