// k6 load profile for the order endpoint. Run through scripts/experiment.sh, which records the
// time window so the traces of the run can be analysed afterwards.
//
// Env:
//   BASE_URL   gateway URL (default http://host.docker.internal:8088, the dev gateway from a container)
//   IMPL       node | go
//   SCENARIO   none | slow-db | cache-miss
//   RATE       requests per second for the steady profile (default 4)
//   WARMUP     warm-up duration, excluded from the results (default 30s)
//   DURATION   measured duration (default 60s)
//   STAGES     optional step profile instead of RATE, e.g. "10:30s,20:30s,30:30s" (rate:duration);
//              every step is measured and reported separately
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:8088';
const IMPL = __ENV.IMPL || 'node';
const SCENARIO = __ENV.SCENARIO || 'none';
const RATE = Number(__ENV.RATE || 4);
const WARMUP = __ENV.WARMUP || '30s';
const DURATION = __ENV.DURATION || '60s';
const PRODUCTS = Array.from({ length: 10 }, (_, i) => `demo-${String(i + 1).padStart(3, '0')}`);

const seconds = (d) => {
  const m = /^(\d+)(s|m)$/.exec(d);
  if (!m) throw new Error(`unsupported duration ${d}`);
  return Number(m[1]) * (m[2] === 'm' ? 60 : 1);
};

// Each step is its own constant-arrival-rate scenario, started when the previous one ends.
const steps = __ENV.STAGES
  ? __ENV.STAGES.split(',').map((s) => {
      const [rate, duration] = s.split(':');
      return { rate: Number(rate), duration };
    })
  : [{ rate: RATE, duration: DURATION }];

const scenarios = {};
const thresholds = {};
let offset = 0;
const windows = {};
function addScenario(name, rate, duration, phase) {
  windows[name] = { fromS: offset, toS: offset + seconds(duration) };
  scenarios[name] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration,
    preAllocatedVUs: Math.max(10, rate * 2),
    maxVUs: Math.max(50, rate * 10),
    startTime: `${offset}s`,
    gracefulStop: '10s',
    tags: { phase, step: name },
  };
  offset += seconds(duration);
}
addScenario('warmup', steps[0].rate, WARMUP, 'warmup');
for (const s of steps) {
  const name = `rate${s.rate}`;
  addScenario(name, s.rate, s.duration, 'measure');
  // Thresholds that always pass make k6 report these sub-metrics in the summary.
  thresholds[`http_req_duration{step:${name}}`] = ['max>=0'];
  thresholds[`http_reqs{step:${name}}`] = ['count>=0'];
  for (const status of [202, 429, 502, 503, 504]) thresholds[`http_reqs{step:${name},status:${status}}`] = ['count>=0'];
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: true,
};

// The test's real start, so each step's time window can be matched to traces in Tempo.
export function setup() {
  return { startedAt: Date.now() };
}

export default function () {
  const productId = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
  const res = http.post(
    `${BASE}/api/${IMPL}/orders`,
    JSON.stringify({ productId, quantity: 1, scenario: SCENARIO }),
    { headers: { 'content-type': 'application/json' }, tags: { name: 'POST /api/:impl/orders' } },
  );
  check(res, { accepted: (r) => r.status === 202 });
}

// Compact per-step result: what experiment.sh stores and the write-up quotes.
export function handleSummary(data) {
  const m = data.metrics;
  const startedAt = data.setup_data?.startedAt ?? Date.now() - data.state.testRunDurationMs;
  const at = (s) => new Date(startedAt + s * 1000).toISOString();
  const result = { impl: IMPL, scenario: SCENARIO, startedAt: new Date(startedAt).toISOString(), steps: [] };
  for (const s of steps) {
    const name = `rate${s.rate}`;
    const d = m[`http_req_duration{step:${name}}`]?.values ?? {};
    const reqs = m[`http_reqs{step:${name}}`]?.values ?? {};
    const status = {};
    for (const code of [202, 429, 502, 503, 504]) status[code] = m[`http_reqs{step:${name},status:${code}}`]?.values.count ?? 0;
    const round = (x) => (x === undefined ? null : Math.round(x * 10) / 10);
    result.steps.push({
      step: name,
      targetRate: s.rate,
      duration: s.duration,
      from: at(windows[name].fromS),
      to: at(windows[name].toS),
      requests: reqs.count ?? 0,
      // reqs.rate is over the whole test; per step it is requests / step duration.
      throughput: round((reqs.count ?? 0) / seconds(s.duration)),
      accepted: status[202],
      status,
      errorRate: reqs.count ? round((1 - status[202] / reqs.count) * 100) : null,
      latencyMs: { avg: round(d.avg), p50: round(d.med), p90: round(d['p(90)']), p95: round(d['p(95)']), p99: round(d['p(99)']), max: round(d.max) },
    });
  }
  const lines = result.steps.map(
    (s) => `${IMPL}/${SCENARIO} ${s.step}: ${s.requests} req, ${s.accepted} accepted, p50 ${s.latencyMs.p50} ms, p95 ${s.latencyMs.p95} ms, p99 ${s.latencyMs.p99} ms, status ${JSON.stringify(s.status)}`,
  );
  return { '/out/summary.json': JSON.stringify(result, null, 2) + '\n', stdout: lines.join('\n') + '\n' };
}
