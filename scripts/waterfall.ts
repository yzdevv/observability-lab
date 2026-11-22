// Print one trace as a text waterfall, for docs and terminals.
// Usage: node scripts/waterfall.ts <traceId> [--width 48] [--request-only]
import { parseArgs } from 'node:util';
import { asyncSpanIds, getTrace, rootSpan, type Span } from './lib/tempo.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { width: { type: 'string', default: '48' }, 'request-only': { type: 'boolean', default: false } },
});
const traceId = positionals[0];
if (!traceId) {
  console.error('usage: node scripts/waterfall.ts <traceId> [--width 48] [--request-only]');
  process.exit(2);
}

let spans = await getTrace(traceId);
if (!spans?.length) {
  console.error(`trace ${traceId} not found in Tempo`);
  process.exit(1);
}
if (values['request-only']) {
  const later = asyncSpanIds(spans);
  spans = spans.filter((s) => !later.has(s.spanId));
}

const root = rootSpan(spans) ?? spans.reduce((a, b) => (a.startMs <= b.startMs ? a : b));
const t0 = Math.min(...spans.map((s) => s.startMs));
const t1 = Math.max(...spans.map((s) => s.endMs));
const width = Number(values.width);
const scale = width / Math.max(t1 - t0, 1);

const children = new Map<string, Span[]>();
for (const s of spans) {
  const list = children.get(s.parentSpanId) ?? [];
  list.push(s);
  children.set(s.parentSpanId, list);
}
for (const list of children.values()) list.sort((a, b) => a.startMs - b.startMs);

const rows: { label: string; service: string; ms: number; bar: string }[] = [];
function walk(span: Span, depth: number) {
  const from = Math.floor((span.startMs - t0) * scale);
  const len = Math.max(1, Math.round(span.durationMs * scale));
  const bar = ' '.repeat(Math.min(from, width - 1)) + '█'.repeat(Math.min(len, width - Math.min(from, width - 1)));
  rows.push({ label: '  '.repeat(depth) + span.name, service: span.service, ms: span.durationMs, bar });
  for (const c of children.get(span.spanId) ?? []) walk(c, depth + 1);
}
walk(root, 0);
// Spans whose parent is missing (not yet flushed) are shown at the end rather than dropped.
const shown = new Set<string>();
const mark = (s: Span) => { shown.add(s.spanId); (children.get(s.spanId) ?? []).forEach(mark); };
mark(root);
for (const s of spans) if (!shown.has(s.spanId)) { walk(s, 0); mark(s); }

const labelW = Math.max(...rows.map((r) => r.label.length));
const svcW = Math.max(...rows.map((r) => r.service.length));
console.log(`trace ${traceId}  total ${(t1 - t0).toFixed(1)} ms  (request ${root.durationMs.toFixed(1)} ms)`);
for (const r of rows) {
  console.log(`${r.label.padEnd(labelW)}  ${r.service.padEnd(svcW)}  ${r.ms.toFixed(1).padStart(7)} ms  |${r.bar.padEnd(width)}|`);
}
