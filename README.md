# Heimdall

Heimdall is the observability and operator dashboard for the Grimnir personal-AI ecosystem. It monitors services, accepts authenticated fleet telemetry, evaluates declarative alert rules, and presents the latest state in a Fastify/HTMX interface.

This Grimnir component is unrelated to the linuxserver/Heimdall application dashboard.

The project is useful on its own with a JSON service inventory. Its deeper integrations with Hugin, Munin Memory, Mimir, and a local inference gateway are optional.

## Where it fits

```text
agents and hosts ──authenticated metrics/panels──▶ Heimdall
service endpoints ──descriptors + health────────▶ Heimdall
Heimdall ──optional alerts/state─────────────────▶ Munin Memory
Heimdall ──optional recovery tasks───────────────▶ Hugin
Heimdall ──optional artifact/storage probes──────▶ Mimir
Heimdall ──optional capability probes────────────▶ gille-inference
```

Grimnir is the system-level architecture repository; Brokkr describes the hardware, OS, storage, and backup substrate. Ratatoskr and Skuld are optional integrations, not prerequisites for understanding or running Heimdall.

### Backup freshness cadence

The committed `heimdall.config.json` declares every backup source under
`backups`. A private config selected by `HEIMDALL_CONFIG_PATH` inherits those
definitions when it omits `backups`, and overrides them only when it explicitly
supplies the section. Each source must provide `expected_interval_hours`,
`warning_after_intervals`, and `critical_after_intervals`; startup rejects
missing, non-positive, or non-escalating explicit values. The alert ages are calculated per source:
`warning = expected interval × warning multiplier`, and `critical = expected
interval × critical multiplier`. This intentionally prevents a weekly backup
from inheriting an hourly or six-hour timeout. Define slow sources explicitly;
there is no fallback cadence for unknown names.

### Disk-volume policy

`disk_volumes` declares the purpose of each monitored filesystem. A `general`
volume provides explicit `warning_pct` and `critical_pct` values. A
`quota_backup` instead declares public capacity and Time Machine quota facts,
then the fraction of the non-quota reserve that must remain at warning and
critical. Its calculated alert point is `used = total - reserve × fraction`.
This lets managed backups mature normally while alerting when they consume the
filesystem safety margin. Private overlays inherit the committed policy unless
they explicitly replace `disk_volumes`.

## Features

- Service discovery from Grimnir's `services.json`, enriched by `heimdall.config.json`.
- Self-describing `/heimdall.json` service contract with `/health` fallback.
- Authenticated fleet-agent, alert, and typed-panel ingestion.
- CPU, memory, disk, temperature, task, deployment-drift, backup, MCP, and inference views.
- Declarative alert thresholds with streak-based fire and resolve behavior.
- SQLite event history and a generic service detail renderer.
- Optional task and newly-fired critical-alert notifications through Ratatoskr.
- Optional Hugin recovery-task submission, disabled by default.

## Quick start

Requirements: Node.js 22 or newer, npm, and Python 3 with `pytest` for the optional fleet-agent tests.

```bash
npm ci
mkdir -p ~/.heimdall
cp .env.example ~/.heimdall/env
HEIMDALL_CONFIG_MODE=demo npm start
```

Open <http://127.0.0.1:3033>. The committed `heimdall.config.json` uses RFC 5737 documentation addresses; replace its examples or point `HEIMDALL_CONFIG_PATH` to your own JSON. Set `GRIMNIR_SERVICES_JSON` to consume a Grimnir registry checkout. Without either integration, the committed overlay is a usable demonstration inventory. Its documentation targets require `HEIMDALL_CONFIG_MODE=demo` (or `NODE_ENV=test`); production always rejects them at startup.

Run the collector separately when you want live host data:

```bash
npm run collect
```

The production templates in `systemd/` run the web server and collection jobs independently. Their
active host facts use Grimnir's bounded `<user>`, `<home>`, and `<deploy-path>` placeholders; render
and preflight them through Grimnir's `systemd_runtime` deployment contract rather than installing
the templates byte-for-byte. Private environment values remain in the host-owned env file and are
never rendered into a unit. The Python push agent is documented in `agent/README.md`.

## Configuration

Configuration is environment-based; `.env.example` documents the supported settings. The server loads `~/.heimdall/env` automatically.

Important settings:

- `HEIMDALL_BIND` and `PORT` control the listener; loopback is the safe default.
- `HEIMDALL_CONFIG_PATH` selects the service/fleet overlay.
- `HEIMDALL_CONFIG_MODE=demo` permits the committed documentation-only overlay outside production.
- `GRIMNIR_SERVICES_JSON` selects the ecosystem registry source.
- `HEIMDALL_FLEET_TOKEN` authenticates `/api/fleet/push`.
- `HEIMDALL_ALERT_TOKEN` authenticates `/api/alerts` ingestion.
- `HEIMDALL_MAINTENANCE_RESULT_TOKEN` authenticates the separate, read-only
  Brokkr v1 maintenance-evidence observer. It has no insecure-loopback mode;
  its card does not affect liveness, alerting, promotion, or actuation.
- `HEIMDALL_NOTIFY_CHAT_ID` enables task and critical-alert delivery through Ratatoskr.
- `RATATOSKR_URL` stays loopback by default; non-loopback deployments should set
  `RATATOSKR_SEND_API_KEY`.
