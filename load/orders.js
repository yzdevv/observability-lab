// k6 load profile for the order endpoint. Run through scripts/experiment.sh, which records the
// time window so the traces of the run can be analysed afterwards.
//
// Env:
//   BASE_URL   gateway URL (default http://host.docker.internal:8088, the dev gateway from a container)
//   TARGET     gateway (default): POST {BASE_URL}/api/{IMPL}/orders
//              api: POST {BASE_URL}/orders, straight to one order API (BASE_URL=http://order-api-go:8082),
//              for comparing the implementations without the gateway in the way
//   IMPL       node | go
//   SCENARIO   none | slow-db | cache-miss | worker-retry | dependency-timeout
//   RATE       requests per second for the steady profile (default 4)
//   WARMUP     warm-up duration, excluded from the results (default 30s; 0s for none)
//   DURATION   measured duration (default 60s)
//   STAGES     step profile instead of RATE, e.g. "10:30s,20:30s,30:30s" (rate:duration);
//              every step is measured and reported separately
//   MIX        concurrent scenarios instead of SCENARIO/RATE, e.g. "none:10,dependency-timeout:40"
//              (scenario:rate), all running for DURATION; each is reported separately
//   OUTAGE_CYCLE_S, OUTAGE_S  tag every request with window=outage|healthy, matching the fake
//              payment provider's schedule (outage = first OUTAGE_S seconds of each cycle)
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:8088';
const TARGET = __ENV.TARGET || 'gateway';
const IMPL = __ENV.IMPL || 'node';
const SCENARIO = __ENV.SCENARIO || 'none';
const RATE = Number(__ENV.RATE || 4);
const WARMUP = __ENV.WARMUP || '30s';
const DURATION = __ENV.DURATION || '60s';
const OUTAGE_CYCLE_S = Number(__ENV.OUTAGE_CYCLE_S || 0);
const OUTAGE_S = Number(__ENV.OUTAGE_S || 0);
const PRODUCTS = Array.from({ length: 10 }, (_, i) => `demo-${String(i + 1).padStart(3, '0')}`);
const STATUSES = [202, 400, 429, 500, 502, 503, 504];
const WINDOWS = OUTAGE_CYCLE_S ? ['outage', 'healthy'] : [];

const seconds = (d) => {
  const m = /^(\d+)(s|m)$/.exec(d);
  if (!m) throw new Error(`unsupported duration ${d}`);
  return Number(m[1]) * (m[2] === 'm' ? 60 : 1);
};

// A step = one constant-arrival-rate scenario. Sequential steps (STAGES) start one after another;
// MIX steps run at the same time.
let steps;
if (__ENV.MIX) {
  steps = __ENV.MIX.split(',').map((part) => {
    const [scenario, rate] = part.split(':');
    return { name: `mix-${scenario}`, scenario, rate: Number(rate), duration: DURATION, parallel: true };
  });
} else if (__ENV.STAGES) {
  steps = __ENV.STAGES.split(',').map((part) => {
    const [rate, duration] = part.split(':');
    return { name: `rate${rate}`, scenario: SCENARIO, rate: Number(rate), duration };
  });
} else {
  steps = [{ name: `rate${RATE}`, scenario: SCENARIO, rate: RATE, duration: DURATION }];
}

const scenarios = {};
const thresholds = {};
const windows = {};
let offset = 0;
function addScenario(name, scenario, rate, duration, phase, startS) {
  windows[name] = { fromS: startS, toS: startS + seconds(duration) };
  scenarios[name] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration,
    preAllocatedVUs: Math.max(10, rate * 2),
    maxVUs: Math.max(50, rate * 10),
    startTime: `${startS}s`,
    gracefulStop: '10s',
    tags: { phase, step: name },
    env: { LAB_SCENARIO: scenario },
  };
}

