# Experiments

Each experiment answers one question with evidence. Recorded results feed the case study and the
offline fallback on the public page.

## Method

1. **Baseline**: scenario `none`, fixed traffic, record p50 / p95 / p99 latency, throughput,
   error rate, and representative traces.
2. **Degraded**: same traffic, one scenario switched on.
3. **Find it from telemetry alone**: start from the RED dashboard, drill into a slow trace, name
   the culprit span, confirm with logs.
4. **Improve** (where it applies): change code or config, re-run, compare with the baseline.
5. **Record**: numbers, screenshots, trace IDs, and what was learned — including surprises.

Rules for fair numbers:
- Same machine state: no deploys or backups during a run; note the host load.
- Warm-up period discarded (first 30 s).
- At least 3 runs per configuration; report the median run.
- Node and Go measured with identical container limits and traffic.
- k6 from the Mac over the LAN; note the 100 Mbps link.

## Planned experiments

### 1. Slow database (`slow-db`)
- **Question**: can a slow query be found from the trace alone?
- **Injection**: order `INSERT` takes +300 ms (`SLOW_DB_MS`).
- **Expected**: `order.persist` / the `INSERT` span dominates the waterfall; p95 rises by about
  300 ms; worker timing unchanged.
- **Evidence**: waterfall before/after, p95 chart.

### 2. Cache efficiency (`cache-miss`)
- **Question**: what does the product cache actually save?
- **Injection**: skip the Redis read on every request.
- **Expected**: an extra Postgres `SELECT` span per request; small latency rise at low traffic, larger
  under load as the DB pool queues.
- **Evidence**: span count per trace, DB query rate, latency at 10 / 50 / 100 RPS.

### 3. Worker retry (`worker-retry`)
- **Question**: are retries and recovery visible?
- **Injection**: processing fails twice, succeeds on the third attempt.
- **Expected**: one trace with three `order.process` attempts (error, error, ok), `attempts = 3` on
  the order, error logs linked to the trace.
- **Evidence**: trace with retry spans, logs panel, time-to-complete.

### 4. Dependency timeout (`dependency-timeout`)
- **Question**: does a timeout + circuit breaker protect the API when a dependency hangs?
- **Injection**: fake dependency answers slowly; API call has a timeout.
- **Expected**: without breaker, p95 equals the timeout and in-flight requests pile up; with breaker,
  requests fail fast while open, then recover (half-open → closed).
- **Evidence**: latency and error-rate charts across the open/close cycle, breaker state metric.

### 5. Node vs Go under load
- **Question**: where do the runtimes actually differ for this workload?
- **Method**: same k6 ramp against `/api/node` and `/api/go`, identical limits.
- **Measure**: throughput at the knee, p95/p99, memory (RSS), CPU, cold start time, image size.
- **Expected**: similar at low load (Postgres dominates); differences in memory, tail latency and the
  saturation point. Report what is measured, even if the difference is small.

### 6. Queue backlog and load shedding
- **Question**: what happens when producers outrun the worker?
- **Method**: scale worker work time up, push traffic, watch backlog grow until the gateway's
  backlog guard sheds load.
- **Evidence**: backlog chart, `503 reason=backlog` rate, recovery time.

## Result template

```markdown
## <Experiment name> — <date>

**Question:**
**Setup:** commit, impl(s), scenario, traffic profile, host load at start

| Metric | Baseline | Degraded | Improved |
|---|---|---|---|
| p50 | | | |
| p95 | | | |
| p99 | | | |
| Throughput (req/s) | | | |
| Error rate | | | |

**How it was found:** dashboard → trace → span → log (with trace IDs)
**Screenshots:**
**What we learned:**
**Trade-offs / follow-ups:**
```

## Tooling

| Tool | What it does |
|---|---|
| `load/orders.js` | k6 profile: steady (`RATE`) or stepped (`STAGES=10:30s,20:30s`) arrival rate, discarded warm-up, per-step latency, status counts and exact time windows in `summary.json` |
| `scripts/experiment.sh` | Runs k6 in Docker (`grafana/k6:2.3.0`), records lab guard status before/after and `docker stats` every 10 s |
| `scripts/trace-stats.ts` | Finds every trace of one implementation + scenario in a time window (TraceQL) and ranks spans by self time, i.e. names the culprit from telemetry alone |
| `scripts/waterfall.ts` | Prints one trace as a text waterfall |
| `experiments/<n>/run.sh`, `analyse.ts` | Runs an experiment end to end; writes `report.md`, `report.json` and saves example traces as JSON (Tempo keeps traces for 48 h) |

