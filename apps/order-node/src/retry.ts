// Delayed retries for the worker, identical in both implementations (see docs/API-CONTRACT.md).
// A failed message is acknowledged and parked in a sorted set scored by its due time; a short loop
// moves due entries back onto the stream. The retry keeps the original trace context, so every
// attempt is a sibling span under the request's order.enqueue span.
import { config, keys } from './config.ts';
import type { Deps } from './deps.ts';

export type QueueMessage = {
  orderId: string;
  scenario: string;
  attempt: number;
  traceparent: string;
  tracestate: string;
};

/** Backoff before the next attempt: base × 2^(attempt-1), i.e. 500 ms, 1 s, 2 s, … */
export const retryDelayMs = (failedAttempt: number) => config.retryBaseMs * 2 ** (failedAttempt - 1);

// Moves due retries from the sorted set to the stream in one atomic step (same text in Go).
export const PROMOTE_RETRIES_LUA = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 50)
for _, member in ipairs(due) do
  redis.call('ZREM', KEYS[1], member)
  local m = cjson.decode(member)
  redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*',
    'orderId', m.orderId, 'scenario', m.scenario, 'attempt', tostring(m.attempt),
    'traceparent', m.traceparent, 'tracestate', m.tracestate)
end
return #due`;

const RECORD_FAILED_ATTEMPT = `
UPDATE orders SET attempts = attempts + 1
WHERE id = $1 AND status = 'queued'`;

const FAIL_ORDER = `
UPDATE orders SET status = 'failed', attempts = attempts + 1, processed_at = now()
WHERE id = $1 AND status = 'queued'`;

export async function scheduleRetry({ db, redis }: Deps, msg: QueueMessage): Promise<number> {
  const delayMs = retryDelayMs(msg.attempt);
  await db.query(RECORD_FAILED_ATTEMPT, [msg.orderId]);
  const next: QueueMessage = { ...msg, attempt: msg.attempt + 1 };
  await redis.zadd(keys.retry, Date.now() + delayMs, JSON.stringify(next));
  return delayMs;
}

export async function failOrder({ db }: Deps, orderId: string): Promise<void> {
  await db.query(FAIL_ORDER, [orderId]);
}

export async function promoteDueRetries({ redis }: Deps): Promise<number> {
  return Number(await redis.eval(PROMOTE_RETRIES_LUA, 2, keys.retry, keys.stream, Date.now(), config.streamMaxLen));
}
