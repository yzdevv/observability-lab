// CPU cost per request of each service over a run's measured window, from the services' own cgroup
// counters (lab.cgroup.cpu.usage_time). Usage: node scripts/cpu-cost.ts <run-dir> [step]
import { loadSummary } from './lib/report.ts';
import { promQuery, toSec } from './lib/sources.ts';

const [runDir, stepName] = process.argv.slice(2);
if (!runDir) throw new Error('usage: node scripts/cpu-cost.ts <run-dir> [step]');
const summary = await loadSummary(runDir);
const step = stepName ? summary.steps.find((s) => s.step === stepName) : summary.steps[0];
if (!step) throw new Error(`no step ${stepName}`);
const from = toSec(step.from);
const to = toSec(step.to);
// increase() copes with counter resets (a restarted container); metrics arrive every 10 s.
const range = Math.round(to - from);
const used = Object.fromEntries((await promQuery(`sum by (service_name) (increase(lab_cgroup_cpu_usage_time_seconds_total[${range}s]))`, to))
  .map((s) => [s.metric.service_name!, Number(s.value[1])]));
console.log(`${summary.impl}/${step.scenario} ${step.step}: ${step.requests} requests in ${range} s`);
for (const svc of Object.keys(used).sort()) {
  const cpu = used[svc]!;
  console.log(`${svc.padEnd(16)} ${(cpu).toFixed(2).padStart(6)} CPU-s  ${((cpu / Math.max(step.requests, 1)) * 1000).toFixed(2).padStart(6)} ms CPU/request  ${(cpu / (to - from)).toFixed(2)} cores`);
}
