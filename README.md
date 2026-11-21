# Observability Lab

> Send a request. Trace its journey. Break the system. Find the bottleneck.

A small order-processing system built twice — **Node.js** and **Go** — behind one gateway, so the
same request and the same failure can be compared side by side. Instrumented with OpenTelemetry
(traces, metrics, logs), with controlled failure scenarios and a strict resource budget so it can
run next to production services on a small home server.

```
browser → gateway ─┬─ order-api-node → Postgres / Redis → stream → worker-node
                   └─ order-api-go   → Postgres / Redis → stream → worker-go
```

## Quick start

Requirements: Docker, Node 24, pnpm, Go 1.26.

```sh
docker compose -f infra/compose.yaml -f infra/compose.dev.yaml up -d --build
./scripts/smoke.sh
pnpm install && pnpm test:contract
```

```sh
curl -X POST http://127.0.0.1:8088/api/go/orders \
  -H 'content-type: application/json' \
  -d '{"productId":"demo-001","quantity":2,"scenario":"slow-db"}'
```

## Docs

Design, contract, resource budget and experiments are in [`docs/`](docs/README.md).

## Status

- [x] Milestone A — core services (Node + Go), gateway guards, contract tests
- [ ] Milestone B — distributed tracing
- [ ] Milestone C — slow database visible in traces
- [ ] Milestone D — metrics, logs, more failure scenarios, load tests
- [ ] Milestone E — public demo
- [ ] Milestone F — deployment and case study
