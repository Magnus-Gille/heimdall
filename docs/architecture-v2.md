# Heimdall v2 — Architecture

> **Status:** implemented design record (2026-06-23). Supersedes `architecture.md` (v1.2).
> The README and tests are authoritative where the implementation has evolved beyond this brief.

---

# Heimdall v2 — Architecture Design Brief

**Deployment model:** single trusted operator · **Status:** implemented design record
**Locked decisions (do not re-litigate):** big-bang rewrite around a clean platform model · self-describing service contract + generic renderer · tiny push-agent fleet telemetry · keep Fastify+HTMX+Chart.js server-rendered, add a real design system.

---

## 1. DIAGNOSIS — why v1 breaks on every new service

v1 is a functional dashboard whose cost-to-extend scales linearly (often super-linearly) with the number of services, because *every* axis of a service is hardcoded in a different place. Adding a service touches 4–6 files with no single seam.

1. **Cards have no registry — they are triple-declared.** Each card is a `<div hx-get>` placeholder hand-written into a page-shell string, *plus* an `app.get('/api/card/<name>')` route in `server.js`, *plus* a renderer in `html.js`. Nothing ties them together; the grid can't be generated, reordered, or driven by config. Adding one card = edits in three disjoint locations.

2. **Integration logic is per-service copy-paste across three incompatible transport patterns.** HTTP+TTL (`m5.js`, `munin-projects.js`, `skuld-briefing.js` are near-identical `muninRpc()` clones), SSH+positional-stdout (`metrics.js` parses NAS output by section index 0–18 — adding a metric means inserting `echo "---"` at the right index and renumbering everything downstream), and direct-SQLite (`hugin.js` reopens `~/.munin-memory/memory.db` per call). Zero shared fetch/parse utilities; six bespoke parsers.

3. **The health/alert "2-failure streak → alert" pattern is duplicated verbatim** in `mcp-probe.js` and `inference.js` with the same `SELECT value FROM metrics … ORDER BY id DESC LIMIT 2` query, differing only in host/metric strings. There is no per-service threshold registry; alert titles like `"M5 inference gateway unhealthy"` are string literals in code.

4. **Config and code disagree on what a service is.** `heimdall.config.json` has a `services[]` array (name/host/health_url/repo/deploy_path), but `deployments.js` ignores it and keeps its *own* parallel `LOCAL_SERVICES`/`REMOTE_SERVICES`/`GRIMNIR_REPOS` arrays. Critical endpoints (NAS IP `192.0.2.20`, ratatoskr `192.0.2.10:3034`, M5 gateway, Munin MCP URL — duplicated in four files) are hardcoded in JS, not config.

5. **Heimdall hardcodes domain knowledge that the service should advertise.** M5's `KNOWN_MODELS` column order, `STATIC_FINDINGS`, the `mellum` model name, the `host='m5'` storage key, and Prometheus metric names (`homeserver_*`) all live in Heimdall source. The service can't evolve without a Heimdall code change.

6. **No fleet telemetry abstraction.** Only a control node (local `/proc`) and storage node (SSH pull) were covered; an inference host was partial via its gateway, while other edge and intermittent hosts were invisible. Each new machine would have meant another bespoke pull path.

The CSS has the same disease at the presentation layer: one flat ~2800-line file, per-feature namespaced selectors (`.dep-*`, `.proj-*`, `.m5-*`, `.reader-*`), no component abstraction, theme-toggle script copy-pasted into every page.

**Design consequence:** v2 must collapse all six axes onto *one* declarative seam — a service descriptor the service itself serves — and one generic renderer that consumes it.

---

## 2. TARGET ARCHITECTURE (overview)

Heimdall v2 is a **renderer over a contract**, not a collection of integrations. Services describe themselves; machines push their own telemetry; Heimdall discovers, persists, evaluates, and renders generically. Per-service code exists *only* as optional "panel plugins" for genuinely domain-specific views (the M5 inference matrix being the canonical case). Everything proven in v1 is reused as a primitive: `better-sqlite3`+WAL, `esc()`, the HTMX card-fragment + `onSend` JSON-unwrap hook, the `/api/metrics/:host/:metric` + LTTB-downsample + Chart.js endpoint, and systemd deploy.

```
                         ┌───────────────────────────────────────────┐
  push agents (fleet) ──►│  INGEST API   POST /api/fleet/push         │
  (Pi/macOS/Jetson/m5)   │               POST /api/alerts (Ratatoskr) │
                         └──────────────┬────────────────────────────┘
                                        │ writes
  service descriptors ──► DISCOVERY ───►│   ┌──────────────────┐
  GET <svc>/heimdall.json   (poller     │   │  SQLite (WAL)    │
  (config lists URLs)        every Ns)  └──►│  fleet_metrics   │
                                        ┌──►│  service_snapshot│
  threshold rules ──► ALERT ENGINE ─────┘   │  alerts, deploy  │
  (declared per service/metric)             │  metrics/rollup  │
                                        ┌───┴──────────────────┘
                                        │ reads
                          GENERIC RENDERER  (Fastify + HTMX + Chart.js)
                          ┌──────────────┴───────────────┐
                          │ fleet grid │ service pages    │ alert surface
                          │            │ (template + opt. │
                          │            │  panel plugin)   │
                          └──────────────────────────────┘
                                  DESIGN SYSTEM (tokens / status semantics / grid)
```

