#!/usr/bin/env bash
# Reach the homelab lab from the Mac on the same loopback ports as the dev stack, through SSH
# (the server publishes no lab ports). Then the contract tests, record-demo.ts and the analysis
# scripts work unchanged. Ctrl-C closes it.
#   scripts/homelab-tunnel.sh            gateway 8088, page 8090, Tempo 3200, Prometheus 9090,
#                                        Loki 3100, Grafana 3000
#   scripts/homelab-tunnel.sh --relax    also lift the gateway's per-IP order limit to 300/min
#                                        while the tunnel is open (every tunnelled request
#                                        shares one address); the normal limit returns on exit
set -euo pipefail
HOST=${HOST:-yzserver-claude}
DEST=/opt/homelab/compose/observability-lab
COMPOSE="docker compose -p observability-lab --env-file $DEST/.env -f $DEST/infra/compose.yaml -f $DEST/infra/compose.homelab.yaml"


if [[ "${1:-}" == --relax ]]; then
  ssh "$HOST" "RATE_LIMIT_PER_MIN=300 $COMPOSE up -d --wait gateway" >/dev/null
  trap 'ssh "$HOST" "$COMPOSE up -d --wait gateway" >/dev/null; echo "gateway limit restored"' EXIT
  echo "gateway per-IP order limit: 300/min until this tunnel closes"
fi

# One ssh call for all addresses: UFW rate-limits quick SSH connections.
SERVICES=(gateway:8088:8080 lab-web:8090:8080 tempo:3200:3200 prometheus:9090:9090 loki:3100:3100 grafana:3000:3000)
names=(); for pair in "${SERVICES[@]}"; do names+=("observability-lab-${pair%%:*}-1"); done
ips=($(ssh "$HOST" "docker inspect -f '{{(index .NetworkSettings.Networks \"observability-lab_lab\").IPAddress}}' ${names[*]}"))
forwards=()
for i in "${!SERVICES[@]}"; do
  IFS=: read -r _ local remote <<<"${SERVICES[$i]}"
  forwards+=(-L "127.0.0.1:$local:${ips[$i]}:$remote")
done
echo "tunnel open: page http://127.0.0.1:8090, gateway :8088, Grafana :3000 (Ctrl-C to close)"
ssh -N -o ExitOnForwardFailure=yes "${forwards[@]}" "$HOST"
