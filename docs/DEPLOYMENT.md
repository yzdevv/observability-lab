# Deployment

## Repository layout

```
observability-lab/
├── apps/
│   ├── web/            # Vite + React SPA (served by lab-web nginx)
│   ├── gateway/        # Node 24 + Fastify
│   ├── order-node/     # Node 24: API + worker (same image)
│   └── order-go/       # Go 1.26: API, worker and fake payment provider (MODE=api|worker|payment)
├── packages/telemetry/ # shared OTel setup for the Node services (traces, metrics, logs, cgroup)
├── db/init/            # schema + seed SQL
├── infra/
│   ├── compose.yaml          # base: all services, limits, lab network, no host ports
│   ├── compose.dev.yaml      # Mac: gateway on 127.0.0.1:8088, Grafana on 127.0.0.1:3000
│   ├── compose.homelab.yaml  # server: cgroup_parent slice, shared networks, bind mounts
│   ├── node.Dockerfile       # shared by gateway and order-node (ARG APP)
│   ├── web.Dockerfile        # SPA build + nginx (lab-web)
│   ├── web-nginx.conf
│   ├── otel-collector.yaml
│   ├── tempo.yaml
│   ├── prometheus.yaml
│   ├── loki.yaml
│   ├── grafana/              # provisioned datasources + dashboards
│   └── host/homelab-lab.slice
├── tests/contract/     # same tests against node and go (API contract + traces in Tempo)
├── load/orders.js      # k6 profile (steady, stepped, mixed, direct-to-API)
├── experiments/        # one folder per experiment: run.sh, analyse.ts, results/
├── scripts/            # smoke.sh, experiment.sh, record-demo.ts, trace-stats.ts, waterfall.ts, lib/
└── docs/
```

## Local development (Mac)

Requirements: Docker Desktop, Node 24, pnpm, Go 1.26.

```sh
docker compose -f infra/compose.yaml -f infra/compose.dev.yaml up -d --build
pnpm install                  # once, for the contract tests and typecheck
./scripts/smoke.sh            # creates an order via node and go, waits for completed
pnpm test:contract            # API contract + end-to-end traces, against both implementations
pnpm typecheck                # Node services; for Go: (cd apps/order-go && go vet ./...)
```

The dev override raises the per-IP rate limit (300/min) and the host-load threshold (16) so tests
and a busy Mac do not trip the guards.

- Public page (lab-web, production build): `http://127.0.0.1:8090`
- Gateway: `http://127.0.0.1:8088`
- Grafana: `http://127.0.0.1:3000` (anonymous admin in dev only) → Explore → Tempo; paste the
  `X-Trace-Id` from a gateway response, or search by `order.id` / `lab.scenario`
- Grafana dashboard: Dashboards → Observability Lab → Lab overview
- Tempo API: `http://127.0.0.1:3200` (used by the tracing tests)
- Prometheus: `http://127.0.0.1:9090`, Loki: `http://127.0.0.1:3100` (used by experiment analysis)
- SPA dev server with hot reload: `pnpm --filter @lab/web dev` → `http://127.0.0.1:5173` (proxies
  `/api` to the gateway; `GATEWAY_URL=http://127.0.0.1:9` shows the offline mode)
- Offline recordings: `node scripts/record-demo.ts` (writes `apps/web/public/recorded/runs.json`;
  rebuild lab-web afterwards)

The Mac is arm64 and the server amd64, so images are built on the server, as for Kelasin.

## Homelab deployment

Follows the homelab conventions: Compose project under `/opt/homelab/compose/observability-lab`,
no host ports, NPM proxy hosts for LAN names, the Cloudflare tunnel for the public name.

### One-time setup

1. Install the slice (sudo, user):
   ```sh
   sudo cp homelab-lab.slice /etc/systemd/system/ && sudo systemctl daemon-reload
   ```
   (`scripts/deploy.sh` refuses to run without it.)
2. NPM proxy hosts (user): `lab.home.arpa → lab-web:8080`, `grafana.home.arpa → grafana:3000`.
3. Cloudflare tunnel routes (user), in this order:
   - `lab.mge.my.id`, path `^/(e|j\.js|j\.[0-9a-f]{10}\.js)$` → `http://jejak-collector:8081`
   - `lab.mge.my.id` → `http://lab-web:8080`
4. Jejak site "Observability Lab" (`7peh69j4`, events `send_order` and `outbound`, goal "Send
   order"): created. lab-web's nginx answers the tracker paths with 404, so LAN visits are not
   counted.
5. Uptime Kuma (created): #40 page, #41 gateway + order APIs, #42 Grafana (containers group);
   #43 `lab.home.arpa`, #44 public `/api/health` keyword, #45 Jejak script (DNS + proxy group).
   All live since 2026-11-23.

Data directories (`/opt/homelab/lab-data/observability-lab/*`, outside the nightly backup set) and
the server `.env` are created by the deploy script; no sudo needed.

### Each deploy

```sh
scripts/deploy.sh          # asks if the working tree has uncommitted changes; --yes skips that
```

1. Checks the slice, rsyncs the repo to the server (no `.git`, `node_modules`, results).
2. Creates `.env` on first run (random DB password, `LAB_ENV=homelab`) and sets the Grafana admin
   password from the Mac Keychain (`security find-generic-password -a admin -s
   homelab-observability-grafana -w`), sent over stdin.
3. Validates the nginx config, builds on the server (amd64), `up -d --wait`.
4. Smoke-checks `/healthz` and `/api/health` through lab-web, prints the slice's usage.

### Testing the homelab copy from the Mac

```sh
scripts/homelab-tunnel.sh --relax   # SSH-forwards 8088/8090/3200/9090/3100/3000 to the lab
./scripts/smoke.sh && pnpm test:contract
node scripts/record-demo.ts --where "Homelab server (old laptop, Intel i5-8250U), Docker"
```

The tunnel uses the same loopback ports as the dev stack, so every script works unchanged.
`--relax` lifts the per-IP order limit to 300/min while it is open (all tunnelled requests share
one address) and puts it back on exit. First homelab run, 2026-11-23: 29/29 contract tests pass.

### Rollback

`docker compose -p observability-lab down` stops only the lab; nothing else depends on it.
Telemetry data can be deleted freely. Remove the slice, NPM hosts, tunnel routes and Kuma
monitors to fully undo.

### Homelab repo

Copies of the compose files, nginx config and slice are in the homelab config repo
(`compose/observability-lab/`, `host/systemd/homelab-lab.slice`). Refresh them after changing
`infra/`.

## Operational notes

- Server reboots and power cuts take the lab down with everything else; the public page shows the
  recorded runs while the gateway is unreachable.
- The nightly backup stops the lab containers briefly (03:00 WIB); expected.
- If the lab misbehaves, `docker compose -p observability-lab stop` is always safe.
