import Fastify from 'fastify';
import { IMPL, config } from './config.ts';
import { closeDeps, createDeps } from './deps.ts';
import { HttpError, createOrder, getOrder, parseCreateOrder, parseOrderId } from './orders.ts';

const deps = createDeps();
const app = Fastify({
  logger: { base: { impl: IMPL, service: 'order-api-node' } },
  bodyLimit: 4096,
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) {
    return reply.code(status).send({ error: (err as Error).message });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'internal error' });
});

app.post('/orders', async (req, reply) => {
  const input = parseCreateOrder(req.body);
  const result = await createOrder(deps, input);
  return reply.code(202).send(result);
});

app.get<{ Params: { id: string } }>('/orders/:id', async (req) => {
  return getOrder(deps, parseOrderId(req.params.id));
});

app.get('/healthz', async (_req, reply) => {
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
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
