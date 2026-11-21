import { readFile } from 'node:fs/promises';
import type { Redis } from 'ioredis';
import { config, streamKey, type Impl } from './config.ts';

export type GuardReason = 'inflight' | 'host-load' | 'backlog';
export type GuardVerdict = { ok: true } | { ok: false; reason: GuardReason; message: string };

// Small time-based cache so guards stay cheap under bursts.
function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let expires = 0;
  let pending: Promise<T> | undefined;
  return async () => {
    if (value !== undefined && Date.now() < expires) return value;
    pending ??= load().then((v) => {
      value = v;
      expires = Date.now() + ttlMs;
      pending = undefined;
      return v;
    }, (err) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

// Inside a container, /proc/loadavg reports the whole host, so the lab backs off
// when production is busy too. Returns 0 where /proc is unavailable (e.g. running on macOS).
export const hostLoad1 = cached(2000, async () => {
  try {
    const text = await readFile('/proc/loadavg', 'utf8');
    return Number.parseFloat(text.split(' ')[0] ?? '0') || 0;
  } catch {
    return 0;
  }
});

// Pending (delivered, unacked) + lag (not yet delivered) for the worker group.
async function readBacklog(redis: Redis, impl: Impl): Promise<number> {
  try {
    const groups = (await redis.xinfo('GROUPS', streamKey(impl))) as unknown[][];
    for (const flat of groups) {
      const info: Record<string, unknown> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) info[String(flat[i])] = flat[i + 1];
      if (info.name !== 'workers') continue;
      return Number(info.pending ?? 0) + Number(info.lag ?? 0);
    }
    return 0;
  } catch {
    return 0; // stream not created yet
  }
}

export function createBacklogReaders(redis: Redis): Record<Impl, () => Promise<number>> {
  return {
    node: cached(1000, () => readBacklog(redis, 'node')),
    go: cached(1000, () => readBacklog(redis, 'go')),
  };
}

// The in-flight check is synchronous with the slot reservation, so bursts cannot slip past it.
export class Inflight {
  count = 0;
  tryAcquire(): boolean {
    if (this.count >= config.maxInflight) return false;
    this.count++;
    return true;
  }
  release(): void {
    this.count--;
  }
}

export const INFLIGHT_REFUSAL: Extract<GuardVerdict, { ok: false }> = {
  ok: false,
  reason: 'inflight',
  message: 'The lab is busy right now. Try again in a few seconds.',
};

export async function checkGuards(impl: Impl, backlog: Record<Impl, () => Promise<number>>): Promise<GuardVerdict> {
  if ((await hostLoad1()) > config.maxLoad1) {
    return {
      ok: false,
      reason: 'host-load',
      message: 'The server is busy, so the lab is pausing to protect the other services on it.',
    };
  }
  if ((await backlog[impl]()) > config.maxBacklog) {
    return { ok: false, reason: 'backlog', message: `The ${impl} worker queue is backed up. Try again shortly.` };
  }
  return { ok: true };
}
