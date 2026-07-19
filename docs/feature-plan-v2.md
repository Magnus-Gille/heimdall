# Heimdall v2 — Feature Plan

> Research date: 2026-03-15
> Status: Historical planning record. Many items have since shipped; do not treat this as the current backlog.

## Executive Summary

Heimdall v1 is stable and operational: it monitors two Pis, tracks backups, deploy drift, Hugin tasks, and system health. This plan identifies **28 features** across three phases that transform Heimdall from a basic health dashboard into a comprehensive AI infrastructure observatory.

Key themes:
1. **Deeper system visibility** — CPU frequency, throttling, network I/O, disk I/O, process monitoring
2. **AI infrastructure analytics** — Hugin task trends, Munin growth, correlation views
3. **Predictive intelligence** — disk exhaustion projections, trend analysis, anomaly patterns
4. **UX polish** — sparklines, status page mode, WebSocket push, dark/light toggle

All features are designed for the Pi 5 (8GB RAM, 4-core ARM, SD card storage) and maintain the "agent-maintainability" principle: simple code, few files, no new npm dependencies unless essential.

---

## Architecture Considerations

### Data Collection Expansion

Most new metrics can be collected by extending the existing `collector.js` pipeline with additional reads from `/proc` and `/sys`. The SSH command to NAS needs corresponding extensions.

**New metrics pattern:**
```
collector.js → read /proc or /sys → insertMetrics(db, [...]) → display in html.js card
```

**Key files for any new metric:**
1. `src/collector.js` — Add collection logic
2. `src/metrics.js` — Add SSH command sections (for NAS metrics)
3. `src/db.js` — Schema changes if needed (usually not — metrics table is flexible)
4. `src/html.js` — Add card rendering
5. `src/server.js` — Add card endpoint
6. `public/style.css` — Card styling if needed

### Data Model Changes

The existing `metrics` table with its `(host, metric, value, unit, metadata)` schema handles most new metrics without schema changes. The metadata JSON field accommodates structured data.

**New table needed for:**
- Uptime history tracking (Phase 2)
- Process snapshots (Phase 2)

**New rollup considerations:**
- Network and disk I/O are counter-based (cumulative) — need delta calculation in collector
- CPU frequency is a point-in-time sample — fits existing pattern

### No New Dependencies Required

All features use:
- Node.js built-in `fs.readFileSync` for `/proc`/`/sys` reads
- Existing `better-sqlite3` for storage
- Existing Chart.js for visualization
- Existing HTMX for dynamic updates
- `vcgencmd` (already on Pi) for hardware monitoring

---

## Phase 1: Quick Wins (< 1 hour each, high impact)

### 1.1 CPU Frequency & Throttling Card

**Description:** Show current CPU frequency, max frequency, and throttling status. The Pi 5 dynamically scales 1500–2400 MHz and `vcgencmd get_throttled` provides a bitmask of current/historical throttling events (under-voltage, thermal throttle, frequency cap).

**Complexity:** S

**Data collection:**
```javascript
// In collector.js collectLocalMetrics()
const cpuFreq = parseInt(fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8')) / 1000; // MHz
const cpuMaxFreq = parseInt(fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq', 'utf8')) / 1000;
const throttled = execSync('vcgencmd get_throttled').toString().trim(); // "throttled=0x0"
const throttleHex = parseInt(throttled.split('=')[1], 16);
```

**Throttle bitmask decoding:**
- Bit 0: Under-voltage detected (now)
- Bit 1: ARM frequency capped (now)
- Bit 2: Currently throttled (now)
- Bit 3: Soft temperature limit active (now)
- Bits 16-19: Same flags, but "has occurred since boot"

**Metrics to store:**
- `cpu_freq` (MHz) — current frequency
- `cpu_throttled` (bitmask) — throttle flags

**SSH extension for NAS:** Add `cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq` and `vcgencmd get_throttled` as new sections.

**Display:** Add row to system health card showing "CPU: 2400 MHz" with a warning icon if any throttle bit is set. Store throttle events as anomaly events when bits change.

**Files to modify:**
- `src/collector.js` — Add freq/throttle collection to local and remote
- `src/metrics.js` — Add SSH sections, add `parseThrottleFlags()` helper
- `src/events.js` — Add throttle event detection
- `src/html.js` — Add CPU freq row to `systemHealthCard()`

