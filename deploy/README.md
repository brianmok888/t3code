# t3 server deployment (omo fork)

Reproducible deployment of the forked t3 server (with the ported omo adapter)
to any headless Linux box.

## Prerequisites

1. Repo cloned at `~/projects/t3code` (branch `omo-port`), node v26 at
   `~/tools/node-v26.12.1-linux-x64/bin/node` (override: `T3_REPO_DIR`,
   `T3_NODE_BIN`)
2. `pnpm` available (workspace installs already done)
3. Tailscale installed (`curl -fsSL https://tailscale.com/install.sh | sh`),
   `sudo systemctl enable --now tailscaled`, then `sudo tailscale up` (join
   your tailnet; MagicDNS on)
4. Tailnet admin → DNS → **HTTPS certificates enabled**

## Deploy

```bash
bash deploy/install.sh
```

Builds the server bundle, installs `t3-server.service` (runs
`t3 serve --tailscale-serve`), enables + starts it. Verify:

```bash
systemctl is-active t3-server
sudo tailscale serve status   # https://<host>.<tailnet>.ts.net -> 127.0.0.1:3773
```

## Pair a device

```bash
cd apps/server && node dist/bin.mjs pair --tailscale
```

Open the printed pairing URL on the phone (same tailnet, or LAN:
`http://<lan-ip>:3773/pair#...` while at home).

## Layout

- `deploy/install.sh` — idempotent installer (bundle build + unit + start)
- `deploy/t3-server.service` — reference unit (kept in sync with the installer)

## Runtime model

APK/desktop app → this t3 server (ported OmoDriver inside) → official omo CLI
(untouched, pinned by omo-ai) → OmniRoute gateway → models. The server never
talks to provider endpoints directly.
