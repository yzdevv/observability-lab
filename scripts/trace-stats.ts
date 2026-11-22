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
import { analyseWindow, formatStats } from './lib/stats.ts';

const { values } = parseArgs({
  options: {
    impl: { type: 'string' },
    scenario: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    run: { type: 'string' },
    step: { type: 'string' },
    sample: { type: 'string' },
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

const stats = await analyseWindow({ impl, scenario, from, to, sample: values.sample ? Number(values.sample) : undefined });
console.log(values.json ? JSON.stringify(stats, null, 2) : formatStats(stats));
