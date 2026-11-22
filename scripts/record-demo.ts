// Record one order per implementation and scenario through the gateway, with its trace, for the
// public page's offline mode (apps/web/public/recorded/runs.json).
//
// Usage: node scripts/record-demo.ts [--where "MacBook, Docker Desktop"]
// Env:   GATEWAY_URL (default http://127.0.0.1:8088)
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8088';
const OUT = new URL('../apps/web/public/recorded/runs.json', import.meta.url);
const whereArg = process.argv.indexOf('--where');
const where = whereArg > 0 ? process.argv[whereArg + 1] : 'MacBook, Docker Desktop';

const IMPLS = ['node', 'go'] as const;
const SCENARIOS = ['none', 'slow-db', 'cache-miss', 'worker-retry', 'dependency-timeout'] as const;
type Span = { name: string; service: string; kind: string; parentSpanId: string };

async function json<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${GATEWAY}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

// The fake payment provider is down for the first 30 s of every minute (Unix time). Record the
// timeout case early in that window, before anything could have opened the breaker.
async function waitForOutage() {
  for (;;) {
    const s = (Date.now() / 1000) % 60;
    if (s >= 2 && s < 20) return;
    await sleep(500);
  }
}

async function record(impl: string, scenario: string) {
  if (scenario === 'dependency-timeout') await waitForOutage();
  const sentAt = Date.now();
  const t0 = performance.now();
  const res = await fetch(`${GATEWAY}/api/${impl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'demo-003', quantity: 2, scenario }),
  });
  const responseMs = performance.now() - t0;
  const body = (await res.json()) as { orderId?: string };
  const traceId = res.headers.get('x-trace-id') ?? undefined;
  let order: { status: string; attempts: number } | undefined;
  if (res.status === 202 && body.orderId) {
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      order = (await json<{ status: string; attempts: number }>(`/api/${impl}/orders/${body.orderId}`)).body;
      if (order.status === 'completed' || order.status === 'failed') break;
    }
  }
  let spans: Span[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const t = await json<{ spans: Span[] }>(`/api/traces/${traceId}?at=${sentAt}`);
    if (t.status !== 200) continue;
    spans = t.body.spans;
    const processed = spans.filter((s) => s.name === 'order.process').length;
    const api = spans.some((s) => s.service.startsWith('order-api') && s.kind === 'server');
    // Wait one more round after it looks complete, in case late spans are still arriving.
    if (api && processed >= (order?.attempts ?? 0) && i > 2) break;
  }
  console.log(`${impl}/${scenario}: ${res.status} in ${responseMs.toFixed(1)} ms, ${spans.length} spans${order ? `, ${order.status} after ${order.attempts} attempt(s)` : ''}`);
  return { impl, scenario, status: res.status, responseMs: Math.round(responseMs * 10) / 10, body, order, traceId, spans };
}

// Warm up first: a freshly started Node process compiles on its first requests, and the first
// connections to Postgres, Redis and the payment provider are opened lazily.
for (let i = 0; i < 40; i++) {
  await Promise.all(IMPLS.map((impl) => fetch(`${GATEWAY}/api/${impl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: `demo-00${(i % 9) + 1}`, quantity: 1, scenario: i % 4 === 0 ? 'cache-miss' : 'none' }),
  }).then((r) => r.body?.cancel())));
  await sleep(100);
}
await sleep(3000);

const runs: Record<string, unknown> = {};
for (const scenario of SCENARIOS) {
  for (const impl of IMPLS) runs[`${impl}:${scenario}`] = await record(impl, scenario);
}
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ recordedAt: new Date().toISOString(), where, runs }) + '\n');
console.log(`wrote ${OUT.pathname}`);
