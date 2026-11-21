import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { IMPL, config, keys } from './config.ts';
import { closeDeps, createDeps } from './deps.ts';
import { completeOrder } from './orders.ts';

const deps = createDeps();
const consumer = `${hostname()}-${process.pid}`;
let running = true;

function log(level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, time: Date.now(), service: 'worker-node', impl: IMPL, msg, ...extra }));
}

type StreamReply = [stream: string, entries: [id: string, fields: string[]][]][];

function toFields(flat: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
  return out;
}

async function ensureGroup() {
  try {
    await deps.redis.xgroup('CREATE', keys.stream, keys.group, '0', 'MKSTREAM');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
}

async function processEntry(entryId: string, fields: Record<string, string>) {
  const started = performance.now();
  const orderId = fields.orderId;
  try {
    if (!orderId) throw new Error('message without orderId');
    await sleep(config.workMs); // simulated work, identical in both implementations
    const updated = await completeOrder(deps, orderId);
    await deps.redis.xack(keys.stream, keys.group, entryId);
    log('info', 'order processed', {
      orderId, entryId, updated, durationMs: Math.round(performance.now() - started),
    });
  } catch (err) {
    // Left unacked: stays in the pending list (reclaimed in Milestone D).
    log('error', 'order processing failed', { orderId, entryId, err: (err as Error).message });
  }
}

async function run() {
  await ensureGroup();
  log('info', 'worker started', { consumer, stream: keys.stream });
  while (running) {
    try {
      const reply = (await deps.redis.xreadgroup(
        'GROUP', keys.group, consumer,
        'COUNT', config.workerBatch,
        'BLOCK', 5000,
        'STREAMS', keys.stream, '>',
      )) as StreamReply | null;
      if (!reply) continue;
      const entries = reply.flatMap(([, list]) => list);
      await Promise.all(entries.map(([id, flat]) => processEntry(id, toFields(flat))));
    } catch (err) {
      if (!running) break;
      const message = (err as Error).message;
      log('error', 'read failed', { err: message });
      // Redis keeps no data on disk: after a restart the group is gone, so recreate it.
      if (message.includes('NOGROUP')) {
        await ensureGroup().catch(() => {});
        continue;
      }
      await sleep(1000);
    }
  }
  await closeDeps(deps);
  log('info', 'worker stopped');
}

function stop() {
  running = false;
  // Unblock a pending XREADGROUP so shutdown does not wait up to 5 s.
  deps.redis.disconnect();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

await run();
