// Turning a flat span list into what the waterfall and its one-line summary need.
import type { Span } from './api.ts';

export type Row = { span: Span; depth: number; afterResponse: boolean };

/**
 * Depth-first order, children by start time, with each span's depth. `all` is the full trace when
 * `spans` is a subset: a span whose parent is hidden hangs under its nearest shown ancestor.
 */
export function treeRows(spans: Span[], all: Span[] = spans): Row[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const byId = new Map(all.map((s) => [s.spanId, s]));
  const shownParent = (s: Span) => {
    for (let p = byId.get(s.parentSpanId); p; p = byId.get(p.parentSpanId)) if (ids.has(p.spanId)) return p.spanId;
    // A parent that never arrived: show the span at the top level rather than lose it.
    return '';
  };
  const children = new Map<string, Span[]>();
  for (const s of spans) {
    const parent = shownParent(s);
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  for (const list of children.values()) list.sort((a, b) => a.startMs - b.startMs);
  const root = rootOf(spans);
  const responseEnd = root ? root.startMs + root.durationMs : Infinity;
  const rows: Row[] = [];
  const walk = (parent: string, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      rows.push({ span: s, depth, afterResponse: s.startMs >= responseEnd });
      walk(s.spanId, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/**
 * Plumbing a visitor can skip on first look: waiting for a pool connection, Redis commands, and
 * the outgoing HTTP client spans (the server span on the other side says the same).
 */
export function isPlumbing(span: Span): boolean {
  if (span.error || span.parentSpanId === '') return false;
  if (['pg-pool.connect', 'pool.acquire', 'pg.connect'].includes(span.name)) return true;
  if (span.attributes['db.system.name'] === 'redis') return true;
  return span.kind === 'client' && !span.attributes['db.system.name'];
}

export const rootOf = (spans: Span[]) => spans.find((s) => s.parentSpanId === '' && s.service === 'gateway');

/** Time a span spent itself, not in its children (overlapping children merged, clipped to the span). */
export function selfTime(span: Span, spans: Span[]): number {
  const end = span.startMs + span.durationMs;
  const kids = spans
    .filter((k) => k.parentSpanId === span.spanId)
    .map((k) => [Math.max(k.startMs, span.startMs), Math.min(k.startMs + k.durationMs, end)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let cur: [number, number] | undefined;
  for (const [a, b] of kids) {
    if (!cur || a > cur[1]) {
      if (cur) covered += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) covered += cur[1] - cur[0];
  return Math.max(0, span.durationMs - covered);
}

/** A name a visitor understands, e.g. "INSERT into orders" for a database query span. */
export function describe(span: Span): string {
  const a = span.attributes;
  const op = a['db.operation.name'];
  if (a['db.system.name'] === 'redis') return `Redis ${String(op ?? span.name).toUpperCase()}`;
  if (typeof op === 'string') {
    const text = String(a['db.query.text'] ?? a['db.statement'] ?? '');
    const table = a['db.collection.name'] ?? /\b(?:into|from|update)\s+(\w+)/i.exec(text)?.[1];
    return table ? `${op} ${op === 'SELECT' ? 'from' : op === 'INSERT' ? 'into' : 'on'} ${table}` : `${op} query`;
  }
  const text = a['db.query.text'] ?? a['db.statement'];
  if (typeof text === 'string') {
    const m = /^\s*(\w+)\s+(?:.*?\b(?:into|from|update)\s+)?(\w+)?/i.exec(text);
    if (m) return `${m[1]!.toUpperCase()}${m[2] ? ` ${m[2]}` : ''}`;
  }
  return FRIENDLY[span.name] ?? span.name;
}

const FRIENDLY: Record<string, string> = {
  'gateway.guards': 'gateway load checks',
  'order.validate': 'validating the order',
  'product.lookup': 'looking up the product',
  'payment.authorize': 'the payment call',
  'order.persist': 'saving the order',
  'order.enqueue': 'queueing the order',
  'order.process': 'the worker processing it',
  'order.fulfil': 'fulfilling the order',
  'pg-pool.connect': 'waiting for a database connection',
  'pool.acquire': 'waiting for a database connection',
};

/** Secondary text under a span name: the SQL, the route, the Redis command. */
export function detail(span: Span): string | undefined {
  const a = span.attributes;
  const text = a['db.query.text'] ?? a['db.statement'];
  return typeof text === 'string' ? text.replace(/\s+/g, ' ') : undefined;
}

export type Summary = {
  responseMs: number;
  /** The span (in the request part) with the most self time. */
  hottest?: { span: Span; ms: number; share: number };
  /** Worker part: when it finished, relative to the request start, and how many attempts. */
  worker?: { doneAfterMs: number; attempts: number; failedAttempts: number };
};

export function summarise(spans: Span[]): Summary | undefined {
  const root = rootOf(spans);
  if (!root) return undefined;
  const rows = treeRows(spans);
  const consumerIds = new Set<string>();
  // Everything under a consumer span runs after the queue hop.
  for (const r of rows) {
    const parent = spans.find((s) => s.spanId === r.span.parentSpanId);
    if (r.span.kind === 'consumer' || (parent && consumerIds.has(parent.spanId))) consumerIds.add(r.span.spanId);
  }
  const sync = spans.filter((s) => !consumerIds.has(s.spanId));
  let hottest: Summary['hottest'];
  for (const s of sync) {
    // The root's own time is the gateway's overhead; it is a fair candidate too.
    const ms = selfTime(s, sync);
    if (!hottest || ms > hottest.ms) hottest = { span: s, ms, share: ms / root.durationMs };
  }
  const processes = spans.filter((s) => s.name === 'order.process');
  const worker = processes.length
    ? {
        doneAfterMs: Math.max(...processes.map((p) => p.startMs + p.durationMs)) - root.startMs,
        attempts: processes.length,
        failedAttempts: processes.filter((p) => p.error).length,
      }
    : undefined;
  return { responseMs: root.durationMs, hottest, worker };
}

export const SERVICE_LABEL: Record<string, string> = {
  gateway: 'Gateway',
  'order-api-node': 'Order API (Node.js)',
  'worker-node': 'Worker (Node.js)',
  'order-api-go': 'Order API (Go)',
  'worker-go': 'Worker (Go)',
  'fake-payment': 'Payment provider',
};

/** Colour family of a service: the gateway, Node, Go or the outside payment provider. */
export function family(service: string): 'gateway' | 'node' | 'go' | 'payment' {
  if (service.endsWith('-node')) return 'node';
  if (service.endsWith('-go')) return 'go';
  if (service === 'fake-payment') return 'payment';
  return 'gateway';
}

export const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 2)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`);
