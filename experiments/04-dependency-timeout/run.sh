#!/usr/bin/env bash
# Experiment 4: does a timeout + circuit breaker protect the API when a dependency hangs?
# 10 req/s normal orders + 40 req/s dependency-timeout at the same time for 3 minutes (three outage
# windows of the degraded payment provider), breaker on vs off, both implementations.
# See docs/EXPERIMENTS.md.
# Usage: experiments/04-dependency-timeout/run.sh <results-dir>, then analyse.ts <results-dir>
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
out="${1:?usage: run.sh <results-dir>}"
lift_rate_limit
profile=(MIX=none:10,dependency-timeout:40 DURATION=180s WARMUP=0s OUTAGE_CYCLE_S=60 OUTAGE_S=30)
for impl in node go; do
  for breaker in on off; do
    if [[ $breaker == off ]]; then with_env BREAKER_ENABLED=false "order-api-$impl"; fi
    run "$out/$impl-breaker-$breaker" "$impl" mix "${profile[@]}"
    if [[ $breaker == off ]]; then with_env BREAKER_ENABLED=true "order-api-$impl"; fi
    drain
  done
done
