#!/usr/bin/env bash
# Run one k6 load profile against the gateway and record everything needed to analyse it later:
# the k6 summary, the measured time window (for Tempo), host load and container usage.
#
# Usage: scripts/experiment.sh <out-dir> <impl> <scenario> [KEY=VALUE ...]
#   KEY=VALUE pairs go to k6 (RATE, WARMUP, DURATION, STAGES, BASE_URL; see load/orders.js).
# Example:
#   scripts/experiment.sh experiments/01-slow-db/results/run1-go-none go none RATE=4
#
# Needs Docker (k6 runs in the grafana/k6 image) and the gateway reachable from a container.
# STATUS_URL is read from the host to note the lab's guard state (default the dev gateway).
# K6_NETWORK puts k6 on a Docker network (e.g. observability-lab_lab) to call services directly.
set -euo pipefail

K6_IMAGE="${K6_IMAGE:-grafana/k6:2.3.0}"
STATUS_URL="${STATUS_URL:-http://127.0.0.1:8088/api/lab/status}"

[ $# -ge 3 ] || { sed -n '2,10p' "$0"; exit 2; }
out="$1" impl="$2" scenario="$3"
shift 3
mkdir -p "$out"
out="$(cd "$out" && pwd)"
root="$(cd "$(dirname "$0")/.." && pwd)"

envs=(-e "IMPL=$impl" -e "SCENARIO=$scenario")
for kv in "$@"; do envs+=(-e "$kv"); done

iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
lab_status() { curl -fsS --max-time 3 "$STATUS_URL" 2>/dev/null || echo null; }

# Sample container CPU/memory every 10 s while k6 runs.
stats_file="$out/docker-stats.jsonl"
: >"$stats_file"
(
  while true; do
    docker stats --no-stream --format '{"t":"{{json .Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}"}' 2>/dev/null |
      sed "s/\"t\":\"\"\\(.*\\)\"\"/\"name\":\"\\1\",\"at\":\"$(iso)\"/" >>"$stats_file" || true
    sleep 10
  done
) &
stats_pid=$!
trap 'kill $stats_pid 2>/dev/null || true' EXIT

status_before="$(lab_status)"
cpu_before="$(node "$root/scripts/container-cpu.mjs" 2>/dev/null || echo null)"
started="$(iso)"
echo "== $impl / $scenario  ($*)  started $started"

net=()
[ -n "${K6_NETWORK:-}" ] && net=(--network "$K6_NETWORK")

docker run --rm -i \
  --add-host host.docker.internal:host-gateway ${net[@]+"${net[@]}"} \
  -v "$root/load:/scripts:ro" -v "$out:/out" \
  "${envs[@]}" "$K6_IMAGE" run --quiet /scripts/orders.js

ended="$(iso)"
cpu_after="$(node "$root/scripts/container-cpu.mjs" 2>/dev/null || echo null)"
status_after="$(lab_status)"

cat >"$out/meta.json" <<EOF
{
  "impl": "$impl",
  "scenario": "$scenario",
  "k6Env": "$*",
  "k6Image": "$K6_IMAGE",
  "commit": "$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "started": "$started",
  "ended": "$ended",
  "labStatusBefore": $status_before,
  "labStatusAfter": $status_after,
  "containerCpuBefore": $cpu_before,
  "containerCpuAfter": $cpu_after
}
EOF
echo "   results in ${out#"$root"/} (per-step time windows are in summary.json)"
