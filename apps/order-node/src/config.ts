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
};

export const keys = {
  stream: `lab:${IMPL}:orders`,
  product: (id: string) => `lab:${IMPL}:product:${id}`,
  group: 'workers',
};