Tempo runs with half a CPU, where a trace-by-id lookup takes seconds. `trace-stats` therefore
fetches all spans of a window with one TraceQL search per 5 s chunk
(`{ <filter> } && { true } | select(span:name, span:parentID, resource.service.name, span:kind)`),
which returns structure and timing for ~250 traces in a few seconds.

## Results

### 1. Slow database — 2026-11-22 (Mac, Docker Desktop)

**Question:** can a slow query be found from the trace alone, and what does it cost beyond its own
300 ms?

**Setup:** load tooling and services at commit `b888911`, both implementations, scenarios `none` and
`slow-db` (`SLOW_DB_MS=300`), identical container limits, DB pool 10 per API. k6 in Docker on the
same Mac against the dev gateway. Part A: 4 req/s, 30 s warm-up + 60 s measured, 3 interleaved
rounds, median run by p95. Part B: 10 → 50 req/s in 30 s steps, gateway rate limit lifted, in-flight
guard (20) left on. Raw data, full tables and saved traces:
[`experiments/01-slow-db/results/mac-2026-11-22/`](../experiments/01-slow-db/results/mac-2026-11-22/report.md).
These are Mac numbers; the homelab re-run is part of Milestone F.

#### Part A — baseline vs degraded (4 req/s)

| Metric (k6, client side) | Node none | Node slow-db | Go none | Go slow-db |
|---|---|---|---|---|
| p50 | 11.3 ms | 316.4 ms | 9.8 ms | 314.3 ms |
| p95 | 21.3 ms | 329.3 ms | 18.2 ms | 324.2 ms |
| p99 | 39.7 ms | 344.8 ms | 25.8 ms | 330.0 ms |
| p95 range over 3 runs | 19.7–21.5 | 328.3–330.2 | 17.0–18.8 | 323.1–338.3 |
| Throughput | 4 req/s | 4 req/s | 4 req/s | 4 req/s |
| Error rate | 0 / 722 | 0 / 722 | 0 / 721 | 0 / 723 |

Degradation: p50 +305 ms (Node) / +305 ms (Go), p95 +308 / +306 ms: the injected 300 ms plus a
few ms, nothing else moves.

**How it was found (telemetry only):** `trace-stats` over every trace of the median slow-db run
(241 Node, 240 Go) ranks the `INSERT` span first by self time: **305 ms, 98 % of the median
response** in both languages. Next in line is the gateway at ~2 ms. The worker's timing is
unchanged (`order.fulfil` ~21 ms), as expected: the slow part is before the queue.

```
a-go-slow-db-typical  total 331.6 ms, response 310.6 ms
POST /api/:impl/orders  gateway         310.6 ms  |█████████████████████████████████████████████   |
  gateway.guards        gateway           0.0 ms  |█                                               |
  POST                  gateway         308.8 ms  |█████████████████████████████████████████████   |
    POST /orders        order-api-go    307.1 ms  |████████████████████████████████████████████    |
      product.lookup    order-api-go      0.3 ms  |█                                               |
      order.persist     order-api-go    304.9 ms  |████████████████████████████████████████████    |
        pool.acquire    order-api-go      0.0 ms  |█                                               |
        INSERT          order-api-go    304.7 ms  |████████████████████████████████████████████    |
      order.enqueue     order-api-go      1.6 ms  |                                            █   |
        order.process   worker-go        22.6 ms  |                                            ███ |
```

#### Part B — the same slow query under rising load