### 1.2 Network I/O Metrics

**Description:** Track bytes sent/received per interface from `/proc/net/dev`. Show current throughput rates on the system health card. Available interfaces: `eth0`, `wlan0`, `tailscale0`.

**Complexity:** S

**Data collection:**
```javascript
// Read /proc/net/dev, parse rx_bytes and tx_bytes for eth0/tailscale0
// Store as cumulative counters, compute delta in display layer
```

**Metrics to store:**
- `net_rx_bytes_eth0`, `net_tx_bytes_eth0` (bytes, cumulative)
- `net_rx_bytes_tailscale0`, `net_tx_bytes_tailscale0` (bytes, cumulative)

**Display:** Show throughput rate (bytes/sec computed from delta between last two samples ÷ interval). Format as "↓ 1.2 MB/s ↑ 340 KB/s" in system health card.

**SSH extension for NAS:** Add `cat /proc/net/dev` section.

**Files to modify:**
- `src/collector.js` — Add `/proc/net/dev` parsing
- `src/metrics.js` — Add SSH section
- `src/html.js` — Add network row to `systemHealthCard()`, add `formatRate()` helper

### 1.3 Disk I/O Metrics

**Description:** Track read/write operations and bytes from `/sys/block/mmcblk0/stat`. Shows SD card activity levels — useful for detecting heavy write loads that accelerate wear.

**Complexity:** S

**Data collection:**
```javascript
// /sys/block/mmcblk0/stat fields (space-separated):
// [0] reads completed, [2] sectors read, [4] writes completed, [6] sectors written
// Sector size = 512 bytes
const stat = fs.readFileSync('/sys/block/mmcblk0/stat', 'utf8').trim().split(/\s+/);
const sectorsRead = parseInt(stat[2]);
const sectorsWritten = parseInt(stat[6]);
```

**Metrics to store:**
- `disk_read_bytes_sd` (bytes, cumulative — sectors × 512)
- `disk_write_bytes_sd` (bytes, cumulative)

**Display:** Show as "SD I/O: ↓R 2.1 MB/s ↑W 120 KB/s" in system health card, computed as delta rate.

**SSH extension for NAS:** Add `cat /sys/block/mmcblk0/stat` and `cat /sys/block/sda/stat` (NAS drive).

**Files to modify:**
- `src/collector.js` — Add block stat parsing
- `src/metrics.js` — Add SSH sections
- `src/html.js` — Add disk I/O row to `systemHealthCard()`

### 1.4 Sparkline Mini-Charts in System Health Cards

**Description:** Add tiny inline sparklines (last 24h) for temperature, memory, load, and disk usage directly inside the system health cards. Uses CSS-only sparklines or tiny inline SVG — no Chart.js needed for these.

**Complexity:** S

**Implementation approach:** Query last 24h of a metric (already available via `/api/metrics/:host/:metric`), render as a tiny inline SVG polyline (60×16px). The SVG generation happens server-side in `html.js`.

```javascript
function sparklineSvg(points, width = 60, height = 16) {
  if (!points.length) return '';
  const min = Math.min(...points);
  const max = Math.max(...points) || 1;
  const coords = points.map((v, i) =>
    `${(i / (points.length - 1)) * width},${height - ((v - min) / (max - min)) * height}`
  ).join(' ');
  return `<svg width="${width}" height="${height}" class="sparkline"><polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}
