#!/usr/bin/env bash
# Create one order through each implementation and wait until the worker completes it.
# Usage: scripts/smoke.sh [base-url]   (default http://127.0.0.1:8088)
set -euo pipefail
BASE="${1:-http://127.0.0.1:8088}"
fail=0

for impl in node go; do
  started=$(date +%s)
  created=$(curl -fsS -X POST "$BASE/api/$impl/orders" \
    -H 'content-type: application/json' \
    -d '{"productId":"demo-001","quantity":2}')
  id=$(jq -r .orderId <<<"$created")
  status=queued
  for _ in $(seq 1 50); do
    status=$(curl -fsS "$BASE/api/$impl/orders/$id" | jq -r .status)
    [ "$status" = completed ] && break
    sleep 0.2
  done
  if [ "$status" = completed ]; then
    echo "ok   $impl  order $id completed in ~$(( $(date +%s) - started ))s"
  else
    echo "FAIL $impl  order $id still '$status'"
    fail=1
  fi
done
exit $fail
