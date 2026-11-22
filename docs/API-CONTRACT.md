# API contract

Both implementations (Node and Go) must behave identically. A shared contract test suite runs
against each.

## Gateway (public, through `lab-web`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/{impl}/orders` | `impl` = `node` or `go`; body forwarded to the order API |
| `GET` | `/api/{impl}/orders/{id}` | Order status |
| `GET` | `/api/traces/{traceId}?at={ms}` | Trace for the page's waterfall (below) |
| `GET` | `/api/lab/stats` | Live RED numbers per impl, last 5 minutes (below) |
| `GET` | `/api/lab/status` | Guard state: host load, in-flight, queue backlog per impl, limits |
| `GET` | `/api/health` | Gateway + both order APIs |
| `GET` | `/healthz` | Gateway liveness |

Gateway-specific errors:

| Status | When | Body |
|---|---|---|
| `400` | Unknown `impl` | `{"error": "..."}` |
| `429` | Per-IP rate limit hit | `{"error": "...", "retryAfter": n}` |
| `503` | A guard refused the request (busy, host load, backlog) | `{"error": "...", "reason": "inflight" \| "host-load" \| "backlog"}` + `Retry-After` |
| `502` | Order API unreachable | `{"error": "..."}` |
| `504` | Order API timed out | `{"error": "..."}` |

Responses from the order API carry `X-Trace-Id` so the SPA can fetch the trace.

Reads (`GET` order status, traces, stats, status) have their own per-IP limit, `READ_LIMIT_PER_MIN`
(240). In front of the gateway, `lab-web`'s nginx caps each visitor at 10 API requests per second
(burst 20) and 10 open connections.

### `GET /api/traces/{traceId}`

`traceId`: 32 lowercase hex characters (else `400`). `at` (optional): when the request was sent, in
ms since the epoch; the gateway then asks Tempo only for a window around it, which is much faster.

Response `200`:

```json
{
  "traceId": "4bdd…",
  "spans": [
    { "spanId": "97c5…", "parentSpanId": "", "service": "gateway", "name": "POST /api/:impl/orders",
      "kind": "server", "startMs": 1795334201539.0, "durationMs": 14.2, "error": false,
      "attributes": { "lab.impl": "node", "lab.scenario": "none", "http.response.status_code": 202 } }
  ]
}
```

Only traces whose root span is the gateway's are returned (others: `404`), and only a fixed list of
attributes (SQL text, cache hit, attempt, breaker state, scenario, status codes, …): no host names,
ports or SDK details. `404` also means "not in Tempo yet": spans arrive a few seconds after they
end, so the page asks again. `502` when Tempo is unreachable. Lookups are not traced themselves.

### `GET /api/lab/stats`

```json
{ "window": "5m", "at": "2026-11-23T01:00:00.000Z",
  "impls": { "node": { "rps": 0.4, "errorPct": 3, "p50Ms": 6.1, "p95Ms": 21.0 },
             "go":   { "rps": 0.3, "errorPct": 0, "p50Ms": 4.2, "p95Ms": 9.8 } } }
```

From the span metrics of the gateway's `POST /api/:impl/orders` span: request rate, share not
answered with `202`, and median / 95th percentile duration. `null` when there was no traffic.
Computed at most once per 10 s for all visitors. `502` when Prometheus is unreachable.

## Order API (internal, both implementations)

### `POST /orders`

Request:

```json
{ "productId": "demo-001", "quantity": 2, "scenario": "none" }
```

| Field | Rule |
|---|---|
| `productId` | string matching `^demo-\d{3}$` |
| `quantity` | integer, 1–10 |
| `scenario` | optional, default `none`; one of the scenarios below |

Response `202`:

```json
{ "orderId": "6f1c…", "impl": "go", "status": "queued" }
```

Errors: `400` invalid body, `404` unknown product, `500` unexpected. Body always
`{"error": "message"}`, plus `"reason"` where listed below. Request body limit 4 KB.

Every order is authorised with the payment provider (`fake-payment`) before it is stored:

| Status | When | Body |
|---|---|---|
| `504` | Payment call exceeded `DEPENDENCY_TIMEOUT_MS` (500 ms) | `{"error": "payment provider timed out", "reason": "dependency-timeout"}` |
| `503` | Circuit breaker open: call not attempted | `{"error": "payment provider unavailable (circuit open)", "reason": "circuit-open"}` |

No order is created in either case. The gateway passes these through unchanged.

### Payment call and circuit breaker

| Setting | Default | Meaning |
|---|---|---|
| `DEPENDENCY_TIMEOUT_MS` | 500 | Timeout of the payment call |
| `BREAKER_FAILURES` | 5 | Consecutive failures that open the breaker |
| `BREAKER_OPEN_MS` | 10000 | How long it stays open before one probe call (half-open) |
| `BREAKER_ENABLED` | true | `false` = timeout only, for the with/without comparison |

Probe succeeds → closed; probe fails → open again. One breaker per endpoint and per API process:
`payment` (`POST /authorize`) and `payment-degraded` (`POST /degraded/authorize`, used only by the
`dependency-timeout` scenario), so one visitor's failures never open the breaker for normal orders.
State changes are logged and exported as `lab.breaker.state` (0 closed, 1 half-open, 2 open) and
`lab.breaker.transitions`. The `payment.authorize` span carries `lab.dependency`,
`lab.breaker.state`, `lab.breaker.probe` and `lab.breaker.rejected`.

