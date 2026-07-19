# Heimdall — Example Infrastructure Inventory

> Fictionalized historical architecture example retained to explain early design choices. Names, capacities, schedules, versions, dates, and addresses are illustrative rather than a deployment inventory. Addresses use RFC 5737 documentation ranges. Use `heimdall.config.json` as the machine-readable example.

---

## Network Topology

```
┌─────────────────────────────────────────────────────────────┐
│                     Tailscale Mesh                          │
│                                                             │
│  ┌──────────────────┐         ┌──────────────────┐          │
│  │  control-node       │  SSH   │  nas              │         │
│  │  192.0.2.10    │───────▶│  192.0.2.20    │         │
│  │  (AI Infra Pi)    │  LAN   │  (NAS Pi)         │         │
│  └──────────────────┘ 192.168 └──────────────────┘          │
│         │  .0.x                       │                     │
│         │                             │                     │
│  ┌──────┴───────────┐         ┌───────┴──────────┐          │
│  │ Cloudflare Tunnel │        │ SMB/TimeMachine   │         │
│  │ memory.example.com│        │ port 445          │         │
│  │ authenticated     │        │ (private network) │         │
│  └──────────────────┘         └──────────────────┘          │
│                                                             │
│  Other Tailscale nodes:                                     │
│  • workstation         192.0.2.60  (macOS)              │
│  • mobile-device       192.0.2.50  (iOS)                │
│  • m5                  192.0.2.30    (BosGame, inference) │
└─────────────────────────────────────────────────────────────┘

**M5 (BosGame home-server, inference):** Tailscale `192.0.2.30`. Runs the
inference gateway (`/healthz` + `/ledger`, default port 8080). Heimdall's collector
polls it each cycle (`src/inference.js` → host `m5`), surfaced on the **M5 Inference**
dashboard card. Gateway URL is set via `HOMESERVER_GATEWAY_URL` in `~/.heimdall/env`.
```

---

## Pi 1: control-node (AI Infrastructure)

### Hardware
- **Model:** Raspberry Pi 5
- **Case:** Flirc Pi 5 (silver aluminum, passive cooling) — raven sticker on lid
- **Architecture:** aarch64

### System
| Field | Value |
|-------|-------|
| Hostname | `control-node` |
| OS | Debian GNU/Linux 13 (trixie) |
| Kernel | 6.12.62+rpt-rpi-2712 |
| Tailscale IP | 192.0.2.10 |
| Uptime | 10 days, 3:45 (as of 2026-03-15 11:52 CET) |
| CPU Temp | 42.2°C |
| Load Average | 0.08, 0.02, 0.01 |

### Memory
| | Total | Used | Free | Available |
|--|-------|------|------|-----------|
| RAM | 7.9 GiB | 949 MiB | 6.0 GiB | 6.9 GiB |
| Swap | 2.0 GiB | 0 B | 2.0 GiB | — |

### Disk
| Filesystem | Size | Used | Avail | Use% | Mount |
|------------|------|------|-------|------|-------|
| /dev/mmcblk0p2 (root) | 58G | 5.9G | 50G | 11% | / |
| /dev/mmcblk0p1 (boot) | 510M | 66M | 445M | 13% | /boot/firmware |
| tmpfs | 4.0G | 9.4M | 4.0G | 1% | /tmp |

**Note:** SD card only — no external storage attached.

### Running Services (key)
| Service | Description |
|---------|-------------|
| `hugin.service` | Hugin Task Dispatcher (autonomous agent) |
| `munin-memory.service` | Munin Memory MCP Server (port 3030) |
| `cloudflared.service` | Cloudflare Tunnel (exposes memory.example.com) |
| `tailscaled.service` | Tailscale VPN |
| `ssh.service` | OpenSSH server |
| `cron.service` | Cron daemon |

Total: 21 running services (including system services like journald, udevd, etc.)

### Systemd Timers
| Timer | Schedule | Purpose |
|-------|----------|---------|
| `munin-backup.timer` | Hourly (5min jitter) | SQLite backup to NAS |
| `apt-daily.timer` | Daily | APT package list update |
| `apt-daily-upgrade.timer` | Daily | APT upgrades |
| `logrotate.timer` | Daily | Log rotation |
| `fstrim.timer` | Weekly | SSD/SD trim |

### Cron Jobs
- **User crontab:** None
- **System cron.d:** `e2scrub_all`
- **Daily:** apt-compat, dpkg, logrotate, man-db
- **Weekly:** man-db

### Repos
| Directory | Purpose |
|-----------|---------|
| `~/repos/hugin` | Hugin Task Dispatcher |
| `~/repos/mimir` | Mímir file server (git only — runs on NAS) |
| `~/repos/munin-memory` | Munin Memory MCP Server |

### Connectivity
- **Internet:** OK (5.35ms to 8.8.8.8)
- **Tailscale:** Active, direct connection to NAS (198.51.100.11:41641)
- **Cloudflare Tunnel:** Active (memory.example.com)

---

## Pi 2: nas (Storage / Backup)

### Hardware
- **Model:** Raspberry Pi 5
- **Case:** Flirc Pi 5 (silver aluminum, passive cooling) — hip-hop logo sticker on lid
- **Architecture:** aarch64
- **External Storage:** USB drive, 1.8 TB

### System
| Field | Value |
|-------|-------|
| Hostname | `nas` |
| OS | Debian GNU/Linux 13 (trixie) |
| Kernel | 6.12.62+rpt-rpi-2712 |
| Tailscale IP | 192.0.2.20 |
| LAN IP | 198.51.100.10 (used by control-node for backups) |
| Uptime | 10 days, 3:44 (as of 2026-03-15 11:53 CET) |
| CPU Temp | 40.0°C |
| Load Average | 0.00, 0.00, 0.00 |

