import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { metrics, trace } from '@opentelemetry/api';
import { routeSpanHook, shutdownTelemetry, traceLogFields, withSpan } from '@lab/telemetry';
import { IMPLS, config, type Impl } from './config.ts';
import { INFLIGHT_REFUSAL, Inflight, checkGuards, createBacklogReaders, hostLoad1, type GuardVerdict } from './guards.ts';

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
const backlog = createBacklogReaders(redis);
const inflight = new Inflight();

// Guard state as metrics, for the dashboard and for alerting on the lab itself.
const meter = metrics.getMeter('observability-lab/gateway');
meter.createObservableGauge('lab.gateway.inflight', { description: 'Order requests being handled now' })
  .addCallback((r) => r.observe(inflight.count));
meter.createObservableGauge('lab.queue.backlog', { description: 'Pending + undelivered stream entries', unit: '{message}' })
  .addCallback(async (r) => {
    for (const impl of IMPLS) r.observe(await backlog[impl](), { 'lab.impl': impl });
  });
meter.createObservableGauge('lab.host.load1', { description: 'Host 1-minute load average, as the guard sees it' })
  .addCallback(async (r) => r.observe(await hostLoad1()));
meter.createObservableGauge('lab.gateway.guard.limit', { description: 'Configured guard limits' })
  .addCallback((r) => {
    r.observe(config.maxInflight, { 'lab.guard': 'inflight' });
    r.observe(config.maxLoad1, { 'lab.guard': 'host-load' });
    r.observe(config.maxBacklog, { 'lab.guard': 'backlog' });
  });
const shedCounter = meter.createCounter('lab.gateway.shed', { description: 'Requests refused by a guard', unit: '{request}' });

const app = Fastify({
  logger: { base: { service: 'gateway' }, mixin: traceLogFields },
  bodyLimit: 4096,
});

app.addHook('onRequest', routeSpanHook);

// Behind Cloudflare the real client is in CF-Connecting-IP; elsewhere use the socket address.
function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  return (Array.isArray(cf) ? cf[0] : cf) ?? req.ip;
}

await app.register(rateLimit, {
  global: false,
  keyGenerator: clientIp,
  // The plugin throws what this returns, so build a real Error for the error handler below.
  errorResponseBuilder: (_req, ctx) =>
    Object.assign(new Error(`Too many requests. Limit is ${ctx.max} per minute.`), {
      statusCode: 429,
      retryAfter: Math.ceil(ctx.ttl / 1000),
    }),
});

const implParam = {
  type: 'object',
  required: ['impl'],
  properties: { impl: { type: 'string', enum: [...IMPLS] } },
} as const;

app.setErrorHandler((err, req, reply) => {
  const { statusCode = 500, retryAfter } = err as { statusCode?: number; retryAfter?: number };
  if (statusCode >= 500) {
    req.log.error({ err }, 'unhandled error');
    return reply.code(statusCode).send({ error: 'internal error' });
  }
  const message = err instanceof Error ? err.message : 'request rejected';
  return reply.code(statusCode).send(retryAfter === undefined ? { error: message } : { error: message, retryAfter });
});

async function forward(reply: FastifyReply, impl: Impl, path: string, init: RequestInit = {}) {
  try {
    const res = await fetch(`${config.upstreams[impl]}${path}`, {
      ...init,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
    const body = await res.text();
    return reply
      .code(res.status)
      .header('content-type', res.headers.get('content-type') ?? 'application/json')
      .send(body);
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    reply.log.warn({ impl, path, err: (err as Error).message }, 'upstream failed');
    return reply
      .code(timedOut ? 504 : 502)
      .send({ error: timedOut ? `${impl} order service timed out` : `${impl} order service unavailable` });
  }
}

app.post<{ Params: { impl: Impl }; Body: Record<string, unknown> }>(
  '/api/:impl/orders',
  {
    schema: { params: implParam },
    config: { rateLimit: { max: config.rateLimitPerMin, timeWindow: '1 minute' } },
  },
  async (req, reply) => {
    const { impl } = req.params;
    trace.getActiveSpan()?.setAttribute('lab.impl', impl);
    const shed = (verdict: Exclude<GuardVerdict, { ok: true }>) => {
      trace.getActiveSpan()?.setAttribute('lab.shed_reason', verdict.reason);
      shedCounter.add(1, { 'lab.impl': impl, 'lab.shed_reason': verdict.reason });
      req.log.warn({ impl, reason: verdict.reason }, 'request shed by guard');
      return reply.code(503).header('retry-after', '5').send({ error: verdict.message, reason: verdict.reason });
    };

    if (!inflight.tryAcquire()) return shed(INFLIGHT_REFUSAL);
    try {
      const verdict = await withSpan('gateway.guards', {}, async (span) => {
        const result = await checkGuards(impl, backlog);
        span.setAttribute('lab.guard.passed', result.ok);
        return result;
      });
      if (!verdict.ok) return shed(verdict);

      // Forward only the fields in the contract; the order API validates them.
      const body = req.body ?? {};
      const payload = { productId: body.productId, quantity: body.quantity, scenario: body.scenario };
      return await forward(reply, impl, '/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } finally {
      inflight.release();
    }
  },
);

app.get<{ Params: { impl: Impl; id: string } }>(
  '/api/:impl/orders/:id',
  { schema: { params: { ...implParam, required: ['impl', 'id'], properties: { ...implParam.properties, id: { type: 'string', maxLength: 64 } } } } },
  async (req, reply) => forward(reply, req.params.impl, `/orders/${encodeURIComponent(req.params.id)}`),
);

app.get('/api/lab/status', async () => {
  const [load1, nodeBacklog, goBacklog] = await Promise.all([hostLoad1(), backlog.node(), backlog.go()]);
  return {
    load1,
    inflight: inflight.count,
    backlog: { node: nodeBacklog, go: goBacklog },
    limits: {
      maxLoad1: config.maxLoad1,
      maxInflight: config.maxInflight,
      maxBacklog: config.maxBacklog,
      rateLimitPerMin: config.rateLimitPerMin,
    },
  };
});

app.get('/api/health', async (_req, reply) => {
  const check = async (impl: Impl) => {
    try {
      const res = await fetch(`${config.upstreams[impl]}/healthz`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? 'ok' : 'down';
    } catch {
      return 'down';
    }
  };
  const [node, go] = await Promise.all([check('node'), check('go')]);
  const ok = node === 'ok' && go === 'ok';
  return reply.code(ok ? 200 : 503).send({ gateway: 'ok', node, go });
});

// Docker probes this every 10 s: not logged, not traced.
app.get('/healthz', { logLevel: 'silent' }, async () => ({ ok: true }));

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await redis.quit().catch(() => {});
  await shutdownTelemetry();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