`fake-payment` (the Go binary with `MODE=payment`): `/authorize` answers in 2–4 ms;
`/degraded/authorize` has a scheduled outage: for the first `DEGRADED_OUTAGE_S` (30) seconds of
every `DEGRADED_CYCLE_S` (60) it hangs for `DEGRADED_DELAY_MS` (3000) before answering, so the
open → half-open → closed cycle happens on its own. `GET /status` reports the window.

### `GET /orders/{id}`

`id` must be a UUID (else `400`). Response `200`:

```json
{
  "orderId": "6f1c…",
  "impl": "go",
  "productId": "demo-001",
  "quantity": 2,
  "scenario": "none",
  "status": "completed",
  "attempts": 1,
  "totalCents": 50000,
  "createdAt": "2026-11-21T12:00:00.000Z",
  "processedAt": "2026-11-21T12:00:00.045Z"
}
```

`totalCents` and `processedAt` are `null` until processed. Timestamps are UTC ISO 8601 with
milliseconds. `404` if not found.

### `GET /healthz`

`200 {"ok": true, "impl": "node"}` when Postgres and Redis answer; `503` otherwise.

## Scenarios

| Value | Where | Effect |
|---|---|---|
| `none` | — | Normal path |
| `slow-db` | Order API | The order `INSERT` takes `SLOW_DB_MS` longer (default 300 ms) |
| `cache-miss` | Order API | Skip the Redis read; always query Postgres for the product |
| `worker-retry` | Worker | `order.fulfil` fails on attempts 1–2, succeeds on attempt 3; the order completes with `attempts = 3` after ~1.5 s of backoff |
| `dependency-timeout` | Order API | Payment goes to the degraded provider: during its outage the call times out (`504`), after 5 timeouts the breaker opens (`503 circuit-open`), and it closes again once a probe succeeds |

Unknown values are rejected with `400`.

## Queue messages (Redis Streams)

- Stream: `lab:{impl}:orders` (capped with `MAXLEN ~ 10000`)
- Consumer group: `workers` (created with `MKSTREAM`, start id `0`)
- Fields (all strings):

| Field | Example | Notes |
|---|---|---|
| `orderId` | `6f1c…` | UUID |
| `scenario` | `none` | Copied from the request |
| `attempt` | `1` | Incremented on retry |
| `traceparent` | `00-…-…-01` | W3C trace context (empty until Milestone B) |
| `tracestate` | | Optional |

Workers `XACK` only after the database update succeeds.

### Retries

A failed attempt (the simulated `worker-retry` failure) is handled, then acknowledged:

1. `attempt < WORKER_MAX_ATTEMPTS` (3): record the attempt (`attempts = attempts + 1`), add the
   message with `attempt + 1` to the sorted set `lab:{impl}:retry`, scored by its due time in epoch
   ms. Backoff is `RETRY_BASE_MS × 2^(attempt-1)`: 500 ms, then 1 s.
2. Last attempt: mark the order `failed`.

Every `RETRY_PROMOTE_MS` (250 ms) the worker moves due entries back onto the stream with one Lua
script (same text in both implementations), so a retry is never lost between the two steps. The
retry keeps the original `traceparent`: all attempts are sibling `order.process` spans under the
request's `order.enqueue`, with `lab.attempt`, and failed ones carry `lab.retry.scheduled` and
`lab.retry.delay_ms`.

### Crashed workers

Entries delivered but not acknowledged for `RECLAIM_IDLE_MS` (60 s) are taken over with
`XAUTOCLAIM` every `RECLAIM_EVERY_MS` (15 s) and processed again; the `UPDATE … WHERE status =
'queued'` keeps that idempotent. Verified by claiming an entry with a fake consumer while the worker
was stopped: the restarted worker completed the order after ~62 s.

## Redis keys

| Key | Type | TTL |
|---|---|---|
| `lab:{impl}:product:{productId}` | string (JSON `{id, name, priceCents}`) | 60 s |
| `lab:{impl}:orders` | stream | capped |
| `lab:{impl}:retry` | sorted set (member = JSON message, score = due time ms) | none; entries leave when promoted |

Redis runs with `maxmemory 48mb` and `volatile-lru`: only TTL'd cache keys can be evicted, never
streams.

## Database schema

```sql
CREATE TABLE products (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0)
);

CREATE TABLE orders (
  id               uuid PRIMARY KEY,
  product_id       text NOT NULL REFERENCES products(id),
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_cents integer NOT NULL,
  total_cents      integer,
  impl             text NOT NULL CHECK (impl IN ('node', 'go')),
  scenario         text NOT NULL,
  status           text NOT NULL CHECK (status IN ('queued', 'completed', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);

CREATE INDEX orders_created_at_idx ON orders (created_at);
```

Seed: products `demo-001` … `demo-010`. Each worker deletes its implementation's orders older than
`ORDER_RETENTION_HOURS` (6) every `CLEANUP_EVERY_MS` (10 min); the query is not traced.

Shared SQL used by both implementations:

```sql
-- create (slow-db passes the delay in seconds as $7, otherwise 0)
INSERT INTO orders (id, product_id, quantity, unit_price_cents, impl, scenario, status)
SELECT $1::uuid, $2::text, $3::int, $4::int, $5::text, $6::text, 'queued'
FROM pg_sleep($7::float8);

-- process (idempotent)
UPDATE orders
SET status = 'completed', total_cents = quantity * unit_price_cents,
    attempts = attempts + 1, processed_at = now()
WHERE id = $1 AND status = 'queued';

-- failed attempt, retry scheduled
UPDATE orders SET attempts = attempts + 1 WHERE id = $1 AND status = 'queued';

-- last attempt failed
UPDATE orders SET status = 'failed', attempts = attempts + 1, processed_at = now()
WHERE id = $1 AND status = 'queued';
```
