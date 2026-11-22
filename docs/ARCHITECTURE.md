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

  both order APIs ──HTTP──▶ fake-payment   (authorise every order; timeout + circuit breaker)

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
| `fake-payment` | Go 1.26 (same binary, `MODE=payment`) | Fake payment provider: a healthy endpoint and a degraded one with a scheduled outage |
| `postgres` | PostgreSQL 17 | Products and orders |
| `redis` | Redis 7.4 | Product cache + order streams (no persistence; lab data is disposable) |
| `otel-collector` | OTel Collector contrib | Receives OTLP, batches, generates span metrics, exports |
| `tempo` | Grafana Tempo | Trace storage, 48 h |
| `prometheus` | Prometheus | Metrics, 7 d |
| `loki` | Grafana Loki 3 | Logs over OTLP, 3 d |
| `grafana` | Grafana | Dashboards, LAN only |

The Node image is shared by `order-api-node` and `worker-node` (different start command);
the Go binary is shared by `order-api-go`, `worker-go` and `fake-payment` (`MODE=api|worker|payment`).

## Request flow

1. Browser → `lab-web` → `gateway`: `POST /api/{impl}/orders {productId, quantity, scenario}`.
2. Gateway checks guards (see RESOURCE-BUDGET.md), then forwards to the chosen order API with a
   timeout. The trace starts here (or continues from the browser, later).
3. Order API validates the body (`order.validate`).
4. Product lookup (`product.lookup`): Redis `GET lab:{impl}:product:{id}`; on miss, read Postgres and
   cache for 60 s. Scenario `cache-miss` skips the cache read.
5. Payment (`payment.authorize`): `POST fake-payment/authorize` with a 500 ms timeout behind a
   circuit breaker; `dependency-timeout` uses the degraded endpoint and its own breaker. A timeout
   returns `504`, an open breaker `503`; no order is stored in either case.
6. Order insert (`order.persist`): one `INSERT … SELECT … FROM pg_sleep($n)`; `$n` is 0 normally and
   the configured delay for `slow-db`, so the slow span is the real insert, not a separate query.
7. Enqueue (`order.enqueue`): `XADD lab:{impl}:orders` with `orderId`, `scenario`, `attempt` and
   the current `traceparent`.
8. API returns `202 {orderId, impl, status: "queued"}`. The client does not wait for the worker.
9. Worker reads with `XREADGROUP` (group `workers`), extracts `traceparent`, starts
   `order.process` as part of the same trace, simulates work, updates the row to `completed`,
   `XACK`s. A failed attempt is parked in a sorted set and retried with backoff (500 ms, 1 s); entries
   a dead worker never acknowledged are reclaimed with `XAUTOCLAIM` after 60 s.
10. SPA polls `GET /api/{impl}/orders/:id` until completed, then asks the gateway for the trace and
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
  Differences show in memory footprint, cold start, and tail latency under load (experiment 5).
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

```
apps ──OTLP/HTTP──▶ otel-collector ─┬─ traces ──▶ Tempo (48 h)
                                    ├─ traces ──▶ span_metrics ──┐
                                    ├─ traces ──▶ service_graph ─┤
                                    ├─ metrics ◀─────────────────┘──▶ Prometheus (OTLP receiver, 7 d / 1 GB)
                                    └─ logs ────▶ Loki (OTLP, 3 d)
                                         Grafana: datasources linked by trace ID, "Lab overview" dashboard
```

- Apps send OTLP over HTTP (protobuf) to `otel-collector:4318` on the internal `lab` network only.
  The receiver is never published on a host port or the tunnel. Configuration is the standard
  `OTEL_*` environment variables in both languages (service name, endpoint, resource attributes,
  export intervals).
- Spans are exported every 1 s (`OTEL_BSP_SCHEDULE_DELAY=1000`, default 5 s) so a visitor's trace is
  available within a couple of seconds; metrics every 10 s.