| Target req/s | Node accepted/s | Node p50 / p95 | Node pool wait p50 | Go accepted/s | Go p50 / p95 | Go pool wait p50 | 503 (Node / Go) |
|---|---|---|---|---|---|---|---|
| 10 | 10.0 | 311 / 342 ms | 0 ms | 10.0 | 310 / 317 ms | 0 ms | 0 / 0 |
| 20 | 20.0 | 308 / 318 ms | 0 ms | 20.0 | 307 / 318 ms | 0 ms | 0 / 0 |
| 30 | 30.0 | 306 / 410 ms | 0 ms (p95 55) | 30.0 | 305 / 361 ms | 0 ms | 0 / 0 |
| 40 | **33.3** | 544 / 604 ms | **243 ms** | **33.3** | 574 / 606 ms | **273 ms** | 203 / 201 |
| 50 | **33.0** | 522 / 601 ms | **245 ms** | **33.1** | 558 / 604 ms | **267 ms** | 510 / 508 |

Without the slow query, both implementations take 50 req/s at p50 3–4 ms with no pool wait.

At low load the slow query costs exactly its own 300 ms. But it also holds one of the 10 pool
connections for 300 ms, so each API can finish at most 10 / 0.3 s ≈ **33 orders/s**, and that is
exactly where both implementations flatten out. Past that point:

- The **INSERT span still reads ~302 ms**. Looking at the query alone would say "nothing got worse".
- A second span grows: the wait for a pool connection (`pool.acquire` in Go, `pg-pool.connect` in
  Node) jumps from 0 to ~250–270 ms. Response time roughly doubles to ~550–600 ms.
- The gateway's in-flight guard (20 concurrent) turns the excess into fast `503`s instead of an
  ever-growing queue. Accepted throughput stays at 33/s and latency stays bounded at ~600 ms.

```
b-go-slow-db-50rps-slowest  total 696.1 ms, response 674.7 ms
POST /api/:impl/orders  gateway         674.7 ms  |███████████████████████████████████████████████ |
  POST                  gateway         673.9 ms  |██████████████████████████████████████████████  |
    POST /orders        order-api-go    572.5 ms  |       ███████████████████████████████████████  |
      order.persist     order-api-go    571.9 ms  |       ███████████████████████████████████████  |
        pool.acquire    order-api-go    270.4 ms  |       ███████████████████                      |
        INSERT          order-api-go    301.4 ms  |                         █████████████████████  |
```

**What we learned:**
- A slow query is trivial to find in a trace (98 % of the response in one span). The interesting
  part is its second-order cost: it turns the connection pool into the bottleneck. Only a trace
  that also records the pool wait shows that. Node needed `instrumentation-pg`'s connect spans
  turned on for this (they were off in Milestone B).
- Node and Go behave the same here: the limit is Postgres connections × query time, not the
  runtime. Node vs Go differences belong in experiment 5 (CPU-bound load), not in this one.
- The in-flight guard works as designed: overload becomes 503s with `reason=inflight`, and
  accepted requests keep a bounded latency.

**Trade-offs / follow-ups:**
- Raising the pool size moves the ceiling (20 connections ≈ 66/s) but costs Postgres memory and
  only hides the slow query. The fix is the query itself. A per-request DB timeout would bound the
  damage.
- **CPU throttling (for Milestone D):** both `none` runs show p99 spikes of 100–380 ms and a
  ~100 ms gap between the gateway's client span and the API's server span in the slowest traces.
  The gateway is capped at `cpus: 0.25`; its cgroup shows 489 throttled periods out of 1314 (33 s
  throttled) over the part B runs, and `order-api-node` 713 periods (53 s). CFS throttling stalls
  a process for the rest of a 100 ms period, which matches the size of the spikes. Next: put
  `cpu.stat` throttling into the metrics (Milestone D) and decide whether the gateway needs 0.5 CPU.


## Observations to follow up

- **Gateway → order API gap (Milestone B, checked in C)**: the ~40 ms gap seen in Milestone B was a
  cold start: it appeared only on the first request after the stack had been idle for 16 h (the
  first request through each path also paid for new Postgres connections, `pg.connect` ~29 ms).
  Warm requests show ~1 ms between the gateway's client span and the API's server span. When
  undici's keep-alive connection has expired (default 4 s idle), the next request pays ~3–5 ms for a
  new TCP connection. Not worth a change at demo traffic; a longer `keepAliveTimeout` would remove
  it.
- **CPU throttling under load (Milestone C)**: see experiment 1 follow-ups.
