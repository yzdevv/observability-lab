# API contract

Both implementations (Node and Go) must behave identically. A shared contract test suite runs
against each.

## Gateway (public, through `lab-web`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/{impl}/orders` | `impl` = `node` or `go`; body forwarded to the order API |
| `GET` | `/api/{impl}/orders/{id}` | Order status |
| `GET` | `/api/traces/{traceId}` | Trace for the waterfall (Milestone E); only traces created by the lab |
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
`{"error": "message"}`. Request body limit 4 KB.

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
| `worker-retry` | Worker | Processing fails on attempts 1–2, succeeds on attempt 3 (Milestone D) |
| `dependency-timeout` | Order API | Call to a slow fake dependency hits its timeout; circuit breaker opens after repeated failures (Milestone D) |

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

Workers `XACK` only after the database update succeeds. Unacked messages are reclaimed with
`XAUTOCLAIM` after an idle timeout (Milestone D).

## Redis keys

| Key | Type | TTL |
|---|---|---|
| `lab:{impl}:product:{productId}` | string (JSON `{id, name, priceCents}`) | 60 s |
| `lab:{impl}:orders` | stream | capped |

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

Seed: products `demo-001` … `demo-010`. Orders older than a few hours are deleted by a periodic
reset (Milestone E).

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
```
