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

## Results

None yet.

## Observations to follow up

- **Gateway → order API gap (Milestone B)**: in a Go `slow-db` trace the gateway's HTTP client span
  starts ~16 ms after the guards finish, and the order API's server span starts ~24 ms after that.
  Candidates: connection setup in undici (no keep-alive pool warm yet), Docker DNS, event-loop delay.
  Good first investigation for Milestone C.
