#!/usr/bin/env bash
# Deploy the lab to the homelab (yzserver). Run from anywhere on the Mac.
#   scripts/deploy.sh          copy the repo, build on the server, start, smoke test
#   scripts/deploy.sh --yes    don't ask about uncommitted changes
# The working tree is deployed as-is (uncommitted changes included).
#
# Needs, once (sudo, see docs/DEPLOYMENT.md): /etc/systemd/system/homelab-lab.slice.
# First run creates /opt/homelab/compose/observability-lab/.env on the server with a random
# database password, and the Grafana admin password, which is kept in the Mac login Keychain:
#   security find-generic-password -a admin -s homelab-observability-grafana -w
set -euo pipefail
HOST=${HOST:-yzserver-claude}
DEST=/opt/homelab/compose/observability-lab
DATA=/opt/homelab/lab-data/observability-lab
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KC=(-a admin -s homelab-observability-grafana)

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

DIRTY=$(git -C "$ROOT" status --porcelain)
if [[ -n "$DIRTY" && $YES == 0 ]]; then
  echo "Uncommitted changes will be deployed:"; echo "$DIRTY" | sed 's/^/  /'
  read -r -p "Deploy anyway? [y/N] " a; [[ "$a" == [yY]* ]] || exit 1
fi

if ! ssh "$HOST" "systemctl cat homelab-lab.slice >/dev/null 2>&1"; then
  echo "homelab-lab.slice is not installed on $HOST; run the one-time setup in docs/DEPLOYMENT.md" >&2
  exit 1
fi

ssh "$HOST" "mkdir -p $DEST"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude dist --exclude '.env' --exclude '.DS_Store' \
  --exclude 'experiments/*/results' --exclude 'apps/order-go/order-go' \
  "$ROOT/" "$HOST:$DEST/"

# Secrets live only in the server .env (mode 600). The Grafana password comes from the Keychain
# over stdin, never on a command line.
if ! security find-generic-password "${KC[@]}" >/dev/null 2>&1; then
  security add-generic-password "${KC[@]}" -w "$(openssl rand -base64 18 | tr '+/' 'xy')"
fi
security find-generic-password "${KC[@]}" -w | ssh "$HOST" "sh $DEST/scripts/server-env.sh $DEST"

# Telemetry and database data: bind mounts outside the nightly backup set, owned by each image's
# user (chowned through a throwaway container, since there is no sudo here).
ssh "$HOST" "mkdir -p $DATA/{postgres,tempo,prometheus,loki,grafana} && docker run --rm -v $DATA:/d alpine:3.22 sh -c \
  'chown 70:70 /d/postgres && chown 10001:10001 /d/tempo /d/loki && chown 65534:65534 /d/prometheus && chown 472:0 /d/grafana'"

COMPOSE="docker compose -p observability-lab --env-file $DEST/.env -f $DEST/infra/compose.yaml -f $DEST/infra/compose.homelab.yaml"

# Validate the page's nginx config before replacing the running container.
ssh "$HOST" "docker run --rm --add-host gateway:127.0.0.1 -v $DEST/infra/web-nginx.conf:/etc/nginx/nginx.conf:ro nginx:1.31-alpine nginx -q -t"

ssh "$HOST" "$COMPOSE build && $COMPOSE up -d --remove-orphans --wait && $COMPOSE ps --format 'table {{.Service}}\t{{.Status}}'"

# Smoke test through the page's own nginx, as a visitor would reach the API.
ssh "$HOST" "docker run --rm --network observability-lab_lab alpine:3.22 sh -c '
  wget -qO- http://lab-web:8080/healthz && wget -qO- http://lab-web:8080/api/health && echo'"
ssh "$HOST" "systemctl status homelab-lab.slice --no-pager | sed -n '1,8p'"
