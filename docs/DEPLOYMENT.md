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
│   ├── otel-collector.yaml
│   ├── tempo.yaml
│   ├── prometheus.yaml
│   ├── loki.yaml
│   ├── grafana/              # provisioned datasources + dashboards
│   └── host/homelab-lab.slice
├── tests/contract/     # same tests against node and go (API contract + traces in Tempo)
├── load/orders.js      # k6 profile (steady, stepped, mixed, direct-to-API)
├── experiments/        # one folder per experiment: run.sh, analyse.ts, results/
├── scripts/            # smoke.sh, experiment.sh, trace-stats.ts, waterfall.ts, lib/
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

- Gateway: `http://127.0.0.1:8088`
- Grafana: `http://127.0.0.1:3000` (anonymous admin in dev only) → Explore → Tempo; paste the
  `X-Trace-Id` from a gateway response, or search by `order.id` / `lab.scenario`
- Grafana dashboard: Dashboards → Observability Lab → Lab overview
- Tempo API: `http://127.0.0.1:3200` (used by the tracing tests)
- Prometheus: `http://127.0.0.1:9090`, Loki: `http://127.0.0.1:3100` (used by experiment analysis)
- SPA dev server: `pnpm --filter web dev` (proxies `/api` to the gateway)

The Mac is arm64 and the server amd64, so images are built on the server, as for Kelasin.

## Homelab deployment

Follows the homelab conventions: Compose project under `/opt/homelab/compose/<app>`, no host
ports, NPM proxy host for LAN names, Cloudflare tunnel for the public name.

### One-time setup (user runs the sudo parts)

1. Install the slice:
   ```sh
   sudo cp infra/host/homelab-lab.slice /etc/systemd/system/
   sudo systemctl daemon-reload
   ```
2. Create bind-mount directories outside the backup set:
   ```sh
   sudo mkdir -p /opt/homelab/lab-data/observability-lab/{postgres,tempo,prometheus,loki,grafana}
   sudo chown -R yzdev: /opt/homelab/lab-data/observability-lab
   ```
   (each service's directory is then chowned to that image's uid)
3. NPM proxy hosts (user adds): `lab.home.arpa → lab-web:80`, `grafana.home.arpa → grafana:3000`.
4. Cloudflare tunnel route (user adds): `lab.mge.my.id → http://lab-web:80`.
5. Jejak site for `lab.mge.my.id` + tunnel path route for `/j.js` and `/e` → `jejak-collector:8081`,
   above the lab-web catch-all.
6. Kuma monitors: lab-web, gateway health, public keyword check, Grafana (LAN).

### Each deploy

`scripts/deploy.sh` (to be written, modelled on Kelasin's):

1. rsync the repo to `yzserver:/opt/homelab/compose/observability-lab` (excluding `node_modules`,
   build output, local env files).
2. On the server: validate the nginx config, then
   `docker compose -f infra/compose.yaml -f infra/compose.homelab.yaml up -d --build`.
3. Wait for health checks; print `systemd-cgtop`-style usage of the lab slice.
4. Run the smoke script against the gateway through `lab-web`.

Secrets (`LAB_DB_PASSWORD`, Grafana admin password) live in a server-side `.env` (mode 600, not in
git), written once by the user.

### Rollback

`docker compose … down` stops only the lab; nothing else depends on it. Telemetry data can be
deleted freely. Remove the slice file and tunnel route to fully undo.

### Homelab repo

Copy the compose files and slice into the homelab config repo (`compose/observability-lab/`,
`host/`) after the first deploy, and note the lab in the homelab notes.

## Operational notes

- Server reboots and power cuts take the lab down with everything else; the public page shows the
  recorded runs while the gateway is unreachable.
- The nightly backup stops the lab containers briefly (03:00 WIB); expected.
- If the lab misbehaves, `docker compose -p observability-lab stop` is always safe.