if (seconds(WARMUP) > 0) {
  for (const s of steps.filter((x, i) => x.parallel || i === 0)) {
    addScenario(`warmup-${s.name}`, s.scenario, s.rate, WARMUP, 'warmup', 0);
  }
  offset = seconds(WARMUP);
}
for (const s of steps) {
  addScenario(s.name, s.scenario, s.rate, s.duration, 'measure', offset);
  if (!s.parallel) offset += seconds(s.duration);
  // Thresholds that always pass make k6 report these sub-metrics in the summary.
  for (const w of ['', ...WINDOWS]) {
    const tag = w ? `step:${s.name},window:${w}` : `step:${s.name}`;
    thresholds[`http_req_duration{${tag}}`] = ['max>=0'];
    thresholds[`http_reqs{${tag}}`] = ['count>=0'];
    for (const status of STATUSES) thresholds[`http_reqs{${tag},status:${status}}`] = ['count>=0'];
  }
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

const url = TARGET === 'api' ? `${BASE}/orders` : `${BASE}/api/${IMPL}/orders`;

export default function () {
  const productId = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
  const tags = { name: TARGET === 'api' ? 'POST /orders' : 'POST /api/:impl/orders' };
  if (OUTAGE_CYCLE_S) tags.window = (Date.now() / 1000) % OUTAGE_CYCLE_S < OUTAGE_S ? 'outage' : 'healthy';
  const res = http.post(url, JSON.stringify({ productId, quantity: 1, scenario: __ENV.LAB_SCENARIO }), {
    headers: { 'content-type': 'application/json' },
    tags,
  });
  check(res, { accepted: (r) => r.status === 202 });
}

const round = (x) => (x === undefined || x === null ? null : Math.round(x * 10) / 10);

function stats(m, tag, durationS) {
  const d = m[`http_req_duration{${tag}}`]?.values ?? {};
  const count = m[`http_reqs{${tag}}`]?.values.count ?? 0;
  const status = {};
  for (const code of STATUSES) {
    const n = m[`http_reqs{${tag},status:${code}}`]?.values.count ?? 0;
    if (n || code === 202) status[code] = n;
  }
  return {
    requests: count,
    // http_reqs rate is over the whole test; per step it is requests / step duration.
    throughput: durationS ? round(count / durationS) : null,
    accepted: status[202],
    status,
    errorRate: count ? round((1 - status[202] / count) * 100) : null,
    latencyMs: { avg: round(d.avg), p50: round(d.med), p90: round(d['p(90)']), p95: round(d['p(95)']), p99: round(d['p(99)']), max: round(d.max) },
  };
}

// Compact per-step result: what experiment.sh stores and the write-ups quote.
export function handleSummary(data) {
  const m = data.metrics;
  const startedAt = data.setup_data?.startedAt ?? Date.now() - data.state.testRunDurationMs;
  const at = (s) => new Date(startedAt + s * 1000).toISOString();
  const result = { impl: IMPL, scenario: __ENV.MIX ? 'mix' : SCENARIO, target: TARGET, startedAt: new Date(startedAt).toISOString(), steps: [] };
  for (const s of steps) {
    const step = {
      step: s.name,
      scenario: s.scenario,
      targetRate: s.rate,
      duration: s.duration,
      from: at(windows[s.name].fromS),
      to: at(windows[s.name].toS),
      ...stats(m, `step:${s.name}`, seconds(s.duration)),
    };
    if (WINDOWS.length) {
      step.byWindow = Object.fromEntries(WINDOWS.map((w) => [w, stats(m, `step:${s.name},window:${w}`, 0)]));
    }
    result.steps.push(step);
  }
  const lines = result.steps.map(
    (s) => `${IMPL}/${s.scenario} ${s.step}: ${s.requests} req, ${s.accepted} accepted, p50 ${s.latencyMs.p50} ms, p95 ${s.latencyMs.p95} ms, p99 ${s.latencyMs.p99} ms, status ${JSON.stringify(s.status)}`,
  );
  return { '/out/summary.json': JSON.stringify(result, null, 2) + '\n', stdout: lines.join('\n') + '\n' };
}
