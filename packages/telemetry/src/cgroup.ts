// The container's own CPU and memory accounting, read from cgroup v2 files. Gives every service
// "am I being throttled?" and "how close am I to my memory limit?" without cAdvisor or access to
// the Docker socket. The Go services export the same metric names.
import { readFileSync } from 'node:fs';
import { metrics } from '@opentelemetry/api';

const CGROUP = process.env.LAB_CGROUP_DIR ?? '/sys/fs/cgroup';

function read(file: string): string | undefined {
  try {
    return readFileSync(`${CGROUP}/${file}`, 'utf8');
  } catch {
    return undefined;
  }
}

export function cpuStat(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of (read('cpu.stat') ?? '').split('\n')) {
    const [key, value] = line.split(' ');
    if (key && value) out[key] = Number(value);
  }
  return out;
}

/** CPU limit in cores from cpu.max ("50000 100000" = 0.5), undefined when unlimited. */
function cpuLimit(): number | undefined {
  const [quota, period] = (read('cpu.max') ?? '').trim().split(' ');
  if (!quota || quota === 'max' || !period) return undefined;
  return Number(quota) / Number(period);
}

function bytes(file: string): number | undefined {
  const raw = read(file)?.trim();
  return raw && raw !== 'max' ? Number(raw) : undefined;
}

export function registerCgroupMetrics(): void {
  if (read('cpu.stat') === undefined) return; // not on cgroup v2 (e.g. running on the Mac directly)
  const meter = metrics.getMeter('observability-lab/cgroup');

  const periods = meter.createObservableCounter('lab.cgroup.cpu.periods', {
    description: 'CFS scheduling periods elapsed (100 ms each) while the container had runnable work',
  });
  const throttled = meter.createObservableCounter('lab.cgroup.cpu.throttled_periods', {
    description: 'Periods in which the container used up its CPU quota and was paused',
  });
  const throttledTime = meter.createObservableCounter('lab.cgroup.cpu.throttled_time', {
    description: 'Total time the container was paused by its CPU quota',
    unit: 's',
  });
  const usage = meter.createObservableCounter('lab.cgroup.cpu.usage_time', { description: 'CPU time used', unit: 's' });
  const limit = meter.createObservableGauge('lab.cgroup.cpu.limit', { description: 'CPU limit in cores', unit: '{cpu}' });
  const mem = meter.createObservableGauge('lab.cgroup.memory.usage', { description: 'Memory in use', unit: 'By' });
  const memMax = meter.createObservableGauge('lab.cgroup.memory.limit', { description: 'Memory limit', unit: 'By' });

  meter.addBatchObservableCallback(
    (result) => {
      const s = cpuStat();
      if (s.nr_periods !== undefined) result.observe(periods, s.nr_periods);
      if (s.nr_throttled !== undefined) result.observe(throttled, s.nr_throttled);
      if (s.throttled_usec !== undefined) result.observe(throttledTime, s.throttled_usec / 1e6);
      if (s.usage_usec !== undefined) result.observe(usage, s.usage_usec / 1e6);
      const cores = cpuLimit();
      if (cores !== undefined) result.observe(limit, cores);
      const current = bytes('memory.current');
      if (current !== undefined) result.observe(mem, current);
      const max = bytes('memory.max');
      if (max !== undefined) result.observe(memMax, max);
    },
    [periods, throttled, throttledTime, usage, limit, mem, memMax],
  );
}
