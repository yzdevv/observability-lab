#!/usr/bin/env bash
# Experiment 1: slow database. See docs/EXPERIMENTS.md for the question and the write-up.
#
# Part A, baseline vs degraded: 4 req/s steady (30 s warm-up + 60 s measured), scenarios none and
#   slow-db, both implementations, 3 rounds, interleaved so drift affects every configuration alike.
# Part B, slow-db under rising load: steps of 10 → 50 req/s, 30 s each, both scenarios and both
#   implementations; shows what a slow query does to the connection pool and the gateway guards.
#
# Usage: experiments/01-slow-db/run.sh <results-dir> [a|b|all]
#   then:  node experiments/01-slow-db/analyse.ts <results-dir>
#
# Part B needs more than the dev per-IP rate limit (300/min), so it restarts the dev gateway with
# RATE_LIMIT_PER_MIN raised and restores it afterwards. The in-flight and load guards stay as is.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${1:?usage: run.sh <results-dir> [a|b|all]}"
part="${2:-all}"
compose=(docker compose -f "$root/infra/compose.yaml" -f "$root/infra/compose.dev.yaml")
run() { "$root/scripts/experiment.sh" "$@"; }

if [[ $part == a || $part == all ]]; then
  for round in 1 2 3; do
    for impl in node go; do
      for scenario in none slow-db; do
        run "$out/a/round$round-$impl-$scenario" "$impl" "$scenario" RATE=4 WARMUP=30s DURATION=60s
      done
    done
  done
fi

if [[ $part == b || $part == all ]]; then
  restore() { "${compose[@]}" up -d --wait gateway >/dev/null 2>&1 || true; }
  trap restore EXIT
  RATE_LIMIT_PER_MIN=100000 "${compose[@]}" up -d --wait gateway >/dev/null
  for impl in node go; do
    for scenario in none slow-db; do
      run "$out/b/$impl-$scenario" "$impl" "$scenario" STAGES=10:30s,20:30s,30:30s,40:30s,50:30s WARMUP=15s
      sleep 20   # let backlog and pools drain before the next profile
    done
  done
fi
