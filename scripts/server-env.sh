#!/bin/sh
# Runs on the server (called by scripts/deploy.sh): create the lab's .env on first deploy, and set
# the Grafana admin password from stdin. The file is mode 600 and never leaves the server.
# Usage: printf %s "$PASSWORD" | sh scripts/server-env.sh /opt/homelab/compose/observability-lab
set -eu
DEST="$1"
umask 077
GRAFANA_PASS=$(cat)
[ -n "$GRAFANA_PASS" ] || { echo "no Grafana password on stdin" >&2; exit 1; }
if [ ! -f "$DEST/.env" ]; then
  r() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  { echo "LAB_DB_PASSWORD=$(r)"; echo "LAB_ENV=homelab"; } > "$DEST/.env"
  echo "created $DEST/.env"
fi
{ grep -v '^GRAFANA_ADMIN_PASSWORD=' "$DEST/.env" || true; echo "GRAFANA_ADMIN_PASSWORD=$GRAFANA_PASS"; } > "$DEST/.env.tmp"
mv "$DEST/.env.tmp" "$DEST/.env"
