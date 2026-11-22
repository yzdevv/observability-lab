#!/usr/bin/env bash
# Experiment 5: Node vs Go under load. k6 calls each order API directly (no gateway, so its guards
# and CPU do not decide the result), scenario none, 50 → 400 req/s in 30 s steps. Identical
# container limits (0.5 CPU, 128 MiB), same Postgres and Redis. Also records cold start and image
# size (container start → listening). See docs/EXPERIMENTS.md.
# Usage: experiments/05-node-vs-go/run.sh <results-dir>, then analyse.ts <results-dir>
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
out="${1:?usage: run.sh <results-dir>}"
mkdir -p "$out"
for impl in node go; do
  # Cold start: container start → the app's own "listening" log line (Docker's first health
  # check only runs after its 10 s interval, so it cannot measure this).
  name="observability-lab-order-api-$impl-1"
  docker restart "$name" >/dev/null
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ]; do sleep 0.5; done
  started=$(docker inspect -f '{{.State.StartedAt}}' "$name")
  listening=$(docker logs --timestamps --since "$started" "$name" 2>&1 | grep -m1 -i 'listening' | awk '{print $1}')
  secs=$(python3 -c "
from datetime import datetime
p=lambda s: datetime.fromisoformat(s.rstrip('Z')[:26])
print(round((p('$listening')-p('$started')).total_seconds(), 3))")
  image=$(docker inspect -f '{{.Image}}' "$name")
  echo "{\"impl\":\"$impl\",\"startToListeningS\":$secs,\"imageBytes\":$(docker image inspect -f '{{.Size}}' "$image")}" >"$out/$impl-startup.json"
  sleep 20
  p=8081; [[ $impl == go ]] && p=8082
  K6_NETWORK=observability-lab_lab run "$out/$impl-none" "$impl" none TARGET=api BASE_URL="http://order-api-$impl:$p" \
    STAGES=50:30s,100:30s,200:30s,300:30s,400:30s WARMUP=15s
  drain
done
