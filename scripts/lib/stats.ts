// Trace analysis over a time window: which spans the time goes to, from Tempo alone.
import { asyncSpanIds, rootSpan, searchTraceSpans, selfTimes } from './tempo.ts';

export type SpanRow = {
  service: string;
  span: string;
  /** Runs after the queue hop, so it is not part of the response time. */
  async: boolean;
  /** Number of sampled traces that contain this span. */
  traces: number;
  selfP50: number;
  selfP95: number;
  totalP50: number;
  totalP95: number;
};

export type WindowStats = {
  impl: string;
  scenario: string;
  window: { from: string; to: string };
  tracesFound: number;
  tracesSampled: number;
  /** Gateway server span: the response time as the gateway saw it. */
  request: { p50: number; p95: number; p99: number };
  /** Trace closest to the median request, a fair example to show. */
  typical: { traceId: string; ms: number };
  slowest: { traceId: string; ms: number };
  /** Request-path span with the most self time at the median. */
  culprit: SpanRow | undefined;
  spans: SpanRow[];
};

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export async function analyseWindow(opts: {
  impl: string;
  scenario: string;
  from: string;
  to: string;
  sample?: number;
}): Promise<WindowStats> {
  const { impl, scenario, from, to } = opts;
  const startSec = Date.parse(from) / 1000;
  const endSec = Date.parse(to) / 1000;
  // The order API's server span carries the business attributes; it identifies the request.
  // The order API's server span carries the business attributes; it identifies the request.
  const filter = `{ kind = server && span.lab.impl = "${impl}" && span.lab.scenario = "${scenario}" }`;
  const found = await searchTraceSpans(filter, startSec, endSec);
  const inWindow = [...found].filter(([, spans]) => {
    const root = rootSpan(spans);
    return root !== undefined && root.startMs / 1000 >= startSec && root.startMs / 1000 <= endSec;
  });

  // Evenly spaced sample when asked for one; by default every trace in the window is used.
  const sampleSize = Math.min(opts.sample ?? Infinity, inWindow.length);
  const sample = Array.from({ length: sampleSize }, (_, i) => inWindow[Math.floor((i * inWindow.length) / sampleSize)]!);

  type Agg = { service: string; name: string; async: boolean; self: number[]; total: number[] };
  const agg = new Map<string, Agg>();
  const requests: { traceId: string; ms: number }[] = [];

  for (const [traceId, spans] of sample) {
    const root = rootSpan(spans)!;
    requests.push({ traceId, ms: root.durationMs });
    const self = selfTimes(spans);
    const later = asyncSpanIds(spans);
    // Sum per span name within the trace first (Go has two pool.acquire spans per request, for example).
    const perTrace = new Map<string, { self: number; total: number; service: string; name: string; async: boolean }>();
    for (const s of spans) {
      const key = `${s.service}\u0000${s.name}`;
      const cur = perTrace.get(key) ?? { self: 0, total: 0, service: s.service, name: s.name, async: later.has(s.spanId) };
      cur.self += self.get(s.spanId) ?? 0;
      cur.total += s.durationMs;
      perTrace.set(key, cur);
    }
    for (const [key, v] of perTrace) {
      const a = agg.get(key) ?? { service: v.service, name: v.name, async: v.async, self: [], total: [] };
      // Pad traces seen before this span first appeared: a missing span spent 0 ms there.
      while (a.self.length < requests.length - 1) {
        a.self.push(0);
        a.total.push(0);
      }
      a.self.push(v.self);
      a.total.push(v.total);
      agg.set(key, a);
    }
  }
  for (const a of agg.values()) {
    while (a.self.length < requests.length) {
      a.self.push(0);
      a.total.push(0);
    }
  }

  const spans = [...agg.values()]
    .map((a) => ({
      service: a.service,
      span: a.name,
      async: a.async,
      traces: a.total.filter((v) => v > 0).length,
      selfP50: percentile(a.self, 50),
      selfP95: percentile(a.self, 95),
      totalP50: percentile(a.total, 50),
      totalP95: percentile(a.total, 95),
    }))
    .sort((x, y) => Number(x.async) - Number(y.async) || y.selfP50 - x.selfP50);

  const ms = requests.map((r) => r.ms);
  const p50 = percentile(ms, 50);
  const none = { traceId: '', ms: 0 };
  return {
    impl,
    scenario,
    window: { from, to },
    tracesFound: inWindow.length,
    tracesSampled: requests.length,
    request: { p50, p95: percentile(ms, 95), p99: percentile(ms, 99) },
    typical: requests.reduce((best, r) => (Math.abs(r.ms - p50) < Math.abs(best.ms - p50) ? r : best), requests[0] ?? none),
    slowest: requests.reduce((best, r) => (r.ms > best.ms ? r : best), none),
    culprit: spans.find((r) => !r.async),
    spans,
  };
}

export function formatStats(s: WindowStats): string {
  const f = (n: number) => n.toFixed(1).padStart(7);
  const out = [
    `${s.impl} / ${s.scenario}: ${s.tracesFound} traces in window, ${s.tracesSampled} sampled`,
    `request (gateway span) p50 ${s.request.p50.toFixed(1)} ms, p95 ${s.request.p95.toFixed(1)} ms, p99 ${s.request.p99.toFixed(1)} ms`,
    `typical trace: ${s.typical.traceId} (${s.typical.ms.toFixed(1)} ms), slowest: ${s.slowest.traceId} (${s.slowest.ms.toFixed(1)} ms)`,
    '',
    `${'service'.padEnd(16)} ${'span'.padEnd(30)} ${'self p50'.padStart(8)} ${'self p95'.padStart(8)} ${'share'.padStart(6)} ${'seen in'.padStart(8)}`,
  ];
  let lastAsync = false;
  for (const r of s.spans) {
    if (r.async && !lastAsync) out.push('-- after the queue (not part of the response time) --');
    lastAsync = r.async;
    if (r.selfP95 < 0.05) continue;
    const share = r.async ? '' : `${((r.selfP50 / Math.max(s.request.p50, 1e-9)) * 100).toFixed(0)}%`;
    const seen = `${Math.round((r.traces / Math.max(s.tracesSampled, 1)) * 100)}%`;
    out.push(`${r.service.padEnd(16)} ${r.span.slice(0, 30).padEnd(30)} ${f(r.selfP50)}  ${f(r.selfP95)} ${share.padStart(6)} ${seen.padStart(8)}`);
  }
  return out.join('\n');
}