- **RED metrics come from spans**: the collector's `span_metrics` connector counts every span and
  records its duration per service, span name, kind, status and the dimensions `lab.impl`,
  `lab.scenario`, `http.response.status_code`, `lab.shed_reason`. No hand-written request metrics.
  `service_graph` adds request counts and latency between services (Grafana's service map).
- **App metrics** over OTLP: HTTP server/client duration, DB client operations and pool state,
  runtime (Node event loop, GC, heap; Go goroutines, heap, GC), gateway guards (in-flight, backlog,
  host load, limits, refusals), circuit breaker state and transitions.
- **Container metrics without cAdvisor**: each service reads its own cgroup v2 files
  (`cpu.stat`, `cpu.max`, `memory.current`, `memory.max`) and exports `lab.cgroup.*`: CPU used,
  throttled periods and time, memory used and limits. Same names from Node and Go. No Docker socket.
- **Logs**: pino (Node) and slog (Go) write JSON to stdout and send the same records over OTLP to
  Loki with trace and span IDs. Loki keeps `trace_id` as structured metadata; Grafana turns it into
  a link to the trace. Health-check requests are not logged.
- Collector: `memory_limiter` → `batch` in every pipeline; 256 MiB limit.
- Sampling: 100 % in the lab (low traffic); tail sampling (keep errors + slow) only if volume grows.
- Grafana datasources and the "Lab overview" dashboard are provisioned from files
  (`infra/grafana/provisioning`). Runtime plugin downloads are off (read-only rootfs).

Correlation in Grafana: trace span → its logs (Loki, by trace ID) and its RED metrics; log line →
its trace; dashboard log panel → trace; Tempo → service map.

### What is instrumented

| | Node (gateway, order-node) | Go (order-go) |
|---|---|---|
| SDK setup | `packages/telemetry`, loaded with `node --import @lab/telemetry/register` before the app | `telemetry.go` (`setupTelemetry`) |
| Incoming HTTP | `instrumentation-http`; span renamed to the route template by a Fastify hook | `otelhttp`; span renamed to `r.Pattern` after routing |
| Outgoing HTTP | `instrumentation-undici` (gateway `fetch`), injects `traceparent` | — |
| Postgres | `instrumentation-pg`, with connect spans: `pg-pool.connect` = wait for a pool connection, `pg.connect` = new physical connection | `otelpgx`: `pool.acquire` = wait for a pool connection |
| Redis | `instrumentation-ioredis` | own `redisTracingHook` (~30 lines) |
| Outgoing HTTP to fake-payment | `instrumentation-undici` | `otelhttp.NewTransport` |
| Metrics | SDK meter + `instrumentation-runtime-node`, own cgroup reader | SDK meter + contrib `runtime`, `otelpgx.RecordStats`, own cgroup reader |
| Business spans | `order.validate`, `product.lookup` (`cache.hit`), `payment.authorize` (breaker attributes), `order.persist`, `order.enqueue` (producer), `order.process` (consumer, `lab.attempt`), `order.fulfil` (simulated work), `gateway.guards` | same names and attributes |
| Logs | pino → stdout + OTLP (`instrumentation-pino`); `trace_id` / `span_id` on every line | slog → stdout + OTLP (`otelslog` bridge); same fields |

Noise control:
- `/healthz` is not traced (Docker health checks run every 10 s).
- Database and Redis spans are only created inside an existing trace (`requireParentSpan` in Node,
  a parent check in the Go Redis hook). Without this, the worker's blocking `XREADGROUP` poll would
  start a new trace every 5 seconds. Verified: every trace in Tempo has the gateway as its root.

The gateway returns `X-Trace-Id` on every response; the SPA uses it to fetch the visitor's own trace.

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
- **Redis has no persistence**: a Redis restart drops undelivered stream entries and scheduled
  retries (`lab:{impl}:retry`), so those orders stay `queued`. Workers recreate their consumer group automatically (`NOGROUP` → create). A sweeper
  that re-enqueues old `queued` orders, or turning on AOF, would close the gap; a candidate experiment.
- **Circuit breaker state is per process**: each API instance learns about the outage on its own
  (5 failures each). Fine for one instance per implementation; a shared breaker (Redis) would be
  needed with several replicas.
- **Retries ack first, then re-add**: a failed attempt is acknowledged once its retry is in the
  sorted set; the move back to the stream is atomic (Lua). A crash between `ZADD` and `XACK` can
  produce one extra attempt, which the idempotent update absorbs.
- **No auth on the order API**: it is a demo with synthetic data; protection is rate limits and
  periodic data reset, not user accounts.
