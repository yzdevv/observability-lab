import pg from 'pg';
import { Redis } from 'ioredis';
import { config } from './config.ts';

export type Deps = { db: pg.Pool; redis: Redis };

export function createDeps(): Deps {
  const db = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  db.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'idle db client error', err: err.message })));
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  return { db, redis };
}

export async function closeDeps({ db, redis }: Deps): Promise<void> {
  await Promise.allSettled([db.end(), redis.quit()]);
}
