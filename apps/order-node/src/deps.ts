import pg from 'pg';
import { Redis } from 'ioredis';
import { config } from './config.ts';

export type Deps = {
  db: pg.Pool;
  redis: Redis;
  /** Set by the API (payment.ts); the worker never calls it. */
  authorizePayment: (scenario: string) => Promise<void>;
};

export function createDeps(): Deps {
  const db = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  db.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'idle db client error', err: err.message })));
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  const authorizePayment = async () => {
    throw new Error('payment client not configured');
  };
  return { db, redis, authorizePayment };
}

export async function closeDeps({ db, redis }: Deps): Promise<void> {
  await Promise.allSettled([db.end(), redis.quit()]);
}
