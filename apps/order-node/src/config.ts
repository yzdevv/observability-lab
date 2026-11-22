function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export const IMPL = 'node';

export const config = {
  port: int('PORT', 8081),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',
  dbPoolMax: int('DB_POOL_MAX', 10),
  slowDbMs: int('SLOW_DB_MS', 300),
  productCacheTtlS: int('PRODUCT_CACHE_TTL_S', 60),
  streamMaxLen: int('STREAM_MAXLEN', 10000),
  workMs: int('WORKER_WORK_MS', 20),
  workerBatch: int('WORKER_BATCH', 10),
  maxAttempts: int('WORKER_MAX_ATTEMPTS', 3),
  retryBaseMs: int('RETRY_BASE_MS', 500),          // backoff: 500 ms, 1 s, 2 s, …
  retryPromoteMs: int('RETRY_PROMOTE_MS', 250),    // how often due retries move back to the stream
  reclaimIdleMs: int('RECLAIM_IDLE_MS', 60_000),   // unacked this long = its worker died; take it over
  reclaimEveryMs: int('RECLAIM_EVERY_MS', 15_000),
  retentionHours: int('ORDER_RETENTION_HOURS', 6),     // older orders are deleted by the worker
  cleanupEveryMs: int('CLEANUP_EVERY_MS', 600_000),
  paymentUrl: process.env.PAYMENT_URL ?? 'http://fake-payment:8083',
  dependencyTimeoutMs: int('DEPENDENCY_TIMEOUT_MS', 500),
  breakerEnabled: process.env.BREAKER_ENABLED !== 'false',
  breakerFailures: int('BREAKER_FAILURES', 5),
  breakerOpenMs: int('BREAKER_OPEN_MS', 10_000),
};

export const keys = {
  stream: `lab:${IMPL}:orders`,
  product: (id: string) => `lab:${IMPL}:product:${id}`,
  retry: `lab:${IMPL}:retry`,
  group: 'workers',
};