- **Ingest API** — two POST endpoints: `/api/fleet/push` (machine telemetry) and `/api/alerts` (structured alerts forwarded by Ratatoskr/services). Bearer-auth, Tailscale-bound.
- **Discovery / service registry** — `heimdall.config.json` lists each service's `heimdall.json` URL; a poller fetches descriptors on a cadence and snapshots them to DB. Services with no descriptor degrade to config-only.
- **Alert engine** — evaluates declared threshold rules against `fleet_metrics`/`metrics` (replacing the copy-pasted streak logic) *and* ingests service-pushed alerts. Single `alerts` table backs both.
- **Generic renderer** — one `servicePage(descriptor)` template + a card registry; archetype determines which generic blocks render; optional panel plugins add domain views.
- **Push-agent fleet** — tiny per-OS agents POST a canonical payload; server tracks `last_seen`/offline with per-machine `always_on`.
- **DB** — v1 schema kept and extended with `fleet_metrics` and `service_snapshots`.

---

## 3. THE SERVICE CONTRACT

### 3.1 Endpoint

Every Grimnir service SHOULD serve **`GET /heimdall.json`** returning `application/json`. This is deliberately *separate* from `/health`: `/health` stays IETF `health+json` for liveness/readiness (and existing health clients), while `/heimdall.json` is the richer dashboard descriptor that *embeds* the health summary plus rendering hints, deploy context, owned-metrics declarations, panels, links, and alert-rule hints. Rationale: liveness probes must be cheap and dependency-free; the descriptor can be richer and is polled less often.

> A service MAY serve only `/health` (health+json). Heimdall treats a compliant `/health` as a minimal descriptor (status + version + checks) and fills identity/archetype from config. A service MAY serve neither — see §3.4 graceful degradation.

### 3.2 Schema

```jsonc
{
  "_schema": "https://monitor.example.com/schema/service/v1",   // versioning anchor

  // --- IDENTITY ---
  "service": {
    "name": "m5-gateway",            // stable logical id (OTel service.name)
    "label": "M5 Inference",         // display name
    "namespace": "grimnir",
    "instance_id": "m5",             // host/box id; also the metrics `host` key
    "criticality": "high"            // high | normal | low  → alert routing + sort
  },

  // --- ARCHETYPE: selects which generic page blocks render ---
  "kind": "inference",               // inference | http-service | timer | static | mcp

  // --- STATUS (IETF health+json core, embedded) ---
  "status": "pass",                  // pass | warn | fail
  "output": "",                      // error detail on warn/fail
  "checks": {                        // health+json checks extension (sub-components)
    "gpu:loaded_models": [{ "status": "pass", "observedValue": 2, "time": "..." }],
    "disk:free":         [{ "status": "pass", "observedValue": 120, "observedUnit": "GiB", "time": "..." }]
  },

  // --- VERSION / DEPLOY ---
  "version": "1.4.2",                // public semver (optional)
  "deploy": {
    "deployed_commit": "abc1234",    // what is RUNNING (releaseId)
    "latest_commit":   null,         // Heimdall fills from git if null
    "drift": null,                   // Heimdall computes commits-behind; service may pre-fill
    "deployed_at": "2026-06-23T08:00:00Z",
    "host": "m5",
    "systemd_unit": "gille-inference",
    "platform": "bare-metal"         // docker | k8s | bare-metal
  },

  // --- METRICS this service OWNS (drives generic metric rows + charts) ---
  // Optional `value` (scalar reading) + `updated_at` (ISO) render a LIVE value
  // in the metric row; omit them for a definition-only row. (#108)
  "metrics": [
    { "key": "inference_latency_ms", "label": "Probe latency", "unit": "ms",
      "kind": "gauge", "chart": true, "value": 234.5,
      "updated_at": "2026-07-05T10:00:00Z" },
    { "key": "inference_avg_tok_per_sec", "label": "Throughput", "unit": "tok/s",
      "kind": "gauge" },
    { "key": "inference_recent_pass_rate", "label": "Recent pass", "unit": "%",
      "kind": "gauge", "warn": { "lt": 70 }, "crit": { "lt": 40 } }
  ],

  // --- ALERT RULES (declarative; replaces hardcoded streak logic) ---
  "alerts": {
    "rules": [
      { "metric": "inference_healthy", "op": "==", "value": 0,
        "streak": 2, "severity": "error",
        "title": "M5 inference gateway unhealthy" }
    ],
    "active_count": 0,
    "firing": []                     // service may also push live alerts (§6)
  },

  // --- PANELS: optional domain-specific plugin views (zero in the common case) ---
  "panels": [
    { "id": "m5-capability-map", "label": "Capability matrix",
      "plugin": "inference", "source": "/ledger", "refresh": 300, "fullWidth": true },
    { "id": "m5-models",  "plugin": "inference", "source": "/models",  "refresh": 60 },
    { "id": "m5-usage",   "plugin": "inference", "source": "/metrics", "refresh": 60, "fullWidth": true }
  ],

  // --- LINKS: service advertises its own endpoints (never hardcoded by Heimdall) ---
  "links": {
    "self":    "http://192.0.2.30:8080/heimdall.json",
    "health":  "http://192.0.2.30:8080/healthz",
    "metrics": "http://192.0.2.30:8080/metrics",
    "ledger":  "http://192.0.2.30:8080/ledger",
    "repo":    "https://github.com/Magnus-Gille/gille-inference",
    "docs":    null
  },

  // --- UI HINTS ---
  "ui": { "icon": "cpu", "category": "ai", "color": "#7c3aed" }
}
```

