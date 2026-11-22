import { randomUUID } from 'node:crypto';
import { SpanKind, injectTraceContext, withSpan } from '@lab/telemetry';
import { IMPL, config, keys } from './config.ts';
import type { Deps } from './deps.ts';

// worker-retry is handled by the worker; the others by the order API.
export const SCENARIOS = ['none', 'slow-db', 'cache-miss', 'worker-retry'] as const;
export type Scenario = (typeof SCENARIOS)[number];

const PRODUCT_ID = /^demo-\d{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type CreateOrderInput = { productId: string; quantity: number; scenario: Scenario };
type Product = { id: string; name: string; priceCents: number };

export function parseCreateOrder(body: unknown): CreateOrderInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  const { productId, quantity, scenario = 'none' } = body as Record<string, unknown>;
  if (typeof productId !== 'string' || !PRODUCT_ID.test(productId)) {
    throw new HttpError(400, 'productId must look like demo-001');
  }
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new HttpError(400, 'quantity must be an integer from 1 to 10');
  }
  if (typeof scenario !== 'string' || !(SCENARIOS as readonly string[]).includes(scenario)) {
    throw new HttpError(400, `scenario must be one of: ${SCENARIOS.join(', ')}`);
  }
  return { productId, quantity, scenario: scenario as Scenario };
}

export function parseOrderId(id: string): string {
  if (!UUID.test(id)) throw new HttpError(400, 'order id must be a UUID');
  return id;
}

async function getProduct({ db, redis }: Deps, id: string, scenario: Scenario): Promise<Product> {
  return withSpan('product.lookup', { attributes: { 'product.id': id } }, async (span) => {
    const key = keys.product(id);
    if (scenario !== 'cache-miss') {
      const cached = await redis.get(key);
      if (cached) {
        span.setAttribute('cache.hit', true);
        return JSON.parse(cached) as Product;
      }
    }
    span.setAttributes({ 'cache.hit': false, 'cache.skipped': scenario === 'cache-miss' });
    const { rows } = await db.query<{ id: string; name: string; price_cents: number }>(
      'SELECT id, name, price_cents FROM products WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, `unknown product ${id}`);
    const product: Product = { id: row.id, name: row.name, priceCents: row.price_cents };
    await redis.set(key, JSON.stringify(product), 'EX', config.productCacheTtlS);
    return product;
  });
}

// The delay for slow-db is part of the INSERT itself, so the slow span is the real query.
const INSERT_ORDER = `
INSERT INTO orders (id, product_id, quantity, unit_price_cents, impl, scenario, status)
SELECT $1::uuid, $2::text, $3::int, $4::int, $5::text, $6::text, 'queued'
FROM pg_sleep($7::float8)`;

export async function createOrder(deps: Deps, input: CreateOrderInput) {
  const product = await getProduct(deps, input.productId, input.scenario);
  const orderId = randomUUID();
  const delayS = input.scenario === 'slow-db' ? config.slowDbMs / 1000 : 0;

  await withSpan('order.persist', { attributes: { 'order.id': orderId } }, () =>
    deps.db.query(INSERT_ORDER, [
      orderId, product.id, input.quantity, product.priceCents, IMPL, input.scenario, delayS,
    ]),
  );

  // Not atomic with the insert: if this fails the order stays queued (see ARCHITECTURE.md).
  await withSpan(
    'order.enqueue',
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        'order.id': orderId,
        'messaging.system': 'redis',
        'messaging.operation.type': 'send',
        'messaging.destination.name': keys.stream,
      },
    },
    async (span) => {
      // The worker continues this trace from the traceparent carried in the message.
      const { traceparent = '', tracestate = '' } = injectTraceContext();
      const entryId = await deps.redis.xadd(
        keys.stream, 'MAXLEN', '~', String(config.streamMaxLen), '*',
        'orderId', orderId,
        'scenario', input.scenario,
        'attempt', '1',
        'traceparent', traceparent,
        'tracestate', tracestate,
      );
      if (entryId) span.setAttribute('messaging.message.id', entryId);
    },
  );

  return { orderId, impl: IMPL, status: 'queued' as const };
}

type OrderRow = {
  id: string;
  impl: string;
  product_id: string;
  quantity: number;
  scenario: string;
  status: string;
  attempts: number;
  total_cents: number | null;
  created_at: Date;
  processed_at: Date | null;
};

export async function getOrder({ db }: Deps, id: string) {
  const { rows } = await db.query<OrderRow>(
    `SELECT id, impl, product_id, quantity, scenario, status, attempts, total_cents, created_at, processed_at
     FROM orders WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'order not found');
  return {
    orderId: row.id,
    impl: row.impl,
    productId: row.product_id,
    quantity: row.quantity,
    scenario: row.scenario,
    status: row.status,
    attempts: row.attempts,
    totalCents: row.total_cents,
    createdAt: row.created_at.toISOString(),
    processedAt: row.processed_at ? row.processed_at.toISOString() : null,
  };
}

const COMPLETE_ORDER = `
UPDATE orders
SET status = 'completed', total_cents = quantity * unit_price_cents,
    attempts = attempts + 1, processed_at = now()
WHERE id = $1 AND status = 'queued'`;

export async function completeOrder({ db }: Deps, id: string): Promise<boolean> {
  const { rowCount } = await db.query(COMPLETE_ORDER, [id]);
  return rowCount === 1;
}