```

**Data:** Reuse existing metrics queries — fetch last 288 samples (24h × 12/hr at 5min intervals), downsample to 30 points for SVG.

**Files to modify:**
- `src/html.js` — Add `sparklineSvg()` function, embed in `systemHealthCard()`
- `src/server.js` — Query last-24h data when rendering system health cards
- `public/style.css` — Add `.sparkline` styles (inline-block, vertical-align middle, opacity)

### 1.5 Under-Voltage Detection & Alerting

**Description:** The Pi 5 has a hardware under-voltage detector at `/sys/class/hwmon/hwmon2/in0_lcrit_alarm`. Value `1` means the power supply is inadequate. This should trigger an immediate critical alert.

**Complexity:** S

**Data collection:**
```javascript
const underVoltage = parseInt(fs.readFileSync('/sys/class/hwmon/hwmon2/in0_lcrit_alarm', 'utf8').trim());
```

**Alert:** If `underVoltage === 1`, create critical alert "Under-voltage detected — check power supply". Auto-resolve when it returns to 0.

**Files to modify:**
- `src/collector.js` — Read hwmon2 alarm
- `src/events.js` — Add under-voltage threshold
- `src/alerts.js` — Will auto-fire from existing alert infrastructure

### 1.6 Uptime Display Enhancement

**Description:** Currently uptime is shown as "Xd Yh". Enhance to also show last boot time and detect reboots with visual indicator. Already partially implemented (reboot detection exists in events.js), but the card doesn't show boot time.

**Complexity:** S

**Display change:** Add "Booted: Mar 5, 8:42 AM" below uptime in system health card. If uptime < 1 hour, highlight in amber as "Recently rebooted".

**Files to modify:**
- `src/html.js` — Add boot time display to `systemHealthCard()`

### 1.7 Hugin Task Success Rate Badge

**Description:** Show a success rate percentage on the Hugin Tasks card header. Calculate from completed vs failed tasks in the last 24h/7d.

**Complexity:** S

**Data:** Already available — Munin DB has task entries with status field. Count completed vs failed in time window.

**Display:** "Hugin Tasks (94% success, 7d)" as card header subtitle. Color: green >90%, amber 70-90%, red <70%.

**Files to modify:**
- `src/hugin.js` — Add `getTaskSuccessRate(db, days)` function
- `src/html.js` — Add badge to tasks card header
- `src/server.js` — Pass success rate to card renderer

### 1.8 Dark/Light Mode Toggle

**Description:** Currently follows OS preference via `prefers-color-scheme`. Add an explicit toggle button that overrides OS preference, stored in localStorage.

**Complexity:** S

**Implementation:** Add a sun/moon icon button in the header. JavaScript toggles a `data-theme="light"` attribute on `<html>`. CSS custom properties already partially support this (the existing `@media (prefers-color-scheme: light)` block). Refactor to use `[data-theme="light"]` selector alongside the media query.

**Files to modify:**
- `public/style.css` — Refactor color scheme to use CSS custom properties on `:root` and `[data-theme]`
- `src/html.js` — Add toggle button to header
- `public/charts-client.js` — Add theme toggle JS (localStorage + attribute toggle)

---

## Phase 2: Medium Features (1–3 hours each)

### 2.1 Disk Usage Trending with Exhaustion Projection

**Description:** Use historical disk usage data to project when the SD card (and NAS drive) will be full. Show as "SD card full in ~X days" with a trend line on the existing disk chart or a new mini-card.

**Complexity:** M

**Algorithm:**
1. Fetch last 30 days of `disk_used_pct_sd` from rollups
2. Linear regression on the data points
3. Extrapolate to 100% — that's the exhaustion date
4. If slope is negative or zero, show "Stable" or "Decreasing"

```javascript
function linearRegression(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}
// daysUntilFull = (100 - currentPct) / (slope * 86400000) // slope is per-ms
```

**Alert:** If projected exhaustion is <30 days, create warning alert. If <7 days, critical.

**Display:** New row in system health card: "SD: 11% used — full in ~2.3 years" or dedicated small card.

**Files to modify:**
- `src/collector.js` or `src/maintain.js` — Compute projection during daily maintenance
- `src/html.js` — Display projection
- `src/alerts.js` — Predictive disk alerts
- `src/charts.js` — Add `linearRegression()` utility

### 2.2 Process Monitor Card

**Description:** Show top 5 CPU and memory consumers. Useful for spotting runaway Claude agents or memory leaks.

**Complexity:** M

**Data collection:**
```javascript
// Run every collection cycle
const psOutput = execSync('ps aux --sort=-%cpu | head -6').toString(); // top 5 + header
const psMemOutput = execSync('ps aux --sort=-%mem | head -6').toString();
```

**Storage approach:** Don't store every sample in metrics (too noisy). Instead:
- Store as a single metric `top_processes` with metadata JSON containing the process list
- Only keep the latest snapshot (overwrite previous)
- Alternatively, store in a new `process_snapshots` table with TTL

**New table:**
```sql
CREATE TABLE IF NOT EXISTS process_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  host TEXT NOT NULL,
  sort_by TEXT NOT NULL, -- 'cpu' or 'mem'
  processes TEXT NOT NULL  -- JSON array [{pid, user, cpu, mem, command}]
);
-- Keep only latest per host+sort_by
```

**SSH extension for NAS:** Add `ps aux --sort=-%cpu | head -6` and `ps aux --sort=-%mem | head -6`.

**Display:** New card "Top Processes" with two mini-tables (CPU / Memory). Refresh every 60s.

**Files to modify:**
- `src/db.js` — Add `process_snapshots` table
- `src/collector.js` — Add process collection
- `src/metrics.js` — Add SSH sections
- `src/html.js` — New `processesCard()` template
- `src/server.js` — New `/api/card/processes` endpoint

### 2.3 Hugin Task Analytics Dashboard

**Description:** Rich analytics for Hugin tasks: tasks per day chart, average duration, success rate over time, most common failure reasons. Transforms the simple task list into an operational intelligence view.

**Complexity:** M

**Data source:** Munin SQLite DB already contains task entries with timestamps, status, duration, and failure reasons. The `hugin.js` module already reads this data.

**New queries:**
```javascript
// Tasks per day (last 30 days)
// Avg duration by status
// Failure reason frequency
// Success rate trend (7-day rolling)
```

**Display:** Replace or expand the Hugin Tasks card with:
- Summary bar: "47 tasks this week | 92% success | avg 3.2min"
- Small bar chart: tasks per day (last 14 days) colored by status
- Failure reasons list (grouped and counted)

**Files to modify:**
- `src/hugin.js` — Add analytics queries
- `src/html.js` — New `huginAnalyticsCard()` or expand existing
- `src/server.js` — Expand `/api/card/hugin-tasks` or add `/api/card/hugin-analytics`
- `public/charts-client.js` — Add bar chart for task frequency

### 2.4 Munin Memory Usage Stats

**Description:** Show Munin database size, entry count, namespace breakdown, and growth rate. The ecosystem depends on Munin, so knowing its size and growth matters.

**Complexity:** M

**Data source:** Direct SQLite read of `~/.munin-memory/memory.db` (same pattern as `hugin.js`).

**Metrics:**
- DB file size: `fs.statSync(dbPath).size`
- Total entries: `SELECT COUNT(*) FROM entries`
- Namespace breakdown: `SELECT namespace, COUNT(*) FROM entries GROUP BY namespace`
- Recent growth: entries created in last 24h, 7d

**Storage:** Store `munin_db_size` and `munin_entry_count` as metrics in Heimdall DB for trending.

**Display:** New card "Munin Memory" showing:
- DB size with sparkline trend
- Entry count with growth rate
- Top 5 namespaces by entry count
- FTS index size if significant

**Files to modify:**
- `src/collector.js` — Add Munin DB stats collection
- `src/html.js` — New `muninStatsCard()` template
- `src/server.js` — New `/api/card/munin-stats` endpoint

### 2.5 Uptime History & Availability Tracking

**Description:** Track and display uptime percentage over time. Detect outages from reboot events and NAS unreachable periods. Show "99.7% uptime (30d)" with a visual availability bar.

**Complexity:** M

**New table:**
```sql
CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  status TEXT NOT NULL, -- 'up', 'down', 'degraded'
  started_at TEXT NOT NULL,
  ended_at TEXT,
  reason TEXT
);
```

**Data source:** Derived from existing collection:
- Reboot detection (uptime decrease) → downtime period
- NAS unreachable events → NAS downtime
- Missing collection cycles → potential outage

**Display:** GitHub-style availability grid (green/amber/red squares for each day of last 90 days) + percentage. Small and visually impactful.

**Files to modify:**
- `src/db.js` — Add `availability` table
- `src/collector.js` — Record availability status each cycle
- `src/html.js` — New `availabilityCard()` with grid rendering
- `src/server.js` — New `/api/card/availability` endpoint

### 2.6 Cloudflare Tunnel Status

**Description:** Monitor whether the Cloudflare Tunnel is healthy. `cloudflared` is installed and running — check its status and connectivity.

**Complexity:** M

**Data collection:**
```javascript
// Check service status
const cfStatus = execSync('systemctl is-active cloudflared').toString().trim(); // 'active' or not
// Check tunnel metrics (cloudflared exposes metrics on localhost:33000 by default)
// Or parse journalctl -u cloudflared for recent connection events
```

**Metrics:**
- `cloudflared_active` (boolean)
- Parse recent logs for connection/reconnection events

**Display:** Add to deploy status card or as a small status indicator in the header: "Tunnel: ✓ Connected" or "Tunnel: ✗ Disconnected".

**Alert:** If cloudflared goes down, critical alert (dashboard becomes unreachable externally).

**Files to modify:**
- `src/collector.js` — Add cloudflared status check
- `src/events.js` — Add tunnel disconnect event detection
- `src/html.js` — Add tunnel status to deploy card or header

### 2.7 Tailscale Network Status

**Description:** Monitor Tailscale connectivity and show connected peers. Tailscale is the backbone connecting the two Pis.

**Complexity:** M

**Data collection:**
```javascript
const tsStatus = JSON.parse(execSync('tailscale status --json').toString());
// Extracts: self node, peer list, connection status (direct/relayed), last seen
```

**Display:** New card or section showing:
- Tailscale status (running/stopped)
- Connected peers with last-seen time and connection type (direct vs DERP relay)
- Alert if NAS peer is not seen recently

**Files to modify:**
- `src/collector.js` — Add `tailscale status --json` parsing
- `src/html.js` — New `tailscaleCard()` template
- `src/server.js` — New `/api/card/tailscale` endpoint

### 2.8 WebSocket Push Updates

**Description:** Replace HTMX polling with WebSocket push for real-time updates. Currently cards poll every 30-60s. WebSocket would push updates only when data changes, reducing load and improving responsiveness.

**Complexity:** M

**Implementation:**
- Add `@fastify/websocket` (only new dependency — lightweight, well-maintained)
- Server broadcasts card HTML updates when collector writes new data
- Client reconnects automatically on disconnect
- Fallback to HTMX polling if WebSocket fails

**Alternative (no dependency):** Use Server-Sent Events (SSE) instead. SSE is HTTP-native, works through Cloudflare, and needs no npm package. Fastify supports SSE natively via async iterators.

**Recommended: SSE approach** (zero dependencies):
```javascript
// Server
app.get('/api/stream', async (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  // Push events when collector signals new data
});
```

HTMX has built-in SSE support via `hx-ext="sse"`.

**Files to modify:**
- `src/server.js` — Add SSE endpoint, collector event emitter
- `src/html.js` — Add `hx-ext="sse"` attributes to cards
- `public/style.css` — Connection indicator in header

### 2.9 Status Page Mode

**Description:** A simplified, phone-optimized view showing just the essential status at a glance. Think "is everything OK?" with green/amber/red indicators. Accessible at `/status`.

**Complexity:** M

**Design:**
- Single column, large text
- Overall status: ✓ All Systems Operational / ⚠ Degraded / ✗ Outage
- Per-system traffic light: control-node, NAS, Tunnel, Backups
- Last updated timestamp
- No charts, no details — just status
- Auto-refreshes every 30s

**Files to modify:**
- `src/html.js` — New `statusPage()` template
- `src/server.js` — New `GET /status` route
- `public/style.css` — Status page styles (large, centered, minimal)

### 2.10 Historical Comparison View (This Week vs Last Week)

**Description:** Overlay previous week's data on current charts. Useful for spotting weekly patterns (e.g., load increases during weekday agent runs).

**Complexity:** M

**Implementation:** Add a "Compare" toggle on chart range buttons. When active, fetch the same time range but offset by 7 days, and render as a semi-transparent second line on the chart.

**Files to modify:**
- `src/server.js` — Extend `/api/metrics/:host/:metric` to accept `compare=7d` parameter
- `public/charts-client.js` — Add comparison dataset to Chart.js config
- `src/html.js` — Add compare toggle button to chart cards

---

## Phase 3: Ambitious Features (half day+)

### 3.1 Notification System (Webhook Alerts to Phone)

**Description:** Send push notifications when critical alerts fire. Options: Pushover, ntfy.sh (self-hostable), or simple webhook to a phone notification service.

**Complexity:** L

**Recommended: ntfy.sh** (no account needed, self-hostable, curl-friendly):
```javascript
// In alerts.js when creating a critical alert:
fetch('https://ntfy.sh/replace-with-a-random-topic', {
  method: 'POST',
  body: `🚨 ${alert.title}\n${alert.detail}`,
  headers: { 'Title': 'Heimdall Alert', 'Priority': 'high' }
});
```

**Configuration:** Add notification config to `heimdall.config.json`:
```json
{
  "notifications": {
    "enabled": true,
    "provider": "ntfy",
    "url": "https://ntfy.sh/replace-with-a-random-topic",
    "min_severity": "critical"
  }
}
```

**Rate limiting:** Max 1 notification per alert per hour (prevent spam during flapping).

**Files to modify:**
- `src/alerts.js` — Add notification dispatch on alert creation
- `heimdall.config.json` — Add notification config
- `src/collector.js` — Wire up notification calls

### 3.2 Anomaly Detection with Pattern Learning

**Description:** Go beyond static thresholds. Learn normal patterns (time-of-day baselines) and alert on deviations. E.g., "temperature is 55°C which is normal for 3pm on a workday" vs "temperature is 55°C at 3am which is unusual."

**Complexity:** L

**Algorithm:**
1. Build hourly baselines from 30-day rollups: mean and stddev per metric per hour-of-day
2. Flag current values that exceed mean ± 2σ for the current hour
3. Store baselines in a `baselines` table, recompute daily in maintenance

**New table:**
```sql
CREATE TABLE IF NOT EXISTS metric_baselines (
  host TEXT NOT NULL,
  metric TEXT NOT NULL,
  hour_of_day INTEGER NOT NULL, -- 0-23
  day_of_week INTEGER, -- 0-6 (NULL = all days)
  mean_value REAL NOT NULL,
  stddev_value REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (host, metric, hour_of_day)
);
```

**Files to modify:**
- `src/db.js` — Add `metric_baselines` table
- `src/maintain.js` — Add baseline computation to daily maintenance
- `src/events.js` — Add baseline comparison to anomaly detection
- `src/html.js` — Show "unusual" badge on metrics that deviate from baseline

### 3.3 Correlation Dashboard

**Description:** Visualize relationships between metrics. Does load increase when Hugin runs tasks? Does temperature correlate with time of day? Show side-by-side or overlaid charts with event markers.

**Complexity:** L

**Implementation:**
- New page at `/analytics` with multi-metric chart view
- User selects 2+ metrics to overlay on the same time axis
- Event markers (task starts, backups, deploys) shown as vertical lines
- Pearson correlation coefficient computed and displayed

**Files to modify:**
- `src/html.js` — New `analyticsPage()` template
- `src/server.js` — New `GET /analytics` route, multi-metric data endpoint
- `public/charts-client.js` — Multi-axis chart support
- `public/style.css` — Analytics page layout

### 3.4 Incident Timeline View

**Description:** A chronological view of all events, alerts, and metric anomalies for incident investigation. Filter by time range, host, severity. Shows events on a visual timeline with metric graphs alongside.

**Complexity:** L

**Implementation:**
- New page at `/incidents` (or section on dashboard)
- Timeline component: vertical list of events with timestamps
- Clicking a time range shows metric graphs for that period
- Filter controls: host, category, severity, time range

**Files to modify:**
- `src/html.js` — New `incidentTimeline()` template
- `src/server.js` — New `GET /incidents` route
- `public/style.css` — Timeline styles
- `public/charts-client.js` — Linked chart-timeline interaction

### 3.5 Log Search

**Description:** Search across systemd journal logs from both Pis. Useful for debugging without SSH.

**Complexity:** L

**Implementation:**
- Search endpoint: `GET /api/logs?q=error&host=control-node&unit=heimdall&since=1h`
- Backend: `journalctl --no-pager -u <unit> --since "<since>" --grep "<query>"`
- For NAS: SSH + journalctl
- Rate limit and cap results to prevent runaway queries

**Security consideration:** Only expose via localhost API or behind Cloudflare Access auth.

**Files to modify:**
- `src/server.js` — New `/api/logs` endpoint
- `src/html.js` — New log search card or page
- `src/metrics.js` — Add remote journalctl helper

### 3.6 Dashboard Customization

**Description:** Allow reordering and showing/hiding cards. Store preferences in localStorage. Implement with HTML5 drag-and-drop.

**Complexity:** L

**Implementation:**
- Cards get a drag handle and hide button
- Order stored in localStorage as JSON array of card IDs
- On page load, JavaScript reorders the grid elements
- "Reset layout" button to restore default

**Files to modify:**
- `src/html.js` — Add card IDs and drag handles
- `public/charts-client.js` — Add drag-and-drop JS
- `public/style.css` — Drag indicator styles

### 3.7 Samba/Time Machine Session Monitoring

**Description:** Monitor active Samba shares and Time Machine backup sessions. Show who's connected and backup progress.

**Complexity:** M

**Data collection:**
```javascript
// On NAS via SSH:
const smbStatus = execSync('smbstatus --json').toString(); // Active connections
// Or: smbstatus -b for brief format
```

**Display:** Show on backup card: "Time Machine: backing up (3.2 GB transferred)" or "No active sessions".

**Files to modify:**
- `src/metrics.js` — Add smbstatus SSH section
- `src/collector.js` — Parse Samba session data
- `src/html.js` — Add session info to backups card

### 3.8 GitHub Activity Overlay

**Description:** Show recent GitHub commit activity for tracked repos as event markers on charts. Correlates deploys with system behavior.

**Complexity:** M

**Data collection:** Use `git ls-remote` (already used for drift detection) plus `git log --oneline --since="7 days ago"` via SSH or locally.

**Display:** Vertical markers on temperature/load charts at commit timestamps. Hover shows commit message.

**Files to modify:**
- `src/drift.js` — Extend to fetch recent commit log
- `public/charts-client.js` — Add annotation plugin or manual line drawing
- `src/server.js` — Include commit data in chart responses

---

## Implementation Priority Matrix

| # | Feature | Phase | Complexity | Impact | Dependencies |
|---|---------|-------|-----------|--------|-------------|
| 1.1 | CPU Freq & Throttling | 1 | S | High | None |
| 1.2 | Network I/O | 1 | S | High | None |
| 1.3 | Disk I/O | 1 | S | Medium | None |
| 1.4 | Sparkline Mini-Charts | 1 | S | High | None |
| 1.5 | Under-Voltage Detection | 1 | S | High | None |
| 1.6 | Uptime Display Enhancement | 1 | S | Low | None |
| 1.7 | Hugin Task Success Rate | 1 | S | Medium | None |
| 1.8 | Dark/Light Mode Toggle | 1 | S | Medium | None |
| 2.1 | Disk Exhaustion Projection | 2 | M | High | 30d of data |
| 2.2 | Process Monitor | 2 | M | High | None |
| 2.3 | Hugin Task Analytics | 2 | M | High | 1.7 |
| 2.4 | Munin Memory Stats | 2 | M | Medium | None |
| 2.5 | Uptime/Availability Tracking | 2 | M | Medium | None |
| 2.6 | Cloudflare Tunnel Status | 2 | M | High | None |
| 2.7 | Tailscale Network Status | 2 | M | Medium | None |
| 2.8 | WebSocket/SSE Push | 2 | M | Medium | None |
| 2.9 | Status Page Mode | 2 | M | High | None |
| 2.10 | Historical Comparison | 2 | M | Low | Chart data |
| 3.1 | Phone Notifications | 3 | L | High | None |
| 3.2 | Anomaly Pattern Learning | 3 | L | High | 30d of data |
| 3.3 | Correlation Dashboard | 3 | L | Medium | Charts |
| 3.4 | Incident Timeline | 3 | L | Medium | Events data |
| 3.5 | Log Search | 3 | L | Medium | None |
| 3.6 | Dashboard Customization | 3 | L | Low | None |
| 3.7 | Samba Session Monitoring | 3 | M | Low | NAS SSH |
| 3.8 | GitHub Activity Overlay | 3 | M | Low | Drift module |

## Recommended Implementation Order

**First sprint (Phase 1 — all quick wins):**
1. 1.5 Under-Voltage Detection (safety first)
2. 1.1 CPU Freq & Throttling (pairs with 1.5)
3. 1.2 Network I/O (new visibility)
4. 1.3 Disk I/O (new visibility)
5. 1.4 Sparklines (visual polish)
6. 1.7 Hugin Success Rate (AI infra visibility)
7. 1.8 Dark/Light Toggle (UX)
8. 1.6 Uptime Enhancement (minor polish)

**Second sprint (high-impact Phase 2):**
1. 2.9 Status Page Mode (phone use case)
2. 2.6 Cloudflare Tunnel Status (critical path monitoring)
3. 2.2 Process Monitor (debugging aid)
4. 2.4 Munin Memory Stats (AI infra)
5. 2.1 Disk Exhaustion Projection (predictive)
6. 2.3 Hugin Task Analytics (AI infra)

**Third sprint (remaining Phase 2):**
1. 2.7 Tailscale Status
2. 2.5 Uptime/Availability
3. 2.8 SSE Push Updates
4. 2.10 Historical Comparison

**Future (Phase 3 — as needed):**
1. 3.1 Phone Notifications (high value)
2. 3.2 Anomaly Pattern Learning (needs data history)
3. 3.3–3.8 as interest dictates

---

## Data Model Summary

### New Metrics (no schema change needed)

| Metric | Host | Unit | Type |
|--------|------|------|------|
| `cpu_freq` | both | MHz | point-in-time |
| `cpu_throttled` | both | bitmask | point-in-time |
| `net_rx_bytes_eth0` | both | bytes | cumulative counter |
| `net_tx_bytes_eth0` | both | bytes | cumulative counter |
| `net_rx_bytes_tailscale0` | both | bytes | cumulative counter |
| `net_tx_bytes_tailscale0` | both | bytes | cumulative counter |
| `disk_read_bytes_sd` | both | bytes | cumulative counter |
| `disk_write_bytes_sd` | both | bytes | cumulative counter |
| `disk_read_bytes_nas` | nas | bytes | cumulative counter |
| `disk_write_bytes_nas` | nas | bytes | cumulative counter |
| `under_voltage` | both | boolean | point-in-time |
| `munin_db_size` | control-node | bytes | point-in-time |
| `munin_entry_count` | control-node | count | point-in-time |
| `cloudflared_active` | control-node | boolean | point-in-time |

### New Tables

| Table | Purpose | Phase |
|-------|---------|-------|
| `process_snapshots` | Top CPU/memory processes | 2.2 |
| `availability` | Uptime history periods | 2.5 |
| `metric_baselines` | Learned normal patterns | 3.2 |

### SSH Command Extensions

The NAS SSH command needs these additional sections (append after existing 11 sections):

```bash
# Section 12: CPU frequency
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq
echo "---"
# Section 13: Throttle status
vcgencmd get_throttled
echo "---"
# Section 14: Network stats
cat /proc/net/dev
echo "---"
# Section 15: Block device stats
cat /sys/block/mmcblk0/stat
echo "---"
cat /sys/block/sda/stat
echo "---"
# Section 16: Top processes (CPU)
ps aux --sort=-%cpu | head -6
echo "---"
# Section 17: Top processes (Memory)
ps aux --sort=-%mem | head -6
echo "---"
# Section 18: Samba status (Phase 3)
smbstatus -b 2>/dev/null || echo "N/A"
```

---

## Notes for Implementing Agents

- **One feature per commit.** Each feature should be a self-contained change.
- **Test collection before display.** Run the collector manually (`node src/collector.js`) and verify metrics appear in the DB before building cards.
- **Cumulative counters need delta logic.** Network and disk I/O are cumulative — the display layer must compute rate = (current - previous) / interval. Handle counter resets (reboot) gracefully.
- **SSH command changes are fragile.** The NAS SSH collects all data in one command with `---` separators. Adding sections requires updating both the command string and the parser. Always add new sections at the end to avoid breaking existing parsing.
- **Chart updates are mostly client-side.** The `charts-client.js` file handles Chart.js initialization. New charts follow the same pattern: canvas element → fetch data → create chart.
- **Keep card HTML self-contained.** Each card's HTML is generated by a single function in `html.js`. The function receives data and returns complete HTML. No shared mutable state.
