#!/usr/bin/env bash
# Experiment 7: what happens when producers outrun the worker? On the homelab, one implementation
# at a time: slow that worker down (WORKER_WORK_MS), send steady traffic for DURATION, watch the
# backlog grow until the gateway's backlog guard sheds load, then stop and time the drain.
# See docs/EXPERIMENTS.md.
#
# Usage: experiments/07-queue-backlog/run.sh <results-dir>, then
#        LAB_SSH=yzserver-claude node experiments/07-queue-backlog/analyse.ts <results-dir>
# Env: IMPLS (default "node go"), WORK_MS (2000), RATE (15 req/s), DURATION (120s),
#      DRAIN_MAX_S (300), HOST (yzserver-claude).
#
# Runs from the Mac over the home network (SSH), never through the public tunnel. It opens its own
# SSH forward to the gateway, so scripts/homelab-tunnel.sh is not needed. While it runs, visitors
# who pick the implementation under test get the same "queue is backed up" answer as k6.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:?usage: run.sh <results-dir>}"
mkdir -p "$out"; out="$(cd "$out" && pwd)"
HOST=${HOST:-yzserver-claude}
IMPLS=${IMPLS:-node go} WORK_MS=${WORK_MS:-2000} RATE=${RATE:-15} DURATION=${DURATION:-120s}
DRAIN_MAX_S=${DRAIN_MAX_S:-300}
DEST=/opt/homelab/compose/observability-lab
COMPOSE="docker compose -p observability-lab --env-file $DEST/.env -f $DEST/infra/compose.yaml -f $DEST/infra/compose.homelab.yaml"
PORT=18088
STATUS="http://127.0.0.1:$PORT/api/lab/status"

tunnel_pid= poller_pid=
cleanup() {
  [ -n "$poller_pid" ] && kill "$poller_pid" 2>/dev/null || true
  [ -n "$tunnel_pid" ] && kill "$tunnel_pid" 2>/dev/null || true
  # Normal gateway (per-IP limit back) and normal workers.
  ssh "$HOST" "$COMPOSE up -d --wait gateway worker-node worker-go" >/dev/null && echo "gateway and workers restored"
}
trap cleanup EXIT

# Every k6 request arrives from one address, so lift the per-IP order limit for the run. The
# in-flight, host-load and backlog guards stay on: the backlog guard is what is being measured.
ssh "$HOST" "RATE_LIMIT_PER_MIN=1000000 $COMPOSE up -d --wait gateway" >/dev/null
ip=$(ssh "$HOST" "docker inspect -f '{{(index .NetworkSettings.Networks \"observability-lab_lab\").IPAddress}}' observability-lab-gateway-1")
ssh -N -o ExitOnForwardFailure=yes -L "127.0.0.1:$PORT:$ip:8080" "$HOST" & tunnel_pid=$!
for _ in $(seq 1 20); do curl -fsS --max-time 2 "$STATUS" >/dev/null 2>&1 && break; sleep 0.5; done

backlog() { # backlog <impl> -> number, or -1 if the status call failed
  curl -fsS --max-time 2 "$STATUS" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).backlog[process.argv[1]]))}catch{process.stdout.write("-1")}})' "$1" ||
    echo -1
}
wait_drained() { # wait_drained <impl> <max seconds>; prints the epoch second it reached 0, or "null"
  local end=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ "$(backlog "$1")" = 0 ] && { date +%s; return; }
    sleep 1
  done
  echo null
}

for impl in $IMPLS; do
  dir="$out/$impl"; mkdir -p "$dir"
  echo "== $impl: worker work time ${WORK_MS} ms, ${RATE} req/s for ${DURATION}"
  ssh "$HOST" "WORKER_WORK_MS=$WORK_MS $COMPOSE up -d --wait worker-$impl" >/dev/null
  [ "$(wait_drained "$impl" 60)" = null ] && { echo "backlog of $impl is not 0 before the run" >&2; exit 1; }

  # Guard state once a second: backlog, host load, in-flight.
  ( while :; do
      printf '{"at":%s,"status":%s}\n' "$(date +%s)" "$(curl -fsS --max-time 2 "$STATUS" 2>/dev/null || echo null)"
      sleep 1
    done ) >"$dir/status.jsonl" & poller_pid=$!

  load_start=$(date +%s)
  STATUS_URL="$STATUS" "$root/scripts/experiment.sh" "$dir" "$impl" none \
    RATE="$RATE" DURATION="$DURATION" WARMUP=0s BASE_URL="http://host.docker.internal:$PORT"
  load_end=$(date +%s)
  echo "   load stopped; waiting for the $impl queue to drain (max ${DRAIN_MAX_S} s)"
  drained=$(wait_drained "$impl" "$DRAIN_MAX_S")
  sleep 3
  kill "$poller_pid"; wait "$poller_pid" 2>/dev/null || true; poller_pid=
  cat >"$dir/phases.json" <<JSON
{ "impl": "$impl", "workMs": $WORK_MS, "rate": $RATE, "duration": "$DURATION",
  "loadStart": $load_start, "loadEnd": $load_end, "drained": $drained }
JSON
  echo "   drained: $drained (load ended $load_end)"
  ssh "$HOST" "$COMPOSE up -d --wait worker-$impl" >/dev/null   # normal worker before the next impl
done
