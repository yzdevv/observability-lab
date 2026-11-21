import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { IMPLS, config, type Impl } from './config.ts';
import { INFLIGHT_REFUSAL, Inflight, checkGuards, createBacklogReaders, hostLoad1, type GuardVerdict } from './guards.ts';

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
const backlog = createBacklogReaders(redis);
const inflight = new Inflight();

const app = Fastify({
  logger: { base: { service: 'gateway' } },
  bodyLimit: 4096,
});

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
    const shed = (verdict: Exclude<GuardVerdict, { ok: true }>) => {
      req.log.warn({ impl, reason: verdict.reason }, 'request shed by guard');
      return reply.code(503).header('retry-after', '5').send({ error: verdict.message, reason: verdict.reason });
    };

    if (!inflight.tryAcquire()) return shed(INFLIGHT_REFUSAL);
    try {
      const verdict = await checkGuards(impl, backlog);
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

app.get('/healthz', async () => ({ ok: true }));

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await redis.quit().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
