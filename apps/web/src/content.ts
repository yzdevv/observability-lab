import type { Impl, Scenario } from './api.ts';

export const REPO_URL = 'https://github.com/yzdevv/observability-lab';
export const AUTHOR_URL = 'https://dev.mge.my.id';

export const IMPL_LABEL: Record<Impl, string> = { node: 'Node.js', go: 'Go' };

export const SCENARIOS: { id: Scenario; label: string; what: string; look: string }[] = [
  {
    id: 'none',
    label: 'Normal',
    what: 'The everyday path: product from the Redis cache, one insert, one hop through the queue.',
    look: 'Most of the time goes to saving the order in Postgres. The worker picks the order up a few milliseconds after the response.',
  },
  {
    id: 'slow-db',
    label: 'Slow database',
    what: 'Saving the order takes 300 ms longer, like a table under lock contention.',
    look: 'One bar takes up the whole request: the INSERT. That is how a slow query shows up in a trace.',
  },
  {
    id: 'cache-miss',
    label: 'Cache miss',
    what: 'The product is read from Postgres instead of the Redis cache.',
    look: 'An extra SELECT appears under the product lookup. At this traffic level it costs about a millisecond.',
  },
  {
    id: 'worker-retry',
    label: 'Worker retry',
    what: 'The worker fails twice and succeeds on the third try, waiting 0.5 s and then 1 s in between.',
    look: 'The response is as fast as normal. Three attempts appear after it, the first two marked as errors.',
  },
  {
    id: 'dependency-timeout',
    label: 'Payment outage',
    what: 'The payment provider stops answering for the first 30 s of every minute. Calls give up after 500 ms. After 5 failures in a row, a circuit breaker refuses calls straight away for 10 s.',
    look: 'During an outage you get a 504 after half a second, or a fast 503 once the breaker is open. Outside it, the order goes through.',
  },
];

/** Headline results of the load tests (docs/EXPERIMENTS.md, MacBook, 22 Nov 2026). */
export const FINDINGS: { title: string; body: string }[] = [
  {
    title: 'A slow query is easy to find, and it caps throughput',
    body: 'With the slow-database scenario, the INSERT was 98% of the response time in every trace. Under load, each API topped out at about 33 orders per second, the limit of its 10-connection pool.',
  },
  {
    title: 'A circuit breaker protects the healthy requests',
    body: 'During payment outages, 99% of normal orders still got through with the breaker, against 68% without it. Without it, slow payment calls held all 20 gateway slots and normal orders were turned away.',
  },
  {
    title: 'Go did twice the work on the same half CPU',
    body: 'Go kept response times flat up to about 100–130 orders per second, Node.js up to about 60. Go used 2.9 ms of CPU per order against 6 ms, started in 0.23 s against 5.5 s, and ships as a 30 MB image against 207 MB.',
  },
  {
    title: 'Telemetry has a cost, and a tight limit hides it',
    body: 'With the gateway capped at half a CPU, it was throttled about half the time and response times doubled. Per-request access logs cost about 10% of app CPU, so they are off; traces already record every request.',
  },
];
