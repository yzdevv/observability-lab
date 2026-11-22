import { availableParallelism } from 'node:os';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

// Known scenarios: only these become a span attribute (keeps metric labels bounded).
export const SCENARIOS = ['none', 'slow-db', 'cache-miss', 'worker-retry', 'dependency-timeout'] as const;

export const IMPLS = ['node', 'go'] as const;
export type Impl = (typeof IMPLS)[number];

export const config = {
  port: num('PORT', 8080),
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',
  upstreams: {
    node: process.env.ORDER_NODE_URL ?? 'http://order-api-node:8081',
    go: process.env.ORDER_GO_URL ?? 'http://order-api-go:8082',
  } satisfies Record<Impl, string>,
  upstreamTimeoutMs: num('UPSTREAM_TIMEOUT_MS', 5000),

  // Guards — see docs/RESOURCE-BUDGET.md
  rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 20),
  maxInflight: num('MAX_INFLIGHT', 20),
  // 1-minute host load average above which new work is refused. Default: half the host's threads.
  maxLoad1: num('MAX_LOAD1', availableParallelism() / 2),
  maxBacklog: num('MAX_BACKLOG', 500),
};

export const streamKey = (impl: Impl) => `lab:${impl}:orders`;
