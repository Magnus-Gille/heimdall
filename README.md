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
- `HEIMDALL_NOTIFY_CHAT_ID` enables task and critical-alert delivery through Ratatoskr.
- `RATATOSKR_URL` stays loopback by default; non-loopback deployments should set
  `RATATOSKR_SEND_API_KEY`.
- `HEIMDALL_STORAGE_SSH_HOST` and `HEIMDALL_STORAGE_SSH_USER` enable remote storage probes.
- `HOMESERVER_GATEWAY_URL` and `HOMESERVER_GATEWAY_API_KEY` enable local-inference panels.
- `HEIMDALL_SELF_HEAL_ENABLED=1` opts into recovery-task submission.

Two settings live in the JSON overlay rather than the environment:

- `fleet.host_aliases` maps retired host identities onto the canonical one
  (e.g. `{"huginmunin": "control-node"}`). One machine must have one identity, or
  its metric series and alerts split and orphaned alerts can never be resolved.
- A timer service may declare `findings_exit_codes` (e.g. `[1]`) for jobs whose
  exit status still means "I ran and found things" rather than "I could not run".
  Without it, a non-zero exit is treated as a failure — the safe default.

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
- Self-heal is off by default. When enabled, Heimdall only submits a task; the task's actual authority comes from Hugin's runtime, SSH keys, and sudo policy. A cooldown limits repetition but is not an authorization boundary. Review generated tasks and grant only narrowly scoped restart permissions.
- Remote SSH probes require strict host-key checking and a dedicated known-hosts file. Prefer a restricted account and command allowlist.

See `SECURITY.md` for reporting and deployment guidance.
For secret-safe alert-ingest diagnostics and coordinated token rotation, see
[`docs/alert-token-operations.md`](docs/alert-token-operations.md).

## Service contract and API

Services may expose `<base>/heimdall.json` with identity, status, version, metrics, alert rules, panels, and links. Heimdall discovers state in this order: descriptor, `/health`, then static configuration. Heimdall exposes its own descriptor at `/heimdall.json`.

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
