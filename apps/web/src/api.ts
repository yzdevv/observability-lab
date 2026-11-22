// Talking to the lab: the gateway's public endpoints, plus the recorded runs used when it is offline.

export type Impl = 'node' | 'go';
export type Scenario = 'none' | 'slow-db' | 'cache-miss' | 'worker-retry' | 'dependency-timeout';

export type Span = {
  spanId: string;
  parentSpanId: string;
  service: string;
  name: string;
  kind: string;
  startMs: number;
  durationMs: number;
  error: boolean;
  attributes: Record<string, string | number | boolean>;
};

export type Order = {
  orderId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  createdAt: string;
  processedAt: string | null;
};

/** One order sent through the lab, as the page shows it. */
export type Run = {
  impl: Impl;
  scenario: Scenario;
  /** HTTP status the gateway answered with. */
  status: number;
  /** Response time seen by the browser (live) or by the recorder (recorded), ms. */
  responseMs: number;
  body: { orderId?: string; error?: string; reason?: string; retryAfter?: number };
  order?: Order;
  traceId?: string;
  spans?: Span[];
  /** Set when the trace could not be loaded; the run is still shown. */
  traceError?: string;
  /** ISO time, only for recorded runs. */
  recordedAt?: string;
};

export type LabStatus = {
  load1: number;
  inflight: number;
  backlog: Record<Impl, number>;
  limits: { maxLoad1: number; maxInflight: number; maxBacklog: number; rateLimitPerMin: number };
};

export type ImplStats = { rps: number | null; errorPct: number | null; p50Ms: number | null; p95Ms: number | null };
export type LabStats = { window: string; at: string; impls: Record<Impl, ImplStats> };

export type Recorded = { recordedAt: string; where: string; runs: Record<string, Run> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(path: string, timeoutMs = 6000): Promise<T> {
  const res = await fetch(path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error(`${path} answered ${res.status}`), { status: res.status });
  return (await res.json()) as T;
}

export const getStatus = () => getJson<LabStatus>('/api/lab/status', 4000);
export const getStats = () => getJson<LabStats>('/api/lab/stats');

/** True when the gateway and both implementations answer. */
export async function isLive(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

let recorded: Promise<Recorded> | undefined;
export function getRecorded(): Promise<Recorded> {
  recorded ??= getJson<Recorded>('/recorded/runs.json', 10_000).catch((err) => {
    recorded = undefined;
    throw err;
  });
  return recorded;
}

const PRODUCTS = Array.from({ length: 10 }, (_, i) => `demo-${String(i + 1).padStart(3, '0')}`);
const DONE = new Set(['completed', 'failed']);

/**
 * Send one order and collect everything the page shows: the response, the order's final state and
 * its trace. `onUpdate` is called as each part arrives, so the page can show progress.
 */
export async function sendOrder(impl: Impl, scenario: Scenario, onUpdate: (run: Run) => void): Promise<Run> {
  const sentAt = Date.now();
  const t0 = performance.now();
  let run: Run;
  try {
    const res = await fetch(`/api/${impl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)],
        quantity: 1 + Math.floor(Math.random() * 3),
        scenario,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const responseMs = performance.now() - t0;
    const body = (await res.json().catch(() => ({}))) as Run['body'];
    run = { impl, scenario, status: res.status, responseMs, body, traceId: res.headers.get('x-trace-id') ?? undefined };
  } catch {
    run = { impl, scenario, status: 0, responseMs: performance.now() - t0, body: { error: 'The lab did not answer.' } };
    onUpdate(run);
    return run;
  }
  onUpdate(run);

  // Accepted: wait for the worker, so the trace includes the processing part.
  if (run.status === 202 && run.body.orderId) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const order = await getJson<Order>(`/api/${impl}/orders/${run.body.orderId}`);
        run = { ...run, order };
        onUpdate(run);
        if (DONE.has(order.status)) break;
      } catch {
        // A missed poll is fine; try again.
      }
    }
  }

  // Refused before reaching the order API (rate limit, guards): nothing interesting to show.
  if (!run.traceId || run.status === 429 || run.body.reason === 'inflight' || run.body.reason === 'host-load' || run.body.reason === 'backlog') {
    return run;
  }
  run = await loadTrace(run, sentAt);
  onUpdate(run);
  return run;
}

// Spans reach Tempo a few seconds after they end (SDK batch, collector, ingester), so ask until
// the trace has every part we expect.
async function loadTrace(run: Run, sentAt: number): Promise<Run> {
  const attempts = run.order?.attempts ?? 0;
  const complete = (spans: Span[]) => {
    const hasRoot = spans.some((s) => s.parentSpanId === '' && s.service === 'gateway');
    const hasApi = spans.some((s) => s.service.startsWith('order-api') && s.kind === 'server');
    const processed = spans.filter((s) => s.name === 'order.process').length;
    return hasRoot && hasApi && processed >= attempts;
  };
  let spans: Span[] = [];
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await sleep(spans.length ? 1500 : 2500);
    try {
      const t = await getJson<{ spans: Span[] }>(`/api/traces/${run.traceId}?at=${sentAt}`, 10_000);
      spans = t.spans;
      if (complete(spans)) return { ...run, spans };
    } catch (err) {
      if ((err as { status?: number }).status === 429) break;
    }
  }
  return spans.length ? { ...run, spans } : { ...run, traceError: 'The trace did not arrive in time.' };
}

/** A recorded run, replayed with a short delay so it reads like a request. */
export async function replay(impl: Impl, scenario: Scenario): Promise<Run> {
  const data = await getRecorded();
  const run = data.runs[`${impl}:${scenario}`];
  if (!run) throw new Error(`No recorded run for ${impl} / ${scenario}`);
  await sleep(Math.min(run.responseMs, 1200) + 300);
  return { ...run, recordedAt: data.recordedAt };
}