**Field grounding in IETF health+json + OTel:** `status`/`checks`/`version`/`output` are pure health+json; `deploy.deployed_commit` is health+json `releaseId`; `service.name/namespace/instance_id/criticality` mirror OTel resource attributes 1:1 so the same values can flow into traces/logs later. `links` follows the health+json `links` convention — Heimdall reads `links.metrics` rather than hardcoding `/metrics`.

### 3.3 Discovery & versioning

- **Discovery is config-driven, not auto-discovered.** `heimdall.config.json` gains a `descriptor_url` per service (defaulting to `<health_url base>/heimdall.json`). A discovery poller fetches each descriptor on a per-archetype cadence (HTTP services 60s, timers 300s, M5 panels per their `refresh`), validates `_schema`, and writes a row to `service_snapshots`. Pages read the snapshot — no live fetch on page render in the common case (live fetch reserved for panel plugins like the capability map, exactly as today).
- **Versioning:** `_schema` carries a version URL; Heimdall accepts `v1` and ignores unknown fields (forward-compatible). A descriptor whose `_schema` major version Heimdall doesn't recognize is rendered config-only with a "schema vN unsupported" note.
- **`deploy.drift`:** if the service leaves `latest_commit`/`drift` null, Heimdall fills them from git (`service_versions`/deploy state), preserving v1's drift capability. If the service pre-computes them, Heimdall trusts the service.

### 3.4 Graceful degradation (no endpoint)

A service is renderable from `heimdall.config.json` alone. Degradation ladder:

