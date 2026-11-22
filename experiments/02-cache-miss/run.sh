#!/usr/bin/env bash
# Experiment 2: what does the product cache save? none vs cache-miss at 10, 25 and 50 req/s,
# both implementations, through the gateway. See docs/EXPERIMENTS.md.
# Usage: experiments/02-cache-miss/run.sh <results-dir>, then analyse.ts <results-dir>
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
out="${1:?usage: run.sh <results-dir>}"
lift_rate_limit
for impl in node go; do
  for scenario in none cache-miss; do
    run "$out/$impl-$scenario" "$impl" "$scenario" STAGES=10:30s,25:30s,50:30s WARMUP=15s
    drain
  done
done