### Memory
| | Total | Used | Free | Available |
|--|-------|------|------|-----------|
| RAM | 4.0 GiB | 550 MiB | 200 MiB | 3.4 GiB |
| Swap | 2.0 GiB | 35 MiB | 2.0 GiB | — |

**Note:** 4 GB model (vs 8 GB on control-node). Low free RAM but 3.4 GiB available (buff/cache).

### Disk
| Filesystem | Size | Used | Avail | Use% | Mount |
|------------|------|------|-------|------|-------|
| /dev/mmcblk0p2 (root) | 58G | 5.6G | 50G | 11% | / |
| /dev/mmcblk0p1 (boot) | 510M | 66M | 445M | 13% | /boot/firmware |
| **/dev/sda1 (NAS drive)** | **1.8T** | **495G** | **1.3T** | **29%** | **/mnt/timemachine** |

### Running Services (key)
| Service | Description |
|---------|-------------|
| `smbd.service` | Samba SMB Daemon |
| `nmbd.service` | Samba NMB Daemon |
| `winbind.service` | Samba Winbind Daemon |
| `mimir.service` | Mímir File Server |
| `cloudflared.service` | Cloudflare Tunnel (exposes Mímir) |
| `tailscaled.service` | Tailscale VPN |
| `ssh.service` | OpenSSH server |
| `cron.service` | Cron daemon |

Total: 23 running services.

### Systemd Timers
| Timer | Schedule | Purpose |
|-------|----------|---------|
| `cloudflared-update.timer` | Daily | Cloudflare tunnel auto-update |
| `apt-daily.timer` | Daily | APT package list update |
| `apt-daily-upgrade.timer` | Daily | APT upgrades |
| `logrotate.timer` | Daily | Log rotation |
| `fstrim.timer` | Weekly | SSD/SD trim |

### Cron Jobs
- **User crontab:** `0 * * * * /home/heimdall/mimir/scripts/backup-artifacts.sh` (hourly Mímir artifact backup)
- **System cron.d:** `e2scrub_all`
- **Daily:** apt-compat, dpkg, logrotate, man-db

### Samba Configuration
```
[TimeMachine]
   path = /mnt/timemachine
   valid users = backup-user
   read only = no
   vfs objects = catia fruit streams_xattr
   fruit:time machine = yes
   fruit:time machine max size = 1.5T
```

### Time Machine Backup State
| Field | Value |
|-------|-------|
| Sparsebundle | `Workstation.sparsebundle` |
| Location | `/mnt/timemachine/` |
| Total size on disk | 495 GB |
| Max allowed | 1.5 TB |
| Last TM activity | 2026-03-15 10:56 CET (SnapshotHistory.plist modified) |
| Encryption | Yes (password-protected sparsebundle) |

### Munin Memory Backups (received from control-node)
| Field | Value |
|-------|-------|
| Location | `/home/heimdall/backups/munin-memory/` |
| Count | 194 files |
| DB size | ~2.5 MB each |
| Latest | `memory-2026-03-15-1000.db` |
| Retention | 7 days rolling |
| Schedule | Hourly from control-node via systemd timer |

### Mímir File Server
| Field | Value |
|-------|-------|
| Service | `mimir.service` (systemd) |
| Location | `/home/heimdall/mimir/` |
| Artifacts | `/home/heimdall/artifacts/` |
| Backup | Hourly rsync from SD (`/home/heimdall/artifacts/`) to NAS drive (`/mnt/timemachine/backups/mimir/`) |
| Ingress | Optional authenticated reverse proxy (`files.example.com`) |

### Connectivity
- **Internet:** OK (5.19ms to 8.8.8.8)
- **Tailscale:** Active
- **SMB:** Accessible via Tailscale IP (port 445)
- **Cloudflare Tunnel:** Active (Mímir)

---

## Backup Summary

| Backup | Source | Destination | Schedule | Retention | Last Run |
|--------|--------|-------------|----------|-----------|----------|
| Munin Memory DB | control-node SD | NAS `/home/heimdall/backups/munin-memory/` | Hourly (systemd timer) | 7 days | 2026-03-15 11:00 |
| Mímir Artifacts | NAS SD (`/home/heimdall/artifacts/`) | NAS drive (`/mnt/timemachine/backups/mimir/`) | Hourly (cron) | Mirror (rsync --delete) | Hourly |
| Workstation backup | Intermittent laptop | Storage volume | Automatic | Deployment-defined | Example timestamp |

---

## Illustrative Hugin task-system shape

### Task Categories
| Category | Description |
|----------|-------------|
| `tasks/admin` | Operational chores and recurring tasks |
| `tasks/commitments` | Tasks promised to others — customer deliverables, deadlines |
| `tasks/events` | Event-tied tasks (e.g., hackathon planning) |
| `tasks/projects` | Ongoing project work without hard deadlines |
| `tasks/index` | Universal task store index |

### Hugin Service
- **Status:** Example only
- **Host:** control-node.local, systemd service
- **Port:** 3032 (health endpoint)
- **Runtimes:** Deployment-defined coding agents
- **Poll interval:** 30s against Munin `tasks/` namespace
- **Claim mechanism:** Compare-and-swap on task state
- **Output capture:** Last 4000 chars

---

## Illustrative observations that informed the design

1. Temperature and throttling telemetry matter on passively cooled edge hosts.
2. Capacity percentages alone are insufficient; growth trends and time-to-full are more useful.
3. Intermittent laptops need different liveness semantics from always-on servers.
4. Coordinated uptime resets can reveal a shared power or maintenance event.
5. Backup success is not enough; freshness, retention, and restore evidence need monitoring.
6. Private-network reachability is not a substitute for explicit application and ingress policy.
