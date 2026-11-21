# Architecture

## Overview

```
                    Internet
                       │  Cloudflare tunnel (lab.mge.my.id)
                       ▼
                 ┌───────────┐
                 │  lab-web  │  nginx: Vite SPA + proxy /api → gateway
                 └─────┬─────┘
                       ▼
                 ┌───────────┐  rate limits, load guards,
                 │  gateway  │  routes by implementation,
                 │ (Fastify) │  trace lookup for the SPA
                 └──┬─────┬──┘
          /api/node │     │ /api/go
                    ▼     ▼
        ┌──────────────┐ ┌──────────────┐
        │order-api-node│ │ order-api-go │
        └──┬───────┬───┘ └──┬───────┬───┘
           │       │        │       │
           │  ┌────▼────────▼───┐   │
           │  │      Redis      │   │   product cache (per impl)
           │  │ streams + cache │   │   lab:node:orders / lab:go:orders
           │  └────┬────────┬───┘   │
           │       ▼        ▼       │
           │ ┌───────────┐ ┌───────────┐
           │ │worker-node│ │ worker-go │
           │ └─────┬─────┘ └─────┬─────┘
           ▼       ▼             ▼   ▼
        ┌─────────────────────────────┐
        │          PostgreSQL         │
        └─────────────────────────────┘

  every service ──OTLP──▶ otel-collector ──▶ Tempo (traces)
                                         ──▶ Prometheus (metrics)
                                         ──▶ Loki (logs)
                                Grafana reads all three (LAN only)
```

## Services

| Service | Tech | Role |
|---|---|---|
| `lab-web` | nginx + Vite/React SPA | Public page; proxies `/api/` to the gateway. Only container on the `public` network |
| `gateway` | Node 24, Fastify | Entry point: validation of `impl`, rate limit per IP, in-flight cap, host-load guard, queue-backlog guard, upstream timeout; `GET /api/traces/:id` reads Tempo for the SPA |
| `order-api-node` | Node 24, Fastify, `pg`, `ioredis` | Order API (Node path) |
| `worker-node` | Node 24, `pg`, `ioredis` | Consumes `lab:node:orders` |
| `order-api-go` | Go 1.26, `net/http`, `pgx`, `go-redis` | Order API (Go path) |
| `worker-go` | Go 1.26 | Consumes `lab:go:orders` |
| `postgres` | PostgreSQL 17 | Products and orders |
| `redis` | Redis 7.4 | Product cache + order streams (no persistence; lab data is disposable) |
| `otel-collector` | OTel Collector contrib | Receives OTLP, batches, generates span metrics, exports |
| `tempo` | Grafana Tempo | Trace storage, 48 h |
| `prometheus` | Prometheus | Metrics, 7 d |
| `loki` | Grafana Loki 3 | Logs over OTLP, 3 d |
| `grafana` | Grafana | Dashboards, LAN only |

The Node image is shared by `order-api-node` and `worker-node` (different start command);
the Go binary is shared by `order-api-go` and `worker-go` (`MODE=api|worker`).

## Request flow

1. Browser → `lab-web` → `gateway`: `POST /api/{impl}/orders {productId, quantity, scenario}`.
2. Gateway checks guards (see RESOURCE-BUDGET.md), then forwards to the chosen order API with a
   timeout. The trace starts here (or continues from the browser, later).
3. Order API validates the body (`order.validate`).
4. Product lookup (`product.lookup`): Redis `GET lab:{impl}:product:{id}`; on miss, read Postgres and
   cache for 60 s. Scenario `cache-miss` skips the cache read.
5. Order insert (`order.persist`): one `INSERT … SELECT … FROM pg_sleep($n)`; `$n` is 0 normally and
   the configured delay for `slow-db`, so the slow span is the real insert, not a separate query.
6. Enqueue (`order.enqueue`): `XADD lab:{impl}:orders` with `orderId`, `scenario`, `attempt` and
   the current `traceparent`.
7. API returns `202 {orderId, impl, status: "queued"}`. The client does not wait for the worker.
8. Worker reads with `XREADGROUP` (group `workers`), extracts `traceparent`, starts
   `order.process` as part of the same trace, simulates work, updates the row to `completed`,
   `XACK`s.
9. SPA polls `GET /api/{impl}/orders/:id` until completed, then asks the gateway for the trace and
   draws the waterfall.

## Node vs Go: keeping the comparison honest

- **Same contract**: identical endpoints, validation rules, SQL, Redis commands and error codes
  (API-CONTRACT.md). A shared contract test suite runs against both.
- **No shared state that skews results**: separate cache keys and separate streams per
  implementation, so one cannot warm the other's cache or drain the other's queue.
- **Same resources**: identical CPU and memory limits; same DB pool size (10).
  Go reads its CPU limit from the cgroup (Go 1.25+), Node is single-threaded by nature — the docs
  say so instead of pretending the runtimes are alike.
- **Same simulated work** in the worker (fixed duration).
- **Honest expectations**: at demo traffic, Postgres and network dominate and both look similar.
  Differences show in memory footprint, cold start, and tail latency under load (k6, Milestone D).
  The case study reports what was measured, including "no meaningful difference" where true.

## Trace context across the queue

Auto-instrumentation does not reliably follow a message through Redis Streams, so propagation is
explicit in both languages:

- Producer: inject the active context into a carrier (W3C `traceparent`, `tracestate`) and add the
  fields to the stream entry.
- Consumer: extract from the entry and start `order.process` with that parent (a child span; a span
  link is the alternative if batching later makes parent/child misleading).

An integration test asserts that the worker span's trace ID equals the request's.

## Telemetry pipeline

- Apps send OTLP over HTTP to `otel-collector:4318` on the internal `lab` network only.
  The receiver is never published on a host port or the tunnel.
- Collector: `memory_limiter` → `batch` → exporters; `spanmetrics` connector produces
  request/error/duration metrics per service and route for Prometheus.
- Sampling: 100 % in the lab (low traffic); tail sampling (keep errors + slow) only if volume grows.
- Logs: pino (Node) and slog (Go) JSON with `trace_id` / `span_id`, exported over OTLP to Loki.
- Grafana datasources are provisioned from files: Tempo ↔ Loki ↔ Prometheus links by trace ID.

## Network exposure

| Network | Members | Purpose |
|---|---|---|
| `lab` (project network) | everything in the lab | Internal traffic, OTLP |
| `public` (shared) | `lab-web` only | Cloudflare tunnel reaches the public page |
| `homelab` (shared) | `lab-web`, `grafana` | NPM proxy hosts `lab.home.arpa`, `grafana.home.arpa` |

No host ports on the server. Gateway, databases, collector and storage are unreachable from the
tunnel. In local development the gateway is published on `127.0.0.1:8088`.

## Known trade-offs (case study material)

- **Insert then enqueue is not atomic**: if `XADD` fails after the insert, the order stays `queued`.
  The fix is a transactional outbox; it may become its own experiment.
- **At-least-once delivery**: a crash between update and `XACK` redelivers; the update is guarded
  (`WHERE status = 'queued'`) so it is idempotent.
- **No auth on the order API**: it is a demo with synthetic data; protection is rate limits and
  periodic data reset, not user accounts.
