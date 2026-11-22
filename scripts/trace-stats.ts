// "Where does the time go?" answered from Tempo alone: finds the traces of one implementation and
// scenario in a time window, samples them, and ranks spans by their own (self) time.
//
// Usage:
//   node scripts/trace-stats.ts --impl go --scenario slow-db --from 2026-11-22T10:00:00Z --to 2026-11-22T10:01:30Z
//   node scripts/trace-stats.ts --run experiments/01-slow-db/results/run1-go-slow-db [--step rate4]
//     (reads impl, scenario and the step's time window from the run's summary.json)
// Tempo makes new traces searchable after a few seconds; wait ~15 s after a run before analysing it.
//   add --json to print machine-readable output
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { asyncSpanIds, getTrace, rootSpan, searchTraces, selfTimes } from './lib/tempo.ts';

const { values } = parseArgs({
  options: {
    impl: { type: 'string' },
    scenario: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    run: { type: 'string' },
    step: { type: 'string' },
    sample: { type: 'string', default: '100' },
    json: { type: 'boolean', default: false },
  },
});

let { impl, scenario, from, to } = values;
if (values.run) {
  type Summary = { impl: string; scenario: string; steps: { step: string; from: string; to: string }[] };
  const summary = JSON.parse(await readFile(join(values.run, 'summary.json'), 'utf8')) as Summary;
  const step = values.step ? summary.steps.find((s) => s.step === values.step) : summary.steps[0];
  if (!step) {
    console.error(`no step ${values.step}; have ${summary.steps.map((s) => s.step).join(', ')}`);
    process.exit(2);
  }
  impl ??= summary.impl;
  scenario ??= summary.scenario;
  from ??= step.from;
  to ??= step.to;
}
if (!impl || !scenario || !from || !to) {
  console.error('need --impl, --scenario, --from and --to (or --run <dir with meta.json>)');
  process.exit(2);
}

const startSec = Date.parse(from) / 1000;
const endSec = Date.parse(to) / 1000;
// The order API's server span carries the business attributes; it identifies the request.
const q = `{ kind = server && span.lab.impl = "${impl}" && span.lab.scenario = "${scenario}" }`;
const hits = (await searchTraces(q, startSec, endSec)).filter((h) => {
  const t = Number(BigInt(h.startTimeUnixNano) / 1_000_000n) / 1000;
  return t >= startSec && t <= endSec;
});

// Evenly spaced sample, so a long run is not judged by its first seconds only.
const sampleSize = Math.min(Number(values.sample), hits.length);
const sample = Array.from({ length: sampleSize }, (_, i) => hits[Math.floor((i * hits.length) / sampleSize)]!);

type Agg = { service: string; name: string; async: boolean; self: number[]; total: number[] };
const agg = new Map<string, Agg>();
const requestMs: number[] = [];
let slowest = { traceId: '', ms: 0 };

for (const hit of sample) {
  const spans = await getTrace(hit.traceID);
  const root = spans && rootSpan(spans);
  if (!spans || !root) continue;
  requestMs.push(root.durationMs);
  if (root.durationMs > slowest.ms) slowest = { traceId: hit.traceID, ms: root.durationMs };
  const self = selfTimes(spans);
  const later = asyncSpanIds(spans);
  // Sum per span name within the trace first (a trace can have two pool.acquire spans, for example).
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
    a.self.push(v.self);
    a.total.push(v.total);
    agg.set(key, a);
  }
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

// A span missing from a trace (a new connection, a cache miss) spent 0 ms there.
for (const a of agg.values()) {
  while (a.self.length < requestMs.length) {
    a.self.push(0);
    a.total.push(0);
  }
}

const rows = [...agg.values()]
  .map((a) => ({
    service: a.service,
    span: a.name,
    async: a.async,
    traces: a.self.filter((v, i) => v > 0 || a.total[i]! > 0).length,
    selfP50: pct(a.self, 50),
    selfP95: pct(a.self, 95),
    totalP50: pct(a.total, 50),
    totalP95: pct(a.total, 95),
  }))
  .sort((x, y) => Number(x.async) - Number(y.async) || y.selfP50 - x.selfP50);

const requestP50 = pct(requestMs, 50);
const summary = {
  impl,
  scenario,
  window: { from, to },
  tracesFound: hits.length,
  tracesSampled: requestMs.length,
  request: { p50: requestP50, p95: pct(requestMs, 95), p99: pct(requestMs, 99) },
  slowest,
  culprit: rows.find((r) => !r.async),
  spans: rows,
};

if (values.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const f = (n: number) => n.toFixed(1).padStart(7);
  console.log(`${impl} / ${scenario}: ${hits.length} traces in window, ${requestMs.length} sampled`);
  console.log(`request (gateway span) p50 ${requestP50.toFixed(1)} ms, p95 ${summary.request.p95.toFixed(1)} ms, p99 ${summary.request.p99.toFixed(1)} ms`);
  console.log(`slowest sampled trace: ${slowest.traceId} (${slowest.ms.toFixed(1)} ms)\n`);
  console.log(`${'service'.padEnd(16)} ${'span'.padEnd(30)} ${'self p50'.padStart(8)} ${'self p95'.padStart(8)} ${'share'.padStart(6)} ${'seen in'.padStart(8)}`);
  let lastAsync = false;
  for (const r of rows) {
    if (r.async && !lastAsync) console.log('-- after the queue (not part of the response time) --');
    lastAsync = r.async;
    if (r.selfP95 < 0.05) continue;
    const share = r.async ? '' : `${((r.selfP50 / Math.max(requestP50, 1e-9)) * 100).toFixed(0)}%`;
    const seen = `${Math.round((r.traces / Math.max(requestMs.length, 1)) * 100)}%`;
    console.log(`${r.service.padEnd(16)} ${r.span.slice(0, 30).padEnd(30)} ${f(r.selfP50)}  ${f(r.selfP95)} ${share.padStart(6)} ${seen.padStart(8)}`);
  }
}
