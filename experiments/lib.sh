# Shared helpers for experiments/*/run.sh (source it). Assumes the dev stack (compose.dev.yaml).
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(docker compose -f "$root/infra/compose.yaml" -f "$root/infra/compose.dev.yaml")
run() { "$root/scripts/experiment.sh" "$@"; }

# The dev per-IP rate limit (300/min) is far below these load profiles; lift it for the run and
# put the normal gateway back on exit. The in-flight, host-load and backlog guards stay on.
lift_rate_limit() {
  RATE_LIMIT_PER_MIN=1000000 "${compose[@]}" up -d --wait gateway >/dev/null
  trap 'restore_services' EXIT
}
restore_services() {
  "${compose[@]}" up -d --wait gateway order-api-node order-api-go >/dev/null 2>&1 || true
}

# Restart services with extra environment, e.g. with_env "BREAKER_ENABLED=false" order-api-node
with_env() {
  local kv="$1"; shift
  env "$kv" "${compose[@]}" up -d --wait "$@" >/dev/null
}

# Wait until the stream backlog of both implementations is back to zero (or 60 s).
drain() {
  for _ in $(seq 1 60); do
    local s; s=$(curl -fsS http://127.0.0.1:8088/api/lab/status 2>/dev/null || echo '{}')
    if echo "$s" | grep -q '"backlog":{"node":0,"go":0}'; then return 0; fi
    sleep 1
  done
}