1. **Full descriptor** → fully generic render, all blocks.
2. **`/health` only (health+json)** → status + version + checks render; identity/archetype/links from config; metrics from whatever Heimdall already collects under `instance_id`.
3. **No HTTP at all (timers, CLIs)** → `kind: "timer"` in config; status derived from systemd journal + Munin result key (`briefings/latest`, `maintenance/os/*`); deploy from git. This is exactly the data the current `deployments.js`/`drift.js` already produce — repackaged behind the same template.
4. **Config-only, unreachable** → grey "unknown" card with last-known snapshot and `last seen X ago`. Never a hard error (preserves v1's per-card graceful-degradation behavior).

### 3.5 Concrete examples

**(a) Long-running HTTP service — `munin-memory`:**

```json
{
  "_schema": "https://monitor.example.com/schema/service/v1",
  "service": { "name": "munin-memory", "label": "Munin", "namespace": "grimnir",
               "instance_id": "control-node", "criticality": "high" },
  "kind": "http-service",
  "status": "pass",
  "version": "0.9.0",
  "deploy": { "deployed_commit": "5e1c0aa", "latest_commit": null, "drift": null,
              "host": "control-node", "systemd_unit": "munin-memory", "platform": "bare-metal" },
  "checks": { "db:fts5": [{ "status": "pass" }],
              "db:entries": [{ "status": "pass", "observedValue": 1842, "observedUnit": "rows" }] },
  "metrics": [
    { "key": "munin_entry_count", "label": "Entries", "unit": "rows", "kind": "gauge", "chart": true },
    { "key": "munin_db_size_mb",  "label": "DB size", "unit": "MB",  "kind": "gauge" }
  ],
  "alerts": { "rules": [ { "metric": "http_healthy", "op": "==", "value": 0,
                           "streak": 2, "severity": "error", "title": "Munin unhealthy" } ],
              "active_count": 0, "firing": [] },
  "panels": [],
  "links": { "self": "http://localhost:3030/heimdall.json", "health": "http://localhost:3030/health",
             "repo": "https://github.com/Magnus-Gille/munin-memory" },
  "ui": { "icon": "database", "category": "infra" }
}
```
No `panels` → renders entirely from the generic template, zero per-service code.

**(b) M5 inference box** — the descriptor in §3.2. The three `panels` (`m5-capability-map`, `m5-models`, `m5-usage`) all reference `plugin: "inference"` — the only service-specific code in the system, kept in `src/plugins/inference.js`.

### 3.6 The real catalog → 5 archetypes

| `kind` | Members | Generic page shows |
|---|---|---|
| **`inference`** | M5 gateway, control-node Ollama, Orin Ollama, laptop LM Studio | status+latency · models downloaded/loaded · tok/s · queue/idle · (gateway: ledger summary, capability matrix via plugin) |
| **`http-service`** | munin-memory, hugin, heimdall, ratatoskr, verdandi, mimir | up/down+latency · deployed vs latest commit (drift) · version stamp · 1 key domain metric (Munin entries, Hugin queue depth, Ratatoskr `bot_connected`, Verdandi chain head) · last-seen-healthy · systemd state |
| **`timer`** | skuld, grimnir-{security-scan,validate,maintenance-os,maintenance-deps}, hugin-daily-analysis, heimdall-{collect,maintain} | last-run time + exit status · next scheduled run (`systemctl show`) · run duration · failure streak · result summary from Munin key |
| **`static`** | tallriksvis | HTTP 200 reachability · live commit · CF Access/DNS status |
| **`mcp`** | munin-memory (dual), skald-display, fortnox-mcp | MCP transport reachability (the existing `mcp-probe.js` path) · tool/capability list · skald-display: last render, current layout |

`munin-memory` is dual-kind (`http-service` + `mcp`); a service may declare a secondary `kind` and get both block sets.

---

## 4. FLEET / HW VIEW + PUSH-AGENT

### 4.1 The agent

**Language: Python 3.10+ (one ~100-line script per OS-family, shared push harness).** Rationale: the fleet is heterogeneous (Pi aarch64, macOS Apple Silicon, Jetson L4T) and the Jetson's only good telemetry API (`jtop`) is Python-only; Go would force CGO+Objective-C for macOS SMC temps, complicating the Jetson build; shell can't parse temps robustly across three platforms. `urllib.request` (stdlib) does the POST — no HTTP dependency. `psutil` covers CPU/RAM/uptime/load/disk on Linux+macOS.

```
agent/
  core.py            # collect → POST → sleep(interval); platform-detect at startup
  collectors/linux.py   # psutil + /sys/class/thermal/thermal_zone*/temp
  collectors/macos.py   # psutil + `macmon --json --count 1` for temp (no sudo)
  collectors/jetson.py  # jtop daemon socket → GPU%, per-zone temp, power_w
  config.env         # HUB_URL, TOKEN, INTERVAL, ALWAYS_ON
```

Platform detection: `platform.system()=="Darwin"` → macOS; `/etc/nv_tegra_release` exists → Jetson; else Linux.

**Per-OS reads:**

| OS / node | CPU | RAM | uptime | temp | load | disk | extra |
|---|---|---|---|---|---|---|---|
| Pi5 (control-node, nas), Pi Zero (munin-zero) | `/proc/stat` | `/proc/meminfo` | `/proc/uptime` | `/sys/class/thermal/thermal_zone0/temp` | `/proc/loadavg` | `df -Pk` | — |
| macOS laptop | psutil | psutil | `kern.boottime` | `macmon --json` (no sudo); **omit if macmon absent** | psutil | `df -Pk` | `thermal_state` (nominal/fair/serious/critical) |
| Jetson Orin | `/proc/stat` | `/proc/meminfo` (unified) | `/proc/uptime` | `jtop` per-zone (CPU/GPU/AO) | `/proc/loadavg` | `df -Pk` | `gpu_pct`, `power_w`, `gpu_ram_*` |
| **m5** | — *(no separate agent)* — extend the existing gateway `/healthz` (Linux `/proc` + `k10temp`/`amdgpu` hwmon) to also POST the fleet payload; the gateway process is already running | | | | | | `temp_gpu_c` |

macOS-no-thermal is handled by **omitting** `temp_cpu_c` when `macmon` is unavailable — a missing field renders as "—", never an error. **control-node and nas need no remote agent** (control-node collects locally; nas keeps the SSH pull as a fallback) but for uniformity may run the same agent locally.

**Interval:** 30s default (graphs meaningful, Pi-Zero-cheap). **Auth:** Tailscale provides mutual TLS implicitly; add `Authorization: Bearer <token>` as a cheap second factor, per-agent token in `config.env`. **Failure mode:** push fails → log to stderr, exit 0; next tick retries. No retry loop; server-side `last_seen` staleness is the signal. **Service manager:** systemd `Restart=on-failure` on Pi/Jetson; user-level `launchd` plist on macOS (no sudo). **Orin caveat:** LAN-only today (`198.51.100.12`); recommend `tailscale up` on the Orin so the agent can reach the Tailscale-bound ingest. Until then, bind ingest on the LAN IP too, or keep SSH pull as fallback.

### 4.2 Ingest endpoint + schema

```
POST /api/fleet/push       Authorization: Bearer <token>     (Tailscale-bound)
Content-Type: application/json
```

```json
{
  "hostname": "control-node", "os": "linux", "platform": "pi5",
  "ts": "2026-06-23T07:00:00Z",
  "cpu_pct": 4.2,
  "ram_total_mb": 8096, "ram_used_mb": 950, "ram_used_pct": 11.7,
  "uptime_s": 876300,
  "load_1": 0.08, "load_5": 0.02, "load_15": 0.01,
  "temp_cpu_c": 42.2,
  "disk": [{ "mount": "/", "total_mb": 59392, "used_mb": 6042, "used_pct": 10.2 }],
  "extra": { "temp_gpu_c": 38.0, "gpu_pct": 22, "power_w": 15.3, "thermal_state": "nominal" }
}
```

`extra` carries platform-specific fields. Ingest is bounded before persistence: request bodies are limited to 64 KiB, disks to 32 entries, and `extra` to 32 shallow scalar keys (nested objects/arrays are dropped; strings are truncated). Server stamps `last_seen = received_at` and fans the scalar fields into `fleet_metrics` rows (so the existing `/api/metrics/:host/:metric` chart endpoint works for fleet data too).

### 4.3 Per-machine model + offline/laptop handling

Each machine has a config record: `{ hostname, label, always_on: bool, role }`. State is derived from `now - last_seen`:

| State | Condition | Badge |
|---|---|---|
| **online** | `last_seen < 90s` (3× interval) | green ✓ |
| **stale** | `90s ≤ last_seen < threshold` | amber ▲ "stale, last seen Xm ago" |
| **offline** | `last_seen ≥ threshold` **and** `always_on` | red ● + **alert** |
| **sleeping** | `last_seen ≥ threshold` **and** `!always_on` | grey ? "sleeping, last seen Xm ago" — **no alert** |

Always-on hosts (`always_on: true`) alert after prolonged silence. An intermittent laptop (`always_on: false`) only greys to "sleeping" after its configured window and never produces an offline alert. This flag makes intermittent machines first-class citizens rather than permanent false positives.

### 4.4 Fleet card UI

Top of the fleet view: aggregate badge strip (`3 ●  1 ▲  42 ✓`). Below: `repeat(auto-fit, minmax(280px, 1fr))` grid, **sorted critical → warning → stale → healthy**, then alphabetical. Each card: status dot + shape + hostname · IP · platform · CPU meter · RAM meter · inline server-rendered SVG sparkline (reusing v1's `sparklineSvg`) · `last seen`. Card is a plain `<a href>` to the machine's service page. Grid polls `hx-get="/fleet" hx-trigger="every 30s"`.

---

## 5. SERVICE PAGE TEMPLATE

One reusable `servicePage(descriptor)` generalized from `/m5`. Fixed block order; each block renders only if the descriptor/archetype provides its data:

```
┌─ STATUS HEADER ────────────────────────────────────────────┐
│  ✓ <label>  ·  v<version>  ·  <kind>  ·  checked Xs ago    │  ← status+shape+text, latency
├─ DEPLOYMENT-STATUS BLOCK ──────────────────────────────────┤
│  Running · enabled · uptime 3h · RSS 84MB                  │  ← systemd state
│  deployed abc1234  →  latest def5678   (2 behind, dirty)  │  ← drift from deploy.* / git
├─ LIVE METRICS ─────────────────────────────────────────────┤
│  generic metric rows + charts, one per descriptor.metrics[]│  ← threshold-colored meters
├─ ARCHETYPE / PLUGIN PANELS ────────────────────────────────┤
│  rendered ONLY if descriptor.panels[] present              │  ← inference matrix etc.
├─ LINKS ────────────────────────────────────────────────────┤
│  health · metrics · repo · docs  (from descriptor.links)  │
└─ ALERTS (this service) ────────────────────────────────────┘
   active alerts for this service, severity-sorted
```

The page is a **card registry** driven by the descriptor: `[statusHeaderCard, deployCard, ...metricsCards(descriptor.metrics), ...pluginCards(descriptor.panels), linksCard, serviceAlertsCard]`. Each entry is `{ id, endpoint, refresh, fullWidth }` — the grid is generated, not hand-written.

**Same template, four renders:**

- **M5 (`inference`):** status header (from collected `inference_*` metrics) · deploy block (systemd `gille-inference` + git) · metric rows (latency, tok/s, pass-rate) · **plugin panels** (`m5-capability-map`, `m5-models`, `m5-usage` — live `/ledger`/`/models`/`/metrics` via `inference` plugin) · links · alerts. *All v1 /m5 behavior preserved; only the shell is now generic.*
- **`http-service` (hugin):** status header · deploy block (drift) · one metric row (queue depth) · **no panels** · links · alerts. Zero per-service code.
- **`timer` (skuld):** status header = last-run + exit status · deploy block (git only, no systemd "running") · metric rows = run duration, failure streak · result summary panel (read from Munin `briefings/latest` via a tiny generic "munin-key" panel, not a bespoke module) · links · alerts.
- **`static` (tallriksvis):** status header = HTTP 200 reachability · deploy block (live commit) · no metrics · no panels · links (live URL) · alerts.

`STATIC_FINDINGS`, `KNOWN_MODELS`, `mellum`-for-findings all move into the `inference` plugin — they leave the core entirely.

---

## 6. ALERTS via RATATOSKR

### 6.1 Standard alert envelope

Ratatoskr today accepts only `{ chat_id, text }` at `POST /api/send` and ignores unknown fields (backwards-compatible). v2 formalizes an optional `alert` object — **services and Heimdall POST this; Ratatoskr forwards `text`/renders from the envelope AND echoes it to Heimdall's `/api/alerts` for durable display:**

```json
{
  "chat_id": 123456789,
  "alert": {
    "state": "firing",                      // firing (default) | resolved
    "severity": "warn",                     // info | warn | error | critical
    "source": "m5-gateway",                 // service name
    "title": "M5 recent pass rate < 70%",
    "body": "Recent pass rate 58% over last 12 evals.",
    "dedup_key": "m5:pass-rate-low",        // collapses repeats
    "ts": "2026-06-23T09:15:00Z",
    "links": [{ "label": "M5 page", "url": "https://monitor.example.com/service/m5-gateway" }]
  }
}
```

Ratatoskr renders `text` from the envelope when `text` is absent, dedups on `dedup_key` (the missing piece v1 lacked at the bus layer), and persists/forwards to Heimdall.

### 6.2 Two alert sources, one table

1. **Heimdall-derived (threshold):** the alert engine evaluates `descriptor.alerts.rules` and `metrics[].warn/crit` against `metrics`/`fleet_metrics` on each collector cycle. This *replaces* the copy-pasted "2-failure streak" logic with one generic evaluator reading declared `{ metric, op, value, streak, severity, title }`. On fire/clear it writes the `alerts` table and POSTs the envelope to Ratatoskr.
2. **Service-pushed:** a service (or fleet agent) POSTs the envelope to **`POST /api/alerts`** directly; Heimdall persists it to the same `alerts` table keyed by `dedup_key`.

Both land in one `alerts` table → one alert surface. This is purely additive to the current notify path: persist-then-forward.

Producers clear a service-pushed condition through the same authenticated endpoint with `{ "state": "resolved", "dedup_key": "..." }`. Resolution is idempotent and requires the stable key; a title is required only for `firing` envelopes.

### 6.3 Alert surface UI

A dedicated **Alerts tab** (`/alerts`), not a sticky per-page strip — on a busy estate a handful of always-on warnings (e.g. deploy drift) buried every page below the fold. The nav carries a live count **badge** (`/api/alerts/count`, coloured crit→warn→info by the most severe pending alert) so the at-a-glance signal survives. The tab lists one consolidated line per `dedup_key`, severity-sorted (critical→warning→info), `role="region" aria-label="Active alerts"`, critical rows `role="alert"`; it self-refreshes via `/api/alerts/list` (`hx-trigger="every 30s"`).

**Dismiss = acknowledge, not resolve.** `hx-delete="/api/alerts/:id"` sets `acknowledged`; it does *not* set `resolved_at`. Engine-driven alerts re-fire every collector cycle, so a resolve would bounce straight back ("the × doesn't close them"). Acknowledge survives the re-fire (`createAlert` UPDATEs the existing active row without touching the flag), so a dismissed alert stays hidden until the condition genuinely clears and recurs (a fresh row, `acknowledged=0`).

Acknowledgement is scoped to the **Alerts tab + nav badge** only — both read **`getUnacknowledgedAlerts`** (active AND not acknowledged). The **Overview status banner, the Overview alert count, `computeOverallStatus`, and the agent-facing `/api/status` + `/api/alerts` JSON** all keep reading the raw **`getActiveAlerts`** list: dismissing means "I've seen it", not "it's fine", so the overall-status signal stays a true-health view and a silenced-but-active condition is never fully invisible. Reuses v1's `alerts` table.

---

## 7. UI / DESIGN SYSTEM

Three-layer tokens (primitives → semantic → component); themes swap the semantic layer only. Server-rendered, HTMX-driven, no SPA. Keep the v1 `data-theme` + `prefers-color-scheme` toggle but extract it to one shared `/static/app.js` (kill the copy-paste).

**Tokens (semantic excerpt):**
```css
:root {
  /* status — color is ONE axis; always paired with shape + text */
  --color-status-ok:    #10B981;  --color-status-warn:  #F59E0B;
  --color-status-crit:  #EF4444;  --color-status-info:  #2563EB;
  --color-status-stale: #9CA3AF;
  /* surfaces (light) */
  --surface-base:#fff; --surface-raised:#F3F4F6; --surface-overlay:#E5E7EB;
  /* type scale */ --text-xs:.75rem; --text-sm:.875rem; --text-base:1rem;
  --text-lg:1.25rem; --text-xl:1.5rem; --text-2xl:2rem; /* KPIs */
  /* spacing (4px base) */ --space-1:.25rem; --space-2:.5rem; --space-4:1rem; --space-6:1.5rem;
  /* radii */ --radius-sm:4px; --radius-md:8px; --radius-pill:9999px;
  --shadow-card:0 1px 3px rgb(0 0 0/.1);
}
[data-theme="dark"] {                /* surfaces step ~5-8% L per level */
  --surface-base:#0F0F0F; --surface-raised:#1A1A1A; --surface-overlay:#242424;
  --color-status-ok:#34D399; --color-status-warn:#FBBF24; --color-status-crit:#F87171; --color-status-info:#60A5FA;
}
```
v1's Tokyo Night palette is preserved as the dark theme's *primitive* values; the semantic layer is new.

**Status semantics (WCAG 1.4.1 — never color alone):**

| State | Color | Shape | Text |
|---|---|---|---|
| Healthy | green | ✓ | "Healthy" |
| Warning | amber | ▲ | "Warning" |
| Critical | red | ● | "Critical" |
| Unknown/Stale | grey | ? | "Unknown" |

(Offer the Wong-palette blue/amber/vermillion as an opt-in colorblind-safe theme — same tokens, different primitives.)

**Grid:** `repeat(auto-fit, minmax(280px, 1fr))` (`auto-fit` collapses empty tracks) — media-query-free, 1-col on phone, 3–4 on desktop. Full-width cards `grid-column: 1/-1` (kept from v1).

**Overview → zoom → details (Shneiderman):** top-left aggregate health strip answers "is anything broken?" in <3s without scrolling → fleet/service grid (RAG cards, sparklines, exception counts not exhaustive lists, "3/3 healthy" as positive signal) → click a card for the per-service drill-down page. KPI numerals 24–32px. Server-rendered SVG sparklines + meters (threshold color from server-set `style`, no client logic). Loading skeletons + explicit empty states are mandatory (their absence reads as breakage).

**CSS structure:** split the flat 2800-line file into `tokens.css` / `layout.css` / `components.css` (card, meter, badge, status-dot, metric-row, sparkline) / page-specific. Per-feature namespaced selectors (`.m5-*` etc.) collapse into shared components.

---

## 8. DATA MODEL / DB CHANGES

Keep `better-sqlite3` + WAL at `~/.heimdall/heimdall.db`. **Keep unchanged:** `metrics`, `metrics_rollup`, `events`, `alerts`, `service_versions`, `process_snapshots`, and the `getLatestMetrics`/`getMetricHistoryWithRollup`/`getActiveAlerts` helpers. **Wrap all ad-hoc inline SQL** (iowait, sparklines, deploy-status queries) into named helpers in `db.js`.

**New tables:**

```sql
-- raw fleet pushes (last_seen + scalar metrics also fanned into `metrics` for charts)
CREATE TABLE IF NOT EXISTS fleet_metrics (
  id INTEGER PRIMARY KEY, timestamp TEXT, hostname TEXT,
  cpu_pct REAL, ram_used_pct REAL, ram_total_mb REAL, ram_used_mb REAL,
  uptime_s INTEGER, load_1 REAL, load_5 REAL, load_15 REAL,
  temp_cpu_c REAL, temp_gpu_c REAL,
  disk TEXT,            -- JSON array of {mount,total_mb,used_mb,used_pct}
  extra TEXT,           -- JSON: gpu_pct, power_w, thermal_state, ...
  received_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fleet_host_ts ON fleet_metrics(hostname, timestamp);

-- one latest-known descriptor snapshot per service (read at page render)
CREATE TABLE IF NOT EXISTS service_snapshots (
  service TEXT PRIMARY KEY, kind TEXT, status TEXT,
  descriptor TEXT,      -- full /heimdall.json JSON blob
  fetched_at TEXT, reachable INTEGER, schema_version TEXT
);

-- fleet machine config + derived liveness (always_on drives offline vs sleeping)
CREATE TABLE IF NOT EXISTS fleet_hosts (
  hostname TEXT PRIMARY KEY, label TEXT, role TEXT,
  always_on INTEGER DEFAULT 1, last_seen TEXT, state TEXT  -- online|stale|offline|sleeping
);
```

`alerts` gains `dedup_key TEXT` and `source TEXT` (additive) to back consolidation and service-pushed alerts. **Retention** (reuse `heimdall-maintain` daily prune+vacuum): `fleet_metrics` raw kept 7d → rolled into existing `metrics_rollup` beyond 7d (push 30s data is dense — rollup is essential); `service_snapshots` keeps only latest per service (history not needed); `alerts` resolved >30d pruned.

---

## 9. PHASED IMPLEMENTATION PLAN

A rewrite, sequenced so each phase ships a working dashboard and nothing is removed until its replacement is proven. M5 is the reference vehicle throughout (richest service, owner cares most).

**P0 — Scaffolding + design system.** New `src/app.js` Fastify bootstrap; keep `esc()`, `onSend` hook, `/api/metrics/:host/:metric` + `charts.js` verbatim. Build the token files (`tokens/layout/components.css`), `pageShell(title, activePage, content)`, shared `/static/app.js` (theme toggle once), card-registry primitive. *Deliverable:* current dashboard re-rendered through the new shell + tokens; visual parity verified via Playwright screenshot. *Files:* new `src/render/shell.js`, `src/render/cards.js`, `static/css/*`.

**P1 — Fleet view + push-agent (M5 first).** `POST /api/fleet/push` (Bearer, Tailscale-bound) + `fleet_metrics`/`fleet_hosts` tables + state machine (online/stale/offline/sleeping). Ship the m5 gateway `/healthz` extension first (no new process), then `collectors/linux.py` on the two Pis, then `macos.py` on the laptop (validate sleeping/never-alert), then `jetson.py` (after Orin Tailscale enrollment). Fleet grid UI. *Deliverable:* every machine on one fleet page with correct offline/sleeping semantics. *Files:* `agent/` tree, `src/ingest/fleet.js`, `src/render/fleet.js`, `db.js`.

**P2 — Service contract + generic renderer (port M5 as reference).** Define `v1` schema + validator; add `/heimdall.json` to one service (start with heimdall itself, then munin-memory) and the M5 gateway; discovery poller → `service_snapshots`; `servicePage(descriptor)` template + the five archetype block sets; `inference` panel plugin holding all of `src/m5.js` + the matrix/models/usage panels. Port `/m5` onto the generic template — behavior-for-behavior parity is the acceptance test. Then render hugin/ratatoskr/verdandi/mimir/skuld/static generically. *Files:* `src/contract/schema.js`, `src/discovery.js`, `src/render/service-page.js`, `src/plugins/inference.js`.

**P3 — Alert bus.** Generic alert engine reading declared `rules`/thresholds (retire the duplicated streak logic in `inference.js`/`mcp-probe.js`); `dedup_key`+`source` on `alerts`; `POST /api/alerts` ingest; standard envelope in `notify.js`; consolidated alert-strip UI. Coordinate the Ratatoskr-side envelope acceptance + echo. *Files:* `src/alerts/engine.js`, `src/ingest/alerts.js`, `notify.js`, Ratatoskr `/api/send`.

**P4 — Cutover + retire ad-hoc files.** Switch routes to the generic pages; **commit generated output immediately**; delete superseded modules once parity confirmed: collapse `munin-projects.js`/`skuld-briefing.js`/`munin-sync.js`/`mcp-probe.js` into a shared `muninRpc()` util; fold `deployments.js`'s `LOCAL_SERVICES`/`REMOTE_SERVICES`/`GRIMNIR_REPOS` into config; remove per-page shell duplication and per-feature CSS namespaces; replace `briefingFullCard` regex with `marked`; unify the two chart-init functions into `initMetricChart()`. Final Playwright sweep + Codex PR review (per repo policy) before merge.

---

## 10. RISKS & REMAINING SUB-DECISIONS

**Risks**
- **Contract adoption lag.** Most Grimnir services don't yet serve `/heimdall.json` and several `/health` endpoints lack a `version`/`commit` field (returns sentinel `'ok'`). *Mitigation:* the degradation ladder (§3.4) renders config-only meanwhile; add `/heimdall.json` per service opportunistically. Each service needing a new endpoint is its own small task.
- **m5 OS uncertainty.** Telemetry path assumes the gateway box is Linux (`/proc`+hwmon). If Windows, fall back to a PowerShell collector or accept temp-less metrics. *Mitigation:* the gateway-`/healthz`-extension approach sidesteps a separate agent either way.
- **Orin reachability.** LAN-only; the agent can't reach a Tailscale-bound ingest. *Mitigation:* enroll Orin in Tailscale (recommended) or dual-bind ingest on LAN; SSH-pull fallback exists.
- **30s push × dense fleet** could grow `fleet_metrics` fast. *Mitigation:* aggressive 7d-then-rollup retention; verify vacuum keeps the DB bounded.
- **Big-bang regression surface.** A rewrite risks silently dropping a v1 behavior. *Mitigation:* M5 parity as the acceptance gate in P2; Playwright visual diffs at each phase; nothing deleted before its replacement passes.

**Remaining small sub-decisions (the 4 big forks are locked)**
1. `/heimdall.json` vs extending `/health` per service — recommend separate descriptor; confirm per service.
2. Fleet push interval: 30s vs 60s (B3 says 30s; A5 floats 60s) — start 30s, make per-host configurable.
3. Offline thresholds: Pi >10 min alert, laptop ~30 min sleeping — confirm exact numbers.
4. Colorblind palette: ship green/amber/red as default with shape+text, Wong palette as opt-in theme — or make Wong the default?
5. Bearer-token scope: one shared fleet token vs per-agent tokens (B3 favors per-agent) — recommend per-agent for revocability.
6. Whether munin-zero and additional inference nodes (Ollama on control-node/Orin/laptop) get fleet agents in P1 or later.
7. Ratatoskr: persist alerts in Munin (`alerts/<dedup_key>`) vs only in Heimdall's DB — recommend Heimdall DB as source of truth, Munin optional mirror.

---

*Files referenced (absolute): `./heimdall.config.json`, `./src/server.js`, `./src/db.js`, `./src/m5.js`, `./src/html.js`, `./src/notify.js`, `./src/deployments.js`, `./src/collector.js`.*
