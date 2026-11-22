import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { SpanKind, extractTraceContext, shutdownTelemetry, traceLogFields, withSpan } from '@lab/telemetry';
import { IMPL, config, keys } from './config.ts';
import { closeDeps, createDeps } from './deps.ts';
import { completeOrder } from './orders.ts';
import { failOrder, promoteDueRetries, scheduleRetry, type QueueMessage } from './retry.ts';

const deps = createDeps();
// XREADGROUP BLOCK holds its connection for up to 5 s; give it its own so retries and acks
// on the main connection are not queued behind it.
const reader = deps.redis.duplicate();
const consumer = `${hostname()}-${process.pid}`;
let running = true;

// Same logger as the API (pino): JSON on stdout, and over OTLP to Loki via the pino instrumentation.
const logger = pino({ base: { service: 'worker-node', impl: IMPL }, mixin: traceLogFields });

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  logger[level](extra, msg);
}

type Entry = [id: string, fields: string[]];
type StreamReply = [stream: string, entries: Entry[]][];

function toFields(flat: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
  return out;
}

class SimulatedFailure extends Error {}

async function ensureGroup() {
  try {
    await deps.redis.xgroup('CREATE', keys.stream, keys.group, '0', 'MKSTREAM');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
}

async function processEntry(entryId: string, fields: Record<string, string>) {
  const started = performance.now();
  const msg: QueueMessage = {
    orderId: fields.orderId ?? '',
    scenario: fields.scenario ?? 'none',
    attempt: Number(fields.attempt ?? 1) || 1,
    traceparent: fields.traceparent ?? '',
    tracestate: fields.tracestate ?? '',
  };
  // Continue the trace started by the HTTP request that enqueued this order.
  const parent = extractTraceContext({ traceparent: msg.traceparent, tracestate: msg.tracestate });
  try {
    await withSpan(
      'order.process',
      {
        kind: SpanKind.CONSUMER,
        parent,
        attributes: {
          'order.id': msg.orderId,
          'lab.impl': IMPL,
          'lab.scenario': msg.scenario,
          'lab.attempt': msg.attempt,
          'messaging.system': 'redis',
          'messaging.operation.type': 'process',
          'messaging.destination.name': keys.stream,
          'messaging.message.id': entryId,
        },
      },
      async (span) => {
        if (!msg.orderId) throw new Error('message without orderId');
        try {
          // Simulated work, identical in both implementations.
          await withSpan('order.fulfil', { attributes: { 'lab.simulated': true } }, async () => {
            await sleep(config.workMs);
            if (msg.scenario === 'worker-retry' && msg.attempt < 3) {
              throw new SimulatedFailure(`simulated fulfilment failure (attempt ${msg.attempt} of 3)`);
            }
          });
        } catch (err) {
          // Retry with backoff, or give up after the last attempt. Either way the message is done.
          if (msg.attempt < config.maxAttempts) {
            const delayMs = await scheduleRetry(deps, msg);
            span.setAttributes({ 'lab.retry.scheduled': true, 'lab.retry.delay_ms': delayMs });
            log('warn', 'order attempt failed, retry scheduled', {
              orderId: msg.orderId, attempt: msg.attempt, delayMs, err: (err as Error).message,
            });
          } else {
            await failOrder(deps, msg.orderId);
            span.setAttribute('lab.retry.exhausted', true);
            log('error', 'order failed after last attempt', { orderId: msg.orderId, attempt: msg.attempt, err: (err as Error).message });
          }
          await deps.redis.xack(keys.stream, keys.group, entryId);
          throw err; // marks order.process as failed in the trace
        }
        const updated = await completeOrder(deps, msg.orderId);
        span.setAttribute('order.updated', updated);
        await deps.redis.xack(keys.stream, keys.group, entryId);
        log('info', 'order processed', {
          orderId: msg.orderId, entryId, attempt: msg.attempt, updated, durationMs: Math.round(performance.now() - started),
        });
      },
    );
  } catch (err) {
    if (err instanceof SimulatedFailure) return; // already handled and logged above
    // Left unacked: reclaimed by another read after RECLAIM_IDLE_MS (XAUTOCLAIM).
    log('error', 'order processing failed', { orderId: msg.orderId, entryId, err: (err as Error).message });
  }
}

// Background loops: move due retries back onto the stream, and take over entries whose worker
// died before acknowledging them.
function every(ms: number, task: () => Promise<void>): NodeJS.Timeout {
  let busy = false;
  return setInterval(() => {
    if (busy || !running) return;
    busy = true;
    task().catch((err) => log('error', 'background task failed', { err: (err as Error).message })).finally(() => {
      busy = false;
    });
  }, ms);
}

async function reclaimStale() {
  const [, entries] = (await deps.redis.xautoclaim(
    keys.stream, keys.group, consumer, config.reclaimIdleMs, '0-0', 'COUNT', config.workerBatch,
  )) as [string, Entry[], string[]];
  const live = entries.filter((e): e is Entry => Array.isArray(e?.[1]));
  if (live.length) log('warn', 'reclaimed stale entries', { count: live.length });
  await Promise.all(live.map(([id, flat]) => processEntry(id, toFields(flat))));
}

async function run() {
  await ensureGroup();
  log('info', 'worker started', { consumer, stream: keys.stream });
  const timers = [
    every(config.retryPromoteMs, async () => { await promoteDueRetries(deps); }),
    every(config.reclaimEveryMs, reclaimStale),
  ];
  while (running) {
    try {
      const reply = (await reader.xreadgroup(
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
  timers.forEach(clearInterval);
  reader.disconnect();
  await closeDeps(deps);
  log('info', 'worker stopped');
  await shutdownTelemetry();
}

function stop() {
  running = false;
  // Unblock a pending XREADGROUP so shutdown does not wait up to 5 s.
  reader.disconnect();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

await run();
