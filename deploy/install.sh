#!/usr/bin/env bash
# t3code fork — reproducible t3 server deployment (omo adapter + Tailscale Serve).
# Usage: bash deploy/install.sh
# Assumes: repo cloned at ~/projects/t3code, node v26 in
#          ~/tools/node-v26.12.1-linux-x64/bin, tailscale installed + joined.
set -euo pipefail

REPO="${T3_REPO_DIR:-$HOME/projects/t3code}"
NODE_BIN="${T3_NODE_BIN:-$HOME/tools/node-v26.12.1-linux-x64/bin/node}"
SERVICE_NAME="t3-server"

cd "$REPO/apps/server"
echo "── building server bundle ──"
pnpm build:bundle

echo "── installing systemd unit ──"
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<UNIT
[Unit]
Description=T3 Code server (omo fork, headless)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=%i
Environment=HOME=/home/%i
Environment=PATH=$HOME/tools/node-v26.12.1-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN $REPO/apps/server/dist/bin.mjs serve --tailscale-serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

echo "── tailscale operator (serve as this user) ──"
sudo tailscale set --operator="$USER" || echo "warn: set operator failed"

sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE_NAME}
sleep 5
systemctl --no-pager status ${SERVICE_NAME} | head -3 || true

echo
echo "── done. pair a device: ──"
echo "  cd $REPO/apps/server && node dist/bin.mjs pair --tailscale"
echo "  then open the printed pairing URL on the phone (same tailnet)."
