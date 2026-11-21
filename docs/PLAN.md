# Plan

## Goal

Build a lab that lets a visitor:

1. Send an order request through a Node.js **or** Go implementation.
2. See that request's full trace: gateway → order API → cache → database → queue → worker.
3. Pick a failure scenario (slow database, cache miss, worker retry, dependency timeout) and see
   exactly where the time goes.
4. Compare Node.js and Go side by side on the same scenario, live.

The recorded case study (traces, charts, write-up) is the main product. The live demo is a bonus:
the server is a laptop with a dead battery on a home connection, so the page must still make
sense when the live lab is offline.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Frontend | Vite + React SPA, served by nginx | Same as Kelasin; Next.js adds a Node process for no benefit |
| Implementations | Two full paths: Node.js 24 and Go 1.26, each with its own API + worker | Visitors choose one and compare live; shows cross-language tracing |
| Node runtime | Node 24 (not Bun) | OpenTelemetry auto-instrumentation relies on Node module hooks that Bun does not fully support |
| Node code | TypeScript run directly via Node type stripping, Fastify, `pg`, `ioredis` | No build step; idiomatic |
| Go code | `net/http` (1.22+ routing), `pgx/v5`, `go-redis/v9`, `log/slog` | Idiomatic, small dependency set |
| Queue | Redis Streams (consumer groups) instead of BullMQ | Works the same from both languages; BullMQ has no Go producer |
| Gateway | Node.js + Fastify | Single public entry point: routing, rate limits, load guards |
| Failure injection | Per request (a `scenario` field), not global toggles | One visitor cannot degrade the lab for everyone else |
| Telemetry | OTel SDKs → OTel Collector → Tempo (traces), Prometheus (metrics), Loki (logs) → Grafana | Standard, vendor-neutral |
| Metrics source | Span metrics (RED) generated from traces + runtime metrics from SDKs | No hand-written metrics code needed for the basics |
| Logs | Structured JSON logs with `trace_id`, sent over OTLP to Loki 3 | No Promtail, no Docker log scraping |
| Public trace view | Own waterfall in the SPA, fed by a gateway endpoint that reads Tempo | Grafana stays LAN-only; looks better and shows more skill |
| Grafana | LAN-only at `grafana.home.arpa` | Admin tool, not for the public |
| Data | Synthetic products and orders only | Nothing personal, nothing real |
| Isolation | Own Docker network, own systemd slice with CPU/RAM caps | Production sites keep priority — see RESOURCE-BUDGET.md |
| Load tests | k6 from the Mac over the LAN, never through the Cloudflare tunnel | Do not burn the home uplink or Cloudflare limits |

Repository: public on GitHub.

## Milestones

### A — Core services (2–3 days)
- pnpm monorepo; `gateway`, `order-node` (api + worker), `order-go` (api + worker), Postgres, Redis.
- `POST /api/{impl}/orders` returns `202`, the worker completes the order, `GET` shows the status.
- Docker Compose with resource limits from day one.

**Done when:** a smoke script creates an order through each implementation and both reach
`completed`; both pass the same contract checks.

### B — Distributed tracing (2–3 days)
- OTel SDK in all services, Collector, Tempo, Grafana with provisioned datasources.
- Manual spans: `order.validate`, `product.lookup`, `order.persist`, `order.enqueue`, `order.process`.
- W3C `traceparent` carried in the Redis Stream message so the worker span joins the request trace.

**Done when:** one trace ID shows gateway → API → Redis → Postgres → queue → worker, for both
Node and Go; an integration test asserts the worker span shares the request's trace ID.

### C — Slow database is visible (1–2 days)
- `slow-db` scenario; baseline vs degraded comparison.
- First experiment written up in EXPERIMENTS.md.

**Done when:** the slow `INSERT` span is the obvious culprit in the waterfall.

### D — Metrics, logs, more scenarios (3 days)
- Prometheus (span metrics + runtime), Loki over OTLP, log ↔ trace links in Grafana.
- Scenarios `cache-miss`, `worker-retry`, `dependency-timeout` (timeout + circuit breaker, so recovery
  is visible).
- k6 runs: baseline, degraded, improved; Node vs Go under load.

**Done when:** three or more scenarios are reproducible and each has recorded evidence.

### E — Public demo (3–4 days)
- SPA: choose implementation (Node / Go / both), choose scenario, send, see own trace waterfall,
  see live RED numbers and the lab guard status.
- "Compare" mode: same scenario fired at both implementations, results side by side.
- Offline fallback: recorded runs shown when the live lab is down.

**Done when:** a stranger can use it without instructions and cannot overload it.

### F — Deploy and case study (1–2 days)
- Homelab deploy, tunnel route `lab.mge.my.id`, Kuma monitors, Jejak tracking.
- Case study page on the portfolio; config copies in the homelab repo.

**Done when:** live at `lab.mge.my.id` and linked from `dev.mge.my.id`.

Estimate: about 2–3 focused weeks. A–C (about a week) are already enough for a first case study.

## Definition of done (whole project)

- [x] Gateway → order API → Postgres works for Node and Go
- [x] Orders are processed asynchronously through Redis Streams
- [ ] Docker Compose runs everything within the resource budget
- [x] One trace ID links request and worker, in both languages
- [ ] Grafana shows traces, metrics and logs, linked by trace ID
- [x] A slow query can be identified from the trace alone
- [ ] At least three failure scenarios are reproducible
- [ ] Baseline vs degraded, and Node vs Go, are compared with numbers
- [ ] Retry, timeout and recovery are observable
- [ ] The public demo is safe and rate-limited
- [ ] Architecture diagram and case study are published
- [ ] Benchmarks and trade-offs are documented
