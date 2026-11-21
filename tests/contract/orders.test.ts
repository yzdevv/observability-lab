// Contract tests from docs/API-CONTRACT.md, run against both implementations through the gateway.
// Usage: LAB_URL=http://127.0.0.1:8088 pnpm test:contract
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.LAB_URL ?? 'http://127.0.0.1:8088';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function post(impl: string, body: unknown) {
  const res = await fetch(`${BASE}/api/${impl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(impl: string, id: string) {
  const res = await fetch(`${BASE}/api/${impl}/orders/${id}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitCompleted(impl: string, id: string) {
  for (let i = 0; i < 50; i++) {
    const { body } = await get(impl, id);
    if (body.status === 'completed') return body;
    await sleep(100);
  }
  throw new Error(`order ${id} did not complete`);
}

for (const impl of ['node', 'go']) {
  describe(`${impl} implementation`, () => {
    it('accepts an order and the worker completes it', async () => {
      const created = await post(impl, { productId: 'demo-002', quantity: 3 });
      assert.equal(created.status, 202);
      assert.deepEqual(Object.keys(created.body).sort(), ['impl', 'orderId', 'status']);
      assert.equal(created.body.impl, impl);
      assert.equal(created.body.status, 'queued');
      assert.match(String(created.body.orderId), UUID);

      const order = await waitCompleted(impl, String(created.body.orderId));
      assert.deepEqual(Object.keys(order).sort(), [
        'attempts', 'createdAt', 'impl', 'orderId', 'processedAt', 'productId',
        'quantity', 'scenario', 'status', 'totalCents',
      ]);
      assert.equal(order.impl, impl);
      assert.equal(order.productId, 'demo-002');
      assert.equal(order.quantity, 3);
      assert.equal(order.scenario, 'none');
      assert.equal(order.attempts, 1);
      assert.equal(order.totalCents, 3 * 45000);
      assert.match(String(order.createdAt), ISO_MS);
      assert.match(String(order.processedAt), ISO_MS);
    });

    it('rejects invalid bodies with 400', async () => {
      const cases: unknown[] = [
        { productId: 'nope', quantity: 1 },
        { productId: 'demo-001', quantity: 0 },
        { productId: 'demo-001', quantity: 11 },
        { productId: 'demo-001', quantity: 1.5 },
        { productId: 'demo-001', quantity: 1, scenario: 'meltdown' },
      ];
      for (const body of cases) {
        const res = await post(impl, body);
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
        assert.equal(typeof res.body.error, 'string');
      }
    });

    it('returns 404 for an unknown product', async () => {
      const res = await post(impl, { productId: 'demo-999', quantity: 1 });
      assert.equal(res.status, 404);
    });

    it('returns 400 for a malformed order id and 404 for a missing one', async () => {
      assert.equal((await get(impl, 'not-a-uuid')).status, 400);
      assert.equal((await get(impl, '00000000-0000-4000-8000-000000000000')).status, 404);
    });

    it('slow-db makes the request at least 300 ms slower', async () => {
      const started = performance.now();
      const res = await post(impl, { productId: 'demo-003', quantity: 1, scenario: 'slow-db' });
      assert.equal(res.status, 202);
      assert.ok(performance.now() - started >= 300, 'slow-db request returned too fast');
      const order = await waitCompleted(impl, String(res.body.orderId));
      assert.equal(order.scenario, 'slow-db');
    });

    it('cache-miss still creates the order', async () => {
      const res = await post(impl, { productId: 'demo-004', quantity: 1, scenario: 'cache-miss' });
      assert.equal(res.status, 202);
      await waitCompleted(impl, String(res.body.orderId));
    });
  });
}

describe('gateway', () => {
  it('rejects an unknown implementation', async () => {
    const res = await post('rust', { productId: 'demo-001', quantity: 1 });
    assert.equal(res.status, 400);
  });

  it('reports health of both implementations', async () => {
    const res = await fetch(`${BASE}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { gateway: 'ok', node: 'ok', go: 'ok' });
  });

  it('exposes guard status', async () => {
    const res = await fetch(`${BASE}/api/lab/status`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.ok('load1' in body && 'backlog' in body && 'limits' in body);
  });
});
