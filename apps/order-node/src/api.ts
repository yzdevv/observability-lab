import Fastify from 'fastify';
import { trace } from '@opentelemetry/api';
import { routeSpanHook, shutdownTelemetry, traceLogFields, withSpan } from '@lab/telemetry';
import { IMPL, config } from './config.ts';
import { closeDeps, createDeps } from './deps.ts';
import { HttpError, createOrder, getOrder, parseCreateOrder, parseOrderId } from './orders.ts';
import { createPaymentClient } from './payment.ts';

const deps = createDeps();
const app = Fastify({
  logger: { base: { impl: IMPL, service: 'order-api-node' }, mixin: traceLogFields },
  bodyLimit: 4096,
});
deps.authorizePayment = createPaymentClient((msg, extra) => app.log.warn(extra, msg));

app.addHook('onRequest', routeSpanHook);

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) {
    return reply.code(err.status).send(err.reason ? { error: err.message, reason: err.reason } : { error: err.message });
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) {
    return reply.code(status).send({ error: (err as Error).message });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'internal error' });
});

app.post('/orders', async (req, reply) => {
  const input = await withSpan('order.validate', {}, () => parseCreateOrder(req.body));
  trace.getActiveSpan()?.setAttributes({ 'lab.impl': IMPL, 'lab.scenario': input.scenario });
  const result = await createOrder(deps, input);
  trace.getActiveSpan()?.setAttribute('order.id', result.orderId);
  return reply.code(202).send(result);
});

app.get<{ Params: { id: string } }>('/orders/:id', async (req) => {
  return getOrder(deps, parseOrderId(req.params.id));
});

// Docker probes this every 10 s: not logged, not traced.
app.get('/healthz', { logLevel: 'silent' }, async (_req, reply) => {
  try {
    await Promise.all([deps.db.query('SELECT 1'), deps.redis.ping()]);
    return { ok: true, impl: IMPL };
  } catch {
    return reply.code(503).send({ ok: false, impl: IMPL });
  }
});

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeDeps(deps);
  await shutdownTelemetry();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
