# Observability Lab — docs

> Send a request. Trace its journey. Break the system. Find the bottleneck.

A small order-processing system, built twice (Node.js and Go), instrumented end to end with
OpenTelemetry, with controlled failure scenarios and a public demo page at `lab.mge.my.id`.
It runs on the homelab server next to production sites, inside a strict resource budget.

Purpose: a portfolio piece for `dev.mge.my.id` that shows prospective clients
"I can build distributed services, instrument them, reproduce failures, find bottlenecks,
and prove improvements with measured evidence."

| Doc | What it covers |
|---|---|
| [PLAN.md](PLAN.md) | Goals, decisions made, milestones with definition of done |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Services, request flow, Node vs Go design, telemetry pipeline, network exposure |
| [API-CONTRACT.md](API-CONTRACT.md) | HTTP endpoints, queue message format, database schema — the contract both implementations follow |
| [RESOURCE-BUDGET.md](RESOURCE-BUDGET.md) | How the lab is kept from hurting other projects: cgroup slice, container limits, gateway guards, retention |
| [EXPERIMENTS.md](EXPERIMENTS.md) | Failure scenarios, how comparisons are made fair, load and trace-analysis tooling, recorded results |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Local development and homelab deployment steps |

Status (2026-11-22): Milestones A–C done (core services in Node + Go, guards, end-to-end tracing, slow-database experiment with recorded results). Next: Milestone D, metrics, logs and more scenarios.
