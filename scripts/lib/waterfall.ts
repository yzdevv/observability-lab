// Text waterfall of one trace: a tree of spans with a time bar each.
import { asyncSpanIds, rootSpan, type Span } from './tempo.ts';

export function renderWaterfall(all: Span[], opts: { width?: number; requestOnly?: boolean; title?: string } = {}): string {
  const width = opts.width ?? 48;
  let spans = all;
  if (opts.requestOnly) {
    const later = asyncSpanIds(spans);
    spans = spans.filter((s) => !later.has(s.spanId));
  }
  if (!spans.length) return '(no spans)';

  const root = rootSpan(spans) ?? spans.reduce((a, b) => (a.startMs <= b.startMs ? a : b));
  const t0 = Math.min(...spans.map((s) => s.startMs));
  const t1 = Math.max(...spans.map((s) => s.endMs));
  const scale = width / Math.max(t1 - t0, 1);

  const children = new Map<string, Span[]>();
  for (const s of spans) {
    const list = children.get(s.parentSpanId) ?? [];
    list.push(s);
    children.set(s.parentSpanId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.startMs - b.startMs);

  const rows: { label: string; service: string; ms: number; bar: string }[] = [];
  const shown = new Set<string>();
  function walk(span: Span, depth: number) {
    shown.add(span.spanId);
    const from = Math.min(Math.floor((span.startMs - t0) * scale), width - 1);
    const len = Math.min(Math.max(1, Math.round(span.durationMs * scale)), width - from);
    rows.push({ label: '  '.repeat(depth) + span.name, service: span.service, ms: span.durationMs, bar: ' '.repeat(from) + '█'.repeat(len) });
    for (const c of children.get(span.spanId) ?? []) walk(c, depth + 1);
  }
  walk(root, 0);
  // Spans whose parent is missing (not flushed yet) are shown at the end rather than dropped.
  for (const s of spans) if (!shown.has(s.spanId)) walk(s, 0);

  const labelW = Math.max(...rows.map((r) => r.label.length));
  const svcW = Math.max(...rows.map((r) => r.service.length));
  const head = `${opts.title ? `${opts.title}  ` : ''}total ${(t1 - t0).toFixed(1)} ms, response ${root.durationMs.toFixed(1)} ms`;
  return [
    head,
    ...rows.map((r) => `${r.label.padEnd(labelW)}  ${r.service.padEnd(svcW)}  ${r.ms.toFixed(1).padStart(7)} ms  |${r.bar.padEnd(width)}|`),
  ].join('\n');
}
