#!/usr/bin/env bash
# Experiment 6: what does the telemetry cost? Same traffic (40 req/s, scenario none, 40 s after a
# 15 s settle) through each implementation under four settings, 3 interleaved rounds:
#   access-logs        per-request access logs on (stdout + OTLP), metrics + logs exported
#   no-access-logs     the default since Milestone D: warnings/errors/business logs only
#   traces-only        no metrics, no OTLP logs
#   gateway-0.5cpu     no-access-logs with the gateway at its old 0.5 CPU limit
# CPU = Docker API cumulative CPU per container before/after the k6 run (works with metrics off).
# See docs/EXPERIMENTS.md.
# Usage: experiments/06-telemetry-cost/run.sh <results-dir> [rounds], then analyse.ts <results-dir>
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
out="${1:?usage: run.sh <results-dir> [rounds]}"
rounds="${2:-3}"
apps=(gateway order-api-node worker-node order-api-go worker-go fake-payment)
"${compose[@]}" build >/dev/null
trap 'RATE_LIMIT_PER_MIN= LOG_REQUESTS= OTEL_LOGS_EXPORTER= OTEL_METRICS_EXPORTER= GATEWAY_CPUS= "${compose[@]}" up -d --wait "${apps[@]}" >/dev/null 2>&1 || true' EXIT

variant() {
  local round="$1" name="$2"; shift 2
  env RATE_LIMIT_PER_MIN=1000000 "$@" "${compose[@]}" up -d --wait "${apps[@]}" >/dev/null
  sleep 15   # let new processes settle (JIT, pools) before measuring
  for impl in node go; do
    run "$out/$name/round$round-$impl" "$impl" none RATE=40 DURATION=40s WARMUP=0s
    drain
  done
}
for round in $(seq 1 "$rounds"); do
  variant "$round" 1-access-logs      LOG_REQUESTS=true  OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp GATEWAY_CPUS=1.0
  variant "$round" 2-no-access-logs   LOG_REQUESTS=false OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp GATEWAY_CPUS=1.0
  variant "$round" 3-traces-only      LOG_REQUESTS=false OTEL_LOGS_EXPORTER=none OTEL_METRICS_EXPORTER=none GATEWAY_CPUS=1.0
  variant "$round" 4-gateway-0.5cpu   LOG_REQUESTS=false OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp GATEWAY_CPUS=0.5
done
