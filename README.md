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

Grafana: http://127.0.0.1:3000 → Explore → Tempo. Every gateway response carries `X-Trace-Id`.

```sh
curl -X POST http://127.0.0.1:8088/api/go/orders \
  -H 'content-type: application/json' \
  -d '{"productId":"demo-001","quantity":2,"scenario":"slow-db"}'
```

Then look at it from the telemetry side:

```sh
node scripts/waterfall.ts <trace-id>                      # one trace as a text waterfall
scripts/experiment.sh /tmp/run go slow-db RATE=4          # k6 load run (Docker), ~90 s
node scripts/trace-stats.ts --run /tmp/run                # which span the time goes to
```

## Results so far

Experiment 1 (slow database): the injected 300 ms `INSERT` is 98 % of the response in both
languages. Under load it caps each API at ~33 orders/s, and the trace shows the new cost as waits
for a pool connection. [Write-up](docs/EXPERIMENTS.md#1-slow-database--2026-11-22-mac-docker-desktop).

## Docs

Design, contract, resource budget and experiments are in [`docs/`](docs/README.md).

## Status

- [x] Milestone A — core services (Node + Go), gateway guards, contract tests
- [x] Milestone B — distributed tracing (OpenTelemetry → Collector → Tempo → Grafana)
- [x] Milestone C — slow database visible in traces (experiment 1, baseline vs degraded, pool saturation under load)
- [ ] Milestone D — metrics, logs, more failure scenarios, load tests
- [ ] Milestone E — public demo
- [ ] Milestone F — deployment and case study
