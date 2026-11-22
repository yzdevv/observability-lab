#!/usr/bin/env bash
# Experiment 3: are retries and recovery visible? worker-retry (fails twice, then succeeds) vs none
# at 5 req/s for 60 s, both implementations. See docs/EXPERIMENTS.md.
# Usage: experiments/03-worker-retry/run.sh <results-dir>, then analyse.ts <results-dir>
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
out="${1:?usage: run.sh <results-dir>}"
for impl in node go; do
  for scenario in none worker-retry; do
    run "$out/$impl-$scenario" "$impl" "$scenario" RATE=5 DURATION=60s WARMUP=10s
    sleep 5   # let the last retries finish (backoff 0.5 s + 1 s)
  done
done
