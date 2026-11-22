// Print one trace as a text waterfall, for docs and terminals.
// Usage: node scripts/waterfall.ts <traceId> [--width 48] [--request-only]
import { parseArgs } from 'node:util';
import { getTrace } from './lib/tempo.ts';
import { renderWaterfall } from './lib/waterfall.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { width: { type: 'string', default: '48' }, 'request-only': { type: 'boolean', default: false } },
});
const traceId = positionals[0];
if (!traceId) {
  console.error('usage: node scripts/waterfall.ts <traceId> [--width 48] [--request-only]');
  process.exit(2);
}

const spans = await getTrace(traceId);
if (!spans?.length) {
  console.error(`trace ${traceId} not found in Tempo`);
  process.exit(1);
}
console.log(renderWaterfall(spans, { width: Number(values.width), requestOnly: values['request-only'], title: `trace ${traceId}` }));
