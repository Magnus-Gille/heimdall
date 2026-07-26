# Heimdall Fleet Push Agent

Lightweight push agent that collects system metrics and POSTs them to the Heimdall hub on a fixed interval.

## Requirements

```bash
pip install psutil          # required on all platforms
brew install macmon         # optional — macOS CPU temp (Apple Silicon / Intel)
pip install jetson-stats    # optional — Jetson GPU/power/temp via jtop
```

## Installation

### 1. Configure

```bash
cd agent/
cp config.env.example config.env
```

Edit `config.env`:

```
HUB_URL=http://192.0.2.10:3033/api/fleet/push
FLEET_TOKEN=<generate-a-random-token>
INTERVAL=30
```

For a laptop or other intermittent host, set `HOSTNAME=workstation` and mark the corresponding fleet entry `always_on: false`.

### 2. Smoke test

```bash
python3 core.py --once
# Expected: 200 {"ok":true}  (or similar 2xx)
```

### 3a. Linux / Raspberry Pi / Jetson — automated deploy (canonical)

Use the deploy script for first-time installs and all updates. Before the first
run, place a mode-`0600` `config.env` containing non-empty `HUB_URL` and
`FLEET_TOKEN` at `~/repos/heimdall/agent/config.env` on the target. The script
preflights that protected host configuration before changing anything, rsyncs
the agent, stamps a `VERSION` file (the git short SHA), updates the systemd user
unit, and restarts the service:

```bash
# From the repo root on your laptop:
bash agent/deploy/deploy-agent.sh <ssh-host>

# Examples:
bash agent/deploy/deploy-agent.sh orin
bash agent/deploy/deploy-agent.sh worker-node
bash agent/deploy/deploy-agent.sh user@192.0.2.1
```

The script is idempotent — safe to re-run after any code change. It does
**not** overwrite or delete the host's `config.env` (secrets are preserved),
and refuses before rsync/restart when the required configuration is absent or
empty.

After deploying, enable linger so the user unit survives logout:

```bash
ssh <host> "sudo loginctl enable-linger \$USER"
```

#### Manual install (alternative)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/heimdall-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now heimdall-agent.service
systemctl --user status heimdall-agent.service
sudo loginctl enable-linger "$USER"
```

The shipped unit is a **user** unit (`WantedBy=default.target`, `%h` = your home, no root needed) — the recommended install for the always-on Pi/Jetson hosts. For a system-wide install instead, copy the unit to `/etc/systemd/system/`, add `User=<you>`, change `WantedBy` to `multi-user.target`, and replace `%h` with the absolute home path.

### 3b. macOS — launchd

1. Edit `deploy/org.grimnir.heimdall-agent.plist` — replace `YOURUSERNAME` with your macOS username.
2. Install and load:

```bash
cp deploy/org.grimnir.heimdall-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/org.grimnir.heimdall-agent.plist
```

Logs land in `/tmp/heimdall-agent.log` and `/tmp/heimdall-agent.err`.

To stop/unload:

```bash
launchctl unload ~/Library/LaunchAgents/org.grimnir.heimdall-agent.plist
```

## Payload schema

For optional versioned capability negotiation (including Brokkr-originated
observation evidence), see [`../docs/monitoring-agent-capability-contract-v1.md`](../docs/monitoring-agent-capability-contract-v1.md).
Do not put hub URLs, credentials, topology, workloads, or private locations in
the public contract payload.

```json
{
  "hostname":      "worker-node",
  "ts":            "2026-06-23T14:00:00Z",
  "agent_version": "abc1234",
  "os":            "linux",
  "platform":     "pi5",
  "cpu_pct":      12.3,
  "ram_total_mb": 3926.0,
  "ram_used_mb":  1024.5,
  "ram_used_pct": 26.1,
  "uptime_s":     86400.0,
  "load_1":       0.42,
  "load_5":       0.38,
  "load_15":      0.31,
  "temp_cpu_c":   47.2,
  "disk": [
    {"mount": "/", "total_mb": 29000, "used_mb": 8500, "used_pct": 29.3}
  ]
}
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ModuleNotFoundError: psutil` | `pip install psutil` |
| `temp_cpu_c` missing on Mac | `brew install macmon` |
| POST returns 401 | Set `FLEET_TOKEN` in config.env |
| hostname wrong on server | Set `HOSTNAME=<name>` in config.env |
| Service won't start on Pi | Check `journalctl --user -u heimdall-agent` |
