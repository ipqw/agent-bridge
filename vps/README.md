# Server side — test setup

Two pieces, both on the server where the agent runs. frps takes its own port (7000), not :443,
so it never collides with the web server or anything else already listening there.

## 1. frps (temporary, for the test)

```
sudo install -d -m 755 /etc/agent-bridge
# no secrets in the toml; the DynamicUser service reads it, so 0644
sudo install -m 644 vps/frps.toml /etc/agent-bridge/frps.toml
# the token: generated in place, read only by systemd (EnvironmentFile), never printed
sudo sh -c 'umask 077; printf "FRPS_TOKEN=%s\n" "$(openssl rand -hex 32)" > /etc/agent-bridge/frps.env'
node scripts/fetch-frp.mjs core/.cache/frp            # pinned 0.71.0, sha256-checked
sudo install -m 755 core/.cache/frp/frps /usr/local/bin/frps
sudo install -m 644 vps/agent-bridge-frps.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-bridge-frps
sudo ufw allow 7000/tcp comment 'agent-bridge frps (test)'
```

The user reads the token in their own SSH terminal (`sudo cat /etc/agent-bridge/frps.env`) and
pastes it into the bridge window — not through the agent's chat.

Removal after the test:
`sudo systemctl disable --now agent-bridge-frps && sudo ufw delete allow 7000/tcp && sudo rm -r /etc/agent-bridge /etc/systemd/system/agent-bridge-frps.service /usr/local/bin/frps`

Port 7000/tcp must be reachable from the user's machine (frpc connects out to it). Only frpc
clients with the token can log in; each MCP is additionally protected by its own stcp key.

## 2. Visitor + agent config (agent's user, where `claude` runs)

1. In the bridge window on the user's machine: «Для места» → copy `frpc-visitor.toml` and `.mcp.json`.
2. On the VPS, as the agent's user:
   ```
   install -d -m 700 ~/.config/agent-bridge ~/.local/bin
   # paste frpc-visitor.toml into ~/.config/agent-bridge/frpc-visitor.toml, chmod 600
   install -m 755 <frpc 0.71.0 binary> ~/.local/bin/frpc
   install -m 644 vps/bridge-visitor.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now bridge-visitor
   ```
3. Put `.mcp.json` into the agent's working folder (it contains the gate token — chmod 600).
4. `claude` in that folder → `/mcp` shows `bridge-terminal` and `bridge-browser`.
