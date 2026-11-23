// Experiment 7 report: queue backlog and load shedding.
// Usage: LAB_SSH=yzserver-claude node analyse.ts <results-dir>   (LAB_SSH: where Postgres and
// Prometheus run; without it, the local dev stack)
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, loadSummary, readJson, statusText, writeReport } from '../../scripts/lib/report.ts';
import { fmt, sql, toSec } from '../../scripts/lib/sources.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node analyse.ts <results-dir>');
const IMPLS = ['node', 'go'] as const;
const COLOR = { node: '#3d8a2e', go: '#007c9c' }; // the demo page's implementation colors
const NAME = { node: 'Node.js', go: 'Go' };

type Phases = { impl: string; workMs: number; rate: number; duration: string; loadStart: number; loadEnd: number; drained: number | null };
type Status = { load1: number; inflight: number; backlog: Record<string, number>; limits: { maxBacklog: number } };

/** Prometheus instant query, through the lab network on LAB_SSH (the query goes in on stdin). */
function prom(expr: string, atSec: number): { metric: Record<string, string>; value: [number, string] }[] {
  const curl = ['curl', '-sG', 'http://prometheus:9090/api/v1/query', '--data-urlencode', 'query@-', '--data-urlencode', `time=${atSec}`];
  const host = process.env.LAB_SSH;
  const out = host
    ? execFileSync('ssh', [host, ['docker', 'run', '--rm', '-i', '--network', 'observability-lab_lab', 'curlimages/curl:8.17.0', ...curl.slice(1)].join(' ')], { encoding: 'utf8', input: expr })
    : execFileSync('curl', curl.slice(1).map((a) => a.replace('prometheus:9090', '127.0.0.1:9090')), { encoding: 'utf8', input: expr });
  const body = JSON.parse(out) as { status: string; data?: { result: { metric: Record<string, string>; value: [number, string] }[] } };
  if (body.status !== 'success') throw new Error(`PromQL failed: ${out.slice(0, 200)}`);
  return body.data?.result ?? [];
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

type Result = {
  impl: string; phases: Phases; limit: number; requests: number; status: Record<string, number>;
  capAtS: number | null; maxBacklog: number; maxLoad1: number;
  acceptedBeforeCap: number | null; acceptedWhileCapped: number | null; workerRate: number | null;
  waitFirst: { p50: number | null; max: number | null }; waitCapped: { p50: number | null; p95: number | null; max: number | null };
  completed: number; failed: number; queuedLeft: number; shedByReason: Record<string, number>; recoveryS: number | null;
  series: { t: number; backlog: number }[]; loadS: number;
};
const results: Result[] = [];

for (const impl of IMPLS) {
  const runDir = join(dir, impl);
  if (!exists(join(runDir, 'phases.json'))) continue;
  const phases = await readJson<Phases>(join(runDir, 'phases.json'));
  const step = (await loadSummary(runDir)).steps[0]!;
  const t0 = toSec(step.from), t1 = toSec(step.to);
  const lines = (await readFile(join(runDir, 'status.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { at: number; status: Status | null });
  const samples = lines.filter((l) => l.status).map((l) => ({ t: l.at - t0, s: l.status! }));
  const limit = samples[0]?.s.limits.maxBacklog ?? 500;
  const series = samples.map(({ t, s }) => ({ t, backlog: s.backlog[impl] ?? 0 }));
  const capAtS = series.find((p) => p.t >= 0 && p.backlog > limit)?.t ?? null;
  const capAt = capAtS === null ? null : t0 + capAtS;

  const rows = sql(`SELECT extract(epoch FROM created_at)::float8 AS c, extract(epoch FROM processed_at)::float8 AS p, status
    FROM orders WHERE impl = '${impl}' AND created_at BETWEEN to_timestamp(${t0}) AND to_timestamp(${t1 + 2})`)
    .map((r) => ({ c: Number(r.c), p: r.p ? Number(r.p) : null, status: r.status! }));
  const between = (a: number, b: number) => rows.filter((r) => r.c >= a && r.c < b);
  const waitMs = (rs: typeof rows) => rs.filter((r) => r.p !== null).map((r) => (r.p! - r.c) * 1000);
  const first = waitMs(between(t0, t0 + 1)); // the first second, before a queue has formed
  const capped = capAt === null ? [] : waitMs(between(capAt + 10, t1)); // skip the overshoot right after the cap
  const processedIn = (a: number, b: number) => rows.filter((r) => r.p !== null && r.p >= a && r.p < b).length;

  const shed = prom(`sum by (lab_shed_reason) (increase(lab_gateway_shed_total{lab_impl="${impl}"}[${Math.ceil(t1 - t0) + 60}s]))`, Math.ceil(t1) + 45);
  const shedByReason = Object.fromEntries(shed.map((s) => [s.metric.lab_shed_reason ?? '?', Math.round(Number(s.value[1]))]));

  results.push({
    impl, phases, limit, requests: step.requests, status: step.status, capAtS, maxLoad1: Math.max(...samples.map((x) => x.s.load1)),
    maxBacklog: Math.max(...series.map((p) => p.backlog)),
    acceptedBeforeCap: capAt === null ? null : between(t0, capAt).length / (capAt - t0),
    acceptedWhileCapped: capAt === null ? null : between(capAt + 10, t1).length / (t1 - capAt - 10),
    workerRate: capAt === null ? null : processedIn(capAt + 10, t1) / (t1 - capAt - 10),
    waitFirst: { p50: pct(first, 50), max: pct(first, 100) },
    waitCapped: { p50: pct(capped, 50), p95: pct(capped, 95), max: pct(capped, 100) },
    completed: rows.filter((r) => r.status === 'completed').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    queuedLeft: rows.filter((r) => r.status === 'queued').length,
    shedByReason, recoveryS: phases.drained === null ? null : phases.drained - t1,
    series, loadS: t1 - t0,
  });
}

// ---------- chart: backlog over time, both implementations, one axis ----------
function chart(rs: Result[]): string {
  const W = 760, H = 340, L = 56, R = 96, T = 40, B = 46;
  const xMax = Math.ceil(Math.max(...rs.flatMap((r) => r.series.map((p) => p.t))) / 30) * 30;
  const yMax = Math.ceil(Math.max(...rs.map((r) => r.maxBacklog), rs[0]!.limit) * 1.1 / 100) * 100;
  const x = (t: number) => L + (Math.max(0, t) / xMax) * (W - L - R);
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const ink = '#1d2a33', soft = '#5b6b76', grid = '#e3e7ea';
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12" role="img" aria-labelledby="t d">`,
    `<title id="t">Queue backlog during experiment 7</title>`,
    `<desc id="d">Messages waiting for the worker, per second, for ${rs.map((r) => NAME[r.impl as 'node']).join(' and ')}. ` +
      `Traffic of ${rs[0]!.phases.rate} orders a second runs for ${Math.round(rs[0]!.loadS)} s; the gateway refuses orders while the backlog is over ${rs[0]!.limit}.</desc>`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="${L}" y="20" fill="${ink}" font-size="14" font-weight="600">Messages waiting for the worker</text>`,
  ];
  for (let v = 0; v <= yMax; v += yMax / 4) {
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${grid}"/>`,
      `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="${soft}">${v}</text>`);
  }
  for (let t = 0; t <= xMax; t += 30) out.push(`<text x="${x(t)}" y="${H - B + 18}" text-anchor="middle" fill="${soft}">${t} s</text>`);
  out.push(`<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="${soft}"/>`);
  // traffic window and the guard limit
  const end = rs[0]!.loadS;
  out.push(`<line x1="${x(end)}" x2="${x(end)}" y1="${T}" y2="${H - B}" stroke="${soft}" stroke-dasharray="3 3"/>`,
    `<text x="${x(end) + 6}" y="${T + 10}" fill="${soft}">traffic stops</text>`,
    `<line x1="${L}" x2="${W - R}" y1="${y(rs[0]!.limit)}" y2="${y(rs[0]!.limit)}" stroke="${ink}" stroke-width="1" stroke-dasharray="6 4"/>`,
    `<text x="${W - R - 4}" y="${y(rs[0]!.limit) - 6}" text-anchor="end" fill="${ink}">guard limit ${rs[0]!.limit}: new orders refused above it</text>`);
  rs.forEach((r, i) => {
    const pts = r.series.filter((p) => p.t >= -2).map((p) => `${x(p.t).toFixed(1)},${y(p.backlog).toFixed(1)}`).join(' ');
    out.push(`<polyline points="${pts}" fill="none" stroke="${COLOR[r.impl as 'node']}" stroke-width="2" stroke-linejoin="round"/>`);
    // direct label at the peak, offset per series so the two never collide
    const last = r.series.filter((p) => p.t <= end).at(-1)!;
    out.push(`<text x="${x(last.t) - 8}" y="${y(last.backlog) + (i === 0 ? -10 : 18)}" text-anchor="end" fill="${ink}" font-weight="600">${NAME[r.impl as 'node']}</text>`);
  });
  // legend (>= 2 series), on the title row, right-aligned
  rs.forEach((r, i) => {
    const lx = W - R - 150 + i * 80, ly = 16;
    out.push(`<line x1="${lx}" x2="${lx + 18}" y1="${ly}" y2="${ly}" stroke="${COLOR[r.impl as 'node']}" stroke-width="2"/>`,
      `<text x="${lx + 24}" y="${ly + 4}" fill="${ink}">${NAME[r.impl as 'node']}</text>`);
  });
  out.push(`<text x="${L}" y="${H - 8}" fill="${soft}">Seconds since the traffic started. Sampled once a second from /api/lab/status.</text>`, '</svg>');
  return out.join('\n');
}

const md = ['# Experiment 7 — queue backlog and load shedding: results', '', `Source: \`${dir}\`. Generated by \`analyse.ts\`.`, '',
  'Accepted and worker rates come from Postgres (`created_at`, `processed_at`) for the orders of the measured window; ' +
  '"while capped" starts 10 s after the backlog first crossed the limit. Wait = `processed_at − created_at`. ' +
  'Shed by reason = `increase(lab_gateway_shed_total)` over the run (Prometheus extrapolates, so ≈; k6\'s 503 count is exact). Recovery = end of traffic until the backlog is 0.', '',
  '| Impl | Worker work | Offered | k6 status | Backlog over limit at | Peak backlog | Accepted before / while capped | Worker rate | Wait, first second (p50) | Wait while capped p50 / p95 / max | Shed by reason | Recovery | Peak load1 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
const s = (ms: number | null) => (ms === null ? '–' : `${fmt(ms / 1000, 1)} s`);
for (const r of results) {
  md.push(`| ${r.impl} | ${r.phases.workMs} ms | ${r.phases.rate}/s × ${r.phases.duration} (${r.requests}) | ${statusText(r.status)} | ` +
    `${r.capAtS === null ? 'never' : `${r.capAtS.toFixed(0)} s`} | ${r.maxBacklog} | ${fmt(r.acceptedBeforeCap)} / ${fmt(r.acceptedWhileCapped)} per s | ${fmt(r.workerRate)} per s | ` +
    `${s(r.waitFirst.p50)} | ${s(r.waitCapped.p50)} / ${s(r.waitCapped.p95)} / ${s(r.waitCapped.max)} | ` +
    `${Object.entries(r.shedByReason).map(([k, v]) => `${k} ≈${v}`).join(', ') || 'none'} | ${r.recoveryS === null ? 'not drained' : `${r.recoveryS.toFixed(0)} s`} | ${fmt(r.maxLoad1, 2)} |`);
}
md.push('', `Orders in the window: ${results.map((r) => `${r.impl} ${r.completed} completed, ${r.failed} failed, ${r.queuedLeft} still queued`).join('; ')}.`,
  '', '![Backlog over time](backlog.svg)');
if (results.length) await writeFile(join(dir, 'backlog.svg'), chart(results) + '\n');
await writeReport(dir, md, results.map(({ series, ...rest }) => rest));
