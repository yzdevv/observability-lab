# Resource budget and guards

The lab shares a laptop server with production sites (FinTrack, Kelasin, portfolio, Mak Three,
Jejak, DoneLog). Rule: **the lab may slow itself down, never them.**

Server snapshot (2026-11-21): 8 threads, 18 GiB RAM (1.5 GiB used by all 16 existing containers),
216 GB disk (178 GB free), Docker cgroup driver `systemd`, cgroup v2.

Protection is layered, from the kernel up.

## Layer 1 — one systemd slice for the whole lab

Every lab container runs under `homelab-lab.slice` (Compose `cgroup_parent`, server override only).
The kernel enforces the total, whatever the containers do.

`/etc/systemd/system/homelab-lab.slice`:

```ini
[Unit]
Description=Observability Lab resource budget

[Slice]
CPUQuota=200%       # at most 2 of 8 threads, total
CPUWeight=50        # under contention, production (default 100) wins
MemoryHigh=2560M    # start reclaiming / throttling here
MemoryMax=3G        # hard ceiling for the whole lab
IOWeight=50         # disk: production first
TasksMax=1024
```

Install: copy the file, `sudo systemctl daemon-reload`. Check live usage with
`systemd-cgtop homelab-lab.slice`.

## Layer 2 — per-container limits

Every service has `mem_limit`, `cpus`, `pids_limit`, `cpu_shares: 256` (default is 1024) and
`no-new-privileges`. Planned budget:

| Service | Memory | CPUs |
|---|---|---|
| postgres | 256m | 0.75 |
| redis | 64m | 0.25 |
| gateway | 128m | 0.5 |
| order-api-node | 128m | 0.5 |
| worker-node | 128m | 0.5 |
| order-api-go | 64m | 0.5 |
| worker-go | 64m | 0.5 |
| otel-collector | 192m | 0.5 |
| tempo | 512m | 0.5 |
| prometheus | 384m | 0.5 |
| loki | 384m | 0.5 |
| grafana | 256m | 0.5 |
| lab-web | 32m | 0.25 |
| **Sum of limits** | **~2.6 GB** | |

The per-container CPU limits add up to more than 2 on purpose; the slice caps the total. Node and
Go get identical limits so comparisons are fair.

## Layer 3 — application guards (gateway)

Checked in order on every `POST /api/{impl}/orders`. Refusals are visible in the SPA and in
telemetry ("load shedding" is itself part of the demo).

| Guard | Default | Response |
|---|---|---|
| Per-IP rate limit (`CF-Connecting-IP`) | 20 requests / minute | `429` |
| Global in-flight requests | 20 | `503 reason=inflight` |
| Host load (`/proc/loadavg`, 1-min) | > 4.0 (half the threads) | `503 reason=host-load` |
| Queue backlog (pending + lag of the chosen stream) | > 500 | `503 reason=backlog` |
| Upstream timeout | 5 s | `504` |
| Request body | 4 KB | `413` |

The host-load guard reads the whole server's load, so the lab backs off when *production* is busy,
not only when the lab is. Load and backlog are cached for 1–2 s to keep the guards cheap. All values
are environment variables.

"Compare" mode in the SPA counts as two requests. Bursts (e.g. "send 20") are capped server-side.

## Layer 4 — data and storage limits

| Data | Limit |
|---|---|
| Traces (Tempo) | 48 h retention |
| Metrics (Prometheus) | 7 d retention, plus a size cap (`--storage.tsdb.retention.size=1GB`) |
| Logs (Loki) | 3 d retention |
| Redis | `maxmemory 48mb`, no persistence |
| Streams | `MAXLEN ~ 10000` each |
| Orders table | periodic reset deletes old demo orders |
| Postgres | `shared_buffers=64MB`, `max_connections=50`; each service pool max 10 |
| Container logs | Docker daemon default on the server: json-file 10m × 3 |

Metric cardinality is kept low: labels are service, route template, status code, impl and scenario,
never order IDs or IPs.

## Layer 5 — backups

The nightly `homelab-backup` stops containers and tars every **named volume**. Telemetry data
(Tempo, Prometheus, Loki) is disposable and would bloat every backup and the Google Drive upload.

- Telemetry storage uses **bind mounts** under `/opt/homelab/lab-data/observability-lab/`, which the
  backup does not include.
- Postgres demo data is also disposable; it uses a bind mount there too.
- Only the compose project and config (in `/opt/homelab/compose/observability-lab`) are backed up.

## Load tests

- k6 runs from the Mac over the LAN against the gateway, never through the Cloudflare tunnel.
- Scheduled for quiet hours; the gateway's host-load guard still applies to public traffic during
  the run.
- Ramp limits are written in the k6 script; a run that would exceed the slice is the point of the
  experiment, not an accident.

## Monitoring the budget

- Uptime Kuma: lab web, gateway health, Grafana (LAN).
- Grafana panel: lab slice CPU/memory (from cAdvisor or node exporter, if added) vs limits.
- Telegram alert if the lab is OOM-killed repeatedly (Kuma sees the service go down).