- `HEIMDALL_STORAGE_SSH_HOST`, `HEIMDALL_STORAGE_SSH_USER`, and
  `HEIMDALL_STORAGE_SSH_KEY` are all required to enable remote storage probes. The key must be a
  dedicated, readable key: Heimdall deliberately disables SSH-agent and
  personal-key fallback, so a missing probe credential is reported as
  `ssh_broken` instead of silently borrowing broader access.
- `HOMESERVER_GATEWAY_URL` and `HOMESERVER_GATEWAY_API_KEY` enable local-inference panels.
- `HEIMDALL_SELF_HEAL_ENABLED=1` opts into recovery-task submission.

Fleet membership is authoritative from `fleet.hosts`: configured hosts remain
visible even before their first push (`never seen`), while telemetry-only rows
are retained for history and marked `retired / unregistered` when the config
reconciles. They do not contribute to fleet totals or liveness alerts. This
keeps a rename from deleting evidence or counting a stale historical identity
as another machine.

Two settings live in the JSON overlay rather than the environment:

- `fleet.host_aliases` maps retired host identities onto the canonical one
  (e.g. `{"huginmunin": "control-node"}`). One machine must have one identity, or
  its metric series and alerts split and orphaned alerts can never be resolved.
- A timer service may declare `findings_exit_codes` (e.g. `[1]`) for jobs whose
  exit status still means "I ran and found things" rather than "I could not run".
  Without it, a non-zero exit is treated as a failure — the safe default.
- `disk_volumes` is a public-safe per-metric capacity policy. Use
  `purpose: "quota_backup"` for a quota-managed backup disk, never a global
  percentage shared with an unlike filesystem.

### Alert lifecycle

An active alert is expected to be RE-ASSERTED by whatever raised it. An alert
that nobody re-asserts within `HEIMDALL_ALERT_STALE_HOURS` (default 6h) is
auto-closed as "stale — no data", with an audit event, because its host or metric
has stopped reporting and no evaluator can ever resolve it. Producers pushing to
`POST /api/alerts` should either re-push while the condition holds or send
`state: "resolved"` with the same `dedup_key`.

## Security model

Heimdall is an operator tool, not a hardened multi-user SaaS application.

- The dashboard has no built-in end-user login. Keep it on loopback or a private network, or put authenticated access control in front of it.
- A reverse proxy is not treated as a local operator. Sensitive local routes and alert dismissal validate the real socket peer and reject forwarded identity headers.
- Push endpoints fail closed unless their bearer token is configured. The insecure-loopback flags are only for isolated development.
- Self-heal is off by default. When enabled, Heimdall first persists bounded validated observation snapshots to Munin and then submits only a diagnosis-only Hugin task with resolvable `Context-refs:` to those immutable snapshots. The task's actual authority still comes from Hugin's runtime, SSH keys, and sudo policy; typed actuation remains blocked pending a reviewed allowlisted adapter. A cooldown and durable per-service reservation limit repetition but are not authorization boundaries. The current autonomous diagnosis scope is limited to local `control-node` services; remote services such as `mimir` stay excluded until host-correct restart evidence exists. Review generated tasks and grant only narrowly scoped restart permissions.
- Remote SSH probes require strict host-key checking and a dedicated known-hosts file. Prefer a restricted account and command allowlist.

See `SECURITY.md` for reporting and deployment guidance.
For secret-safe alert-ingest diagnostics and coordinated token rotation, see
[`docs/alert-token-operations.md`](docs/alert-token-operations.md).

## Service contract and API

Services may expose `<base>/heimdall.json` with identity, status, version, metrics, alert rules, panels, and links. Heimdall discovers state in this order: descriptor, `/health`, then static configuration. Heimdall exposes its own descriptor at `/heimdall.json`.

### Typed-panel input warnings

Table panel rows, including nested `detail` table rows, must be JSON objects.
Heimdall keeps valid object rows and leniently discards non-object rows for
compatibility, but never silently: a
`POST /api/panels` response includes a content-blind warning, while a
descriptor-backed service page shows a **Panel input warnings** card. The
normalized descriptor snapshot carries `panel_warnings` records with only
`{ panel, reason, count }`; discarded row and cell contents are never stored or
displayed. Producers should treat these warnings as a contract error and send
object rows rather than `string[][]`.

Primary pages are `/`, `/services`, `/fleet`, `/alerts`, `/events`, `/insights`, `/projects`, and `/consolidation`. The public read interface is intentionally broad for a trusted operator network; mutation and ingest routes have the additional controls described above.

## Development

```bash
npm test
npm run lint
```

The stack is Fastify, HTMX, Chart.js, better-sqlite3, and a small Python fleet agent. See `docs/architecture-v2.md` for the component model, `docs/metrics.md` for metrics semantics, and `CONTRIBUTING.md` for contribution expectations.

## Status and limitations

Heimdall is actively used and has broad automated coverage. Before a new deployment, operators still need to supply their inventory, tokens, ingress policy, and least-privilege SSH/systemd configuration. Provider-specific ingress monitoring and autonomous recovery remain explicit opt-ins.

Heimdall's original code is licensed under the MIT License. Vendored browser
assets retain their upstream permissive terms; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
