// Small clients for the other telemetry stores and the demo database, used by experiment analysis.
import { execFileSync } from 'node:child_process';

export const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
export const LOKI = process.env.LOKI_URL ?? 'http://127.0.0.1:3100';

type PromSample = { metric: Record<string, string>; value: [number, string] };

/** Instant PromQL query at a given time (seconds since the epoch). */
export async function promQuery(expr: string, atSec: number): Promise<PromSample[]> {
  const url = new URL(`${PROMETHEUS}/api/v1/query`);
  url.search = new URLSearchParams({ query: expr, time: String(atSec) }).toString();
  const res = await fetch(url);
  const body = (await res.json()) as { status: string; error?: string; data?: { result: PromSample[] } };
  if (body.status !== 'success') throw new Error(`PromQL failed: ${body.error} (${expr})`);
  return body.data?.result ?? [];
}

/** First value of an instant query, or null when there is no series. */
export async function promValue(expr: string, atSec: number): Promise<number | null> {
  const [first] = await promQuery(expr, atSec);
  return first ? Number(first.value[1]) : null;
}

export type LogLine = { ts: number; line: string; labels: Record<string, string> };

/** LogQL query over a time window (seconds since the epoch), oldest first. */
export async function lokiQuery(q: string, startSec: number, endSec: number, limit = 5000): Promise<LogLine[]> {
  const url = new URL(`${LOKI}/loki/api/v1/query_range`);
  url.search = new URLSearchParams({
    query: q,
    start: String(Math.floor(startSec * 1e9)),
    end: String(Math.ceil(endSec * 1e9)),
    limit: String(limit),
    direction: 'forward',
  }).toString();
  const res = await fetch(url);
  const body = (await res.json()) as { status: string; error?: string; data?: { result: { stream: Record<string, string>; values: [string, string][] }[] } };
  if (body.status !== 'success') throw new Error(`LogQL failed: ${JSON.stringify(body).slice(0, 200)}`);
  return (body.data?.result ?? [])
    .flatMap((s) => s.values.map(([ts, line]) => ({ ts: Number(BigInt(ts) / 1_000_000n) / 1000, line, labels: s.stream })))
    .sort((a, b) => a.ts - b.ts);
}

/** Run SQL in the lab's Postgres container and return rows as objects (psql CSV with header).
 *  Local Docker by default (the dev stack); LAB_SSH=<host> runs it on that host instead (the homelab).
 *  The query goes in on stdin, so it needs no shell quoting either way. */
export function sql(query: string): Record<string, string>[] {
  const psql = ['docker', 'exec', '-i', 'observability-lab-postgres-1', 'psql', '-U', 'lab', '-d', 'lab', '--csv', '-f', '-'];
  const host = process.env.LAB_SSH;
  const out = host
    ? execFileSync('ssh', [host, psql.join(' ')], { encoding: 'utf8', input: query })
    : execFileSync(psql[0]!, psql.slice(1), { encoding: 'utf8', input: query });
  const [header, ...lines] = out.trim().split('\n');
  if (!header) return [];
  const cols = header.split(',');
  return lines.filter(Boolean).map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i]!, v])));
}

export const toSec = (iso: string) => Date.parse(iso) / 1000;
export const fmt = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || Number.isNaN(n) ? '–' : n.toFixed(digits));
