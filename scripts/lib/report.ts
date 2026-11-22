// Helpers shared by experiments/*/analyse.ts.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findTraceIds, getTrace } from './tempo.ts';
import { renderWaterfall } from './waterfall.ts';

export type Latency = { avg: number; p50: number; p90: number; p95: number; p99: number; max: number };
export type StepStats = {
  requests: number;
  throughput: number | null;
  accepted: number;
  status: Record<string, number>;
  errorRate: number | null;
  latencyMs: Latency;
};
export type Step = StepStats & {
  step: string;
  scenario: string;
  targetRate: number;
  duration: string;
  from: string;
  to: string;
  byWindow?: Record<string, StepStats>;
};
export type Summary = { impl: string; scenario: string; target?: string; startedAt: string; steps: Step[] };
export type DockerPeak = { cpu: number; memMiB: number };

export const readJson = async <T>(p: string) => JSON.parse(await readFile(p, 'utf8')) as T;
export const loadSummary = (runDir: string) => readJson<Summary>(join(runDir, 'summary.json'));
export const exists = existsSync;

/** Peak CPU % and memory per container from the run's docker-stats.jsonl (10 s samples). */
export async function dockerPeaks(runDir: string): Promise<Record<string, DockerPeak>> {
  const file = join(runDir, 'docker-stats.jsonl');
  if (!existsSync(file)) return {};
  const peaks: Record<string, DockerPeak> = {};
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const s = JSON.parse(line) as { name: string; cpu: string; mem: string };
    if (!s.name.startsWith('observability-lab-')) continue;
    const name = s.name.replace(/^observability-lab-/, '').replace(/-1$/, '');
    const [used = '0'] = s.mem.split(' / ');
    const memMiB = Number.parseFloat(used) * (used.endsWith('GiB') ? 1024 : used.endsWith('KiB') ? 1 / 1024 : 1);
    const p = (peaks[name] ??= { cpu: 0, memMiB: 0 });
    p.cpu = Math.max(p.cpu, Number.parseFloat(s.cpu));
    p.memMiB = Math.max(p.memMiB, memMiB);
  }
  return peaks;
}

/**
 * Save a trace as JSON (Tempo keeps traces for 48 h; the copies feed the write-up and the offline
 * demo) and return its text waterfall.
 */
export async function saveTrace(dir: string, label: string, traceId: string | undefined, around: { from: string; to: string }) {
  if (!traceId) return undefined;
  const window = { startSec: Date.parse(around.from) / 1000 - 60, endSec: Date.parse(around.to) / 1000 + 120 };
  const spans = await getTrace(traceId, window);
  if (!spans?.length) return undefined;
  await mkdir(join(dir, 'traces'), { recursive: true });
  await writeFile(join(dir, 'traces', `${label}.json`), JSON.stringify({ traceId, spans }, null, 1) + '\n');
  return renderWaterfall(spans, { title: `${label} (trace ${traceId})`, width: 40 });
}

/** First trace in a window matching a TraceQL filter. */
export async function findTrace(filter: string, around: { from: string; to: string }): Promise<string | undefined> {
  const [id] = await findTraceIds(filter, Date.parse(around.from) / 1000, Date.parse(around.to) / 1000, 1);
  return id;
}

export async function writeReport(dir: string, md: string[], data: unknown) {
  await writeFile(join(dir, 'report.md'), md.join('\n') + '\n');
  await writeFile(join(dir, 'report.json'), JSON.stringify(data, null, 1) + '\n');
  console.log(md.join('\n'));
}

export const statusText = (s: Record<string, number>) =>
  Object.entries(s).filter(([, n]) => n > 0).map(([code, n]) => `${code}×${n}`).join(' ') || '–';
