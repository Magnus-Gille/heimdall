'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.heimdall', 'heimdall.db');

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        host TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL,
        unit TEXT,
        metadata TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_unique ON metrics(host, metric, timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(timestamp);

      CREATE TABLE IF NOT EXISTS metrics_rollup (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT NOT NULL,
        bucket TEXT NOT NULL,
        host TEXT NOT NULL,
        metric TEXT NOT NULL,
        min_value REAL,
        max_value REAL,
        avg_value REAL,
        sample_count INTEGER NOT NULL,
        unit TEXT,
        metadata TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rollup_unique ON metrics_rollup(period, bucket, host, metric);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        host TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        detail TEXT,
        source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_lookup ON events(category, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity, timestamp);

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        host TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        acknowledged INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(resolved_at) WHERE resolved_at IS NULL;

      CREATE TABLE IF NOT EXISTS service_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checked_at TEXT NOT NULL,
        service TEXT NOT NULL,
        host TEXT NOT NULL,
        deployed_commit TEXT,
        latest_commit TEXT,
        commits_behind INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_service_versions_lookup ON service_versions(service, checked_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS process_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        host TEXT NOT NULL,
        sort_by TEXT NOT NULL,
        processes TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_process_snapshots_host ON process_snapshots(host, sort_by);
    `,
  },
  {
    // v2 platform rewrite: fleet telemetry (push-agent model).
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS fleet_hosts (
        hostname TEXT PRIMARY KEY,
        label TEXT,
        role TEXT,
        os TEXT,
        platform TEXT,
        ip TEXT,
        always_on INTEGER NOT NULL DEFAULT 1,
        first_seen TEXT,
        last_seen TEXT
      );

      CREATE TABLE IF NOT EXISTS fleet_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        hostname TEXT NOT NULL,
        cpu_pct REAL,
        ram_total_mb REAL,
        ram_used_mb REAL,
        ram_used_pct REAL,
        uptime_s INTEGER,
        load_1 REAL,
        load_5 REAL,
        load_15 REAL,
        temp_cpu_c REAL,
        temp_gpu_c REAL,
        disk TEXT,
        extra TEXT,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fleet_metrics_host_ts ON fleet_metrics(hostname, timestamp);
    `,
  },
  {
    // v2 platform: self-describing service contract — latest descriptor snapshot
    // per service (one row each; read at page render, written by the discovery poller).
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS service_snapshots (
        service TEXT PRIMARY KEY,
        kind TEXT,
        status TEXT,
        descriptor TEXT,
        fetched_at TEXT,
        reachable INTEGER,
        schema_version TEXT,
        source TEXT,
        error TEXT
      );
    `,
  },
  {
    // v2 platform: alert bus (P3). `dedup_key` collapses repeats at the bus
    // layer (the piece v1 lacked); `source` records who raised it (service /
    // engine / pushed). Both nullable — existing rows keep (host,title) dedup.
    version: 5,
    sql: `
      ALTER TABLE alerts ADD COLUMN dedup_key TEXT;
      ALTER TABLE alerts ADD COLUMN source TEXT;
      CREATE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(dedup_key) WHERE resolved_at IS NULL;
    `,
  },
  {
    // generic typed-panel ingest (#57): a producer POSTs one JSON blob and a
    // number/trend/table/status appears on its service page — zero Heimdall code
    // per panel. One row per (service, panel); `data` holds the kind-specific
    // payload as JSON. Latest push wins (INSERT OR REPLACE).
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS panels (
        service TEXT NOT NULL,
        panel TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT,
        unit TEXT,
        data TEXT,
        updated_at INTEGER,
        PRIMARY KEY (service, panel)
      );
      CREATE INDEX IF NOT EXISTS idx_panels_service ON panels(service);
    `,
  },
  {
    // Critical-alert delivery outbox (#2). Delivery state lives on the alert row:
    // active-row dedup therefore suppresses repeats, while resolve + recurrence
    // creates a fresh pending row. Existing critical rows are marked backfilled
    // so enabling the feature cannot replay every already-active incident.
    version: 7,
    sql: `
      ALTER TABLE alerts ADD COLUMN notification_sent_at TEXT;
      ALTER TABLE alerts ADD COLUMN notification_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE alerts ADD COLUMN notification_last_error TEXT;
      ALTER TABLE alerts ADD COLUMN notification_next_attempt_at TEXT;
      UPDATE alerts
      SET notification_sent_at = 'backfilled'
      WHERE severity = 'critical' AND resolved_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_alerts_notification_pending
      ON alerts(severity, resolved_at, notification_sent_at, notification_next_attempt_at);
    `,
  },
  {
    // Alert observability + honest drift state.
    //
    // `alerts.last_observed_at` records the last time a condition was actually
    // RE-ASSERTED (not merely when the alert was first raised). It is what lets
    // alert-reaper.js close alerts whose host/metric series has disappeared —
    // the zombie class that kept "mem_used_pct % threshold on huginmunin" firing
    // after that host identity stopped reporting. Backfilled from created_at so
    // existing rows have a defensible starting observation.
    //
    // `service_versions.drift_state` replaces the `commits_behind = -1` sentinel
    // with an explicit 'up-to-date'|'drift'|'ahead'|'unknown', so an
    // instrumentation failure (no .git in the deploy path, /health without a
    // commit) can no longer be rendered or alerted as drift. `drift_reason`
    // carries the human explanation for an unknown.
    version: 8,
    sql: `
      ALTER TABLE alerts ADD COLUMN last_observed_at TEXT;
      UPDATE alerts SET last_observed_at = created_at WHERE last_observed_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_alerts_observed ON alerts(last_observed_at) WHERE resolved_at IS NULL;

      ALTER TABLE service_versions ADD COLUMN drift_state TEXT;
      ALTER TABLE service_versions ADD COLUMN drift_reason TEXT;
    `,
  },
];

function openDatabase(dbPath) {
  const resolvedPath = dbPath || process.env.DB_PATH || DEFAULT_DB_PATH;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      // Atomic per migration: DDL + the user_version bump commit together, so a
      // crash mid-migration rolls back cleanly and the next boot retries from a
      // consistent state (matters for non-idempotent ALTER TABLE migrations).
      db.transaction(() => {
        db.exec(m.sql);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
  }
}

// --- Query helpers ---

function insertMetric(db, timestamp, host, metric, value, unit, metadata) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO metrics (timestamp, host, metric, value, unit, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(timestamp, host, metric, value, unit, metadata ? JSON.stringify(metadata) : null);
}

function insertMetrics(db, rows) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO metrics (timestamp, host, metric, value, unit, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      stmt.run(r.timestamp, r.host, r.metric, r.value, r.unit, r.metadata ? JSON.stringify(r.metadata) : null);
    }
  });
  tx(rows);
}

function getLatestMetrics(db, host) {
  return db.prepare(`
    SELECT metric, value, unit, metadata, timestamp,
           MAX(timestamp) as latest
    FROM metrics
    WHERE host = ?
    GROUP BY metric
    ORDER BY metric
  `).all(host);
}

function getMetricHistory(db, host, metric, fromTime, toTime) {
  return db.prepare(`
    SELECT timestamp, value FROM metrics
    WHERE host = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(host, metric, fromTime, toTime);
}

function getMetricHistoryWithRollup(db, host, metric, fromTime, toTime) {
  // Use raw data for recent queries, rollups for older data
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  if (fromTime >= sevenDaysAgo) {
    return getMetricHistory(db, host, metric, fromTime, toTime);
  }

  // For older data, use rollups
  const rollups = db.prepare(`
    SELECT bucket as timestamp, avg_value as value FROM metrics_rollup
    WHERE host = ? AND metric = ? AND bucket >= ? AND bucket <= ?
    ORDER BY bucket ASC
  `).all(host, metric, fromTime, toTime);

  // Combine with raw data for the recent portion
  const raw = db.prepare(`
    SELECT timestamp, value FROM metrics
    WHERE host = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(host, metric, sevenDaysAgo, toTime);

  return [...rollups.filter(r => r.timestamp < sevenDaysAgo), ...raw];
}

function insertEvent(db, timestamp, host, category, severity, title, detail, source) {
  db.prepare(`
    INSERT INTO events (timestamp, host, category, severity, title, detail, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(timestamp, host, category, severity, title, detail || null, source || null);
}

function getRecentEvents(db, limit = 20) {
  return db.prepare(`
    SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

function searchEvents(db, { category, severity, from, to, limit = 50 }) {
  let sql = 'SELECT * FROM events WHERE 1=1';
  const params = [];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (severity) { sql += ' AND severity = ?'; params.push(severity); }
  if (from) { sql += ' AND timestamp >= ?'; params.push(from); }
  if (to) { sql += ' AND timestamp <= ?'; params.push(to); }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function getActiveAlerts(db) {
  return db.prepare(`
    SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC
  `).all();
}

/**
 * Active alerts the user hasn't dismissed. The Alerts tab + nav badge read this,
 * NOT getActiveAlerts: a dismissed (acknowledged) alert is suppressed from the UI
 * even though it stays "active" for status aggregation. Because acknowledge does
 * NOT clear the row, the alert engine's re-fire (an UPDATE of the existing active
 * row — see createAlert) preserves `acknowledged`, so a dismissed deploy-drift
 * warning stays hidden across collector cycles instead of bouncing back. Only a
 * genuine resolve-then-recur inserts a fresh row (acknowledged=0) and resurfaces.
 */
function getUnacknowledgedAlerts(db) {
  return db.prepare(`
    SELECT * FROM alerts
    WHERE resolved_at IS NULL AND (acknowledged IS NULL OR acknowledged = 0)
    ORDER BY created_at DESC
  `).all();
}

function createAlert(db, host, category, severity, title, detail, opts = {}) {
  const dedupKey = opts && typeof opts.dedup_key === 'string' && opts.dedup_key ? opts.dedup_key : null;
  const source = opts && typeof opts.source === 'string' && opts.source ? opts.source : null;

  // Dedup identity: by dedup_key when supplied (bus-layer collapse), else the
  // legacy (host, title) pair — so existing 6-arg callers are unchanged.
  const existing = dedupKey
    ? db.prepare('SELECT id FROM alerts WHERE dedup_key = ? AND resolved_at IS NULL').get(dedupKey)
    : db.prepare('SELECT id FROM alerts WHERE host = ? AND title = ? AND resolved_at IS NULL').get(host, title);
  if (existing) {
    // Refresh the active row so an escalation (e.g. warning→critical, or new
    // detail) with the same identity is reflected — latest push wins. Crossing
    // the critical boundary resets delivery state atomically in this same SQL
    // statement; concurrent collector/ingest processes therefore cannot leave a
    // warning marker attached to a newly critical row (or vice versa).
    db.prepare(`
      UPDATE alerts
      SET host = @host,
          category = @category,
          severity = @severity,
          title = @title,
          detail = @detail,
          source = @source,
          last_observed_at = @observedAt,
          notification_sent_at = CASE
            WHEN severity <> @severity AND (severity = 'critical' OR @severity = 'critical')
              THEN NULL ELSE notification_sent_at END,
          notification_attempts = CASE
            WHEN severity <> @severity AND (severity = 'critical' OR @severity = 'critical')
              THEN 0 ELSE notification_attempts END,
          notification_last_error = CASE
            WHEN severity <> @severity AND (severity = 'critical' OR @severity = 'critical')
              THEN NULL ELSE notification_last_error END,
          notification_next_attempt_at = CASE
            WHEN severity <> @severity AND (severity = 'critical' OR @severity = 'critical')
              THEN NULL ELSE notification_next_attempt_at END
      WHERE id = @id
    `).run({
      id: existing.id,
      host,
      category,
      severity,
      title,
      detail: detail || null,
      source,
      // Every re-assertion refreshes the observation stamp. This is the signal
      // alert-reaper.js uses to tell a live alert from an orphaned one whose
      // evaluator no longer runs (see src/alert-reaper.js).
      observedAt: new Date().toISOString(),
    });
    return existing.id;
  }

  const nowIso = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO alerts (created_at, host, category, severity, title, detail, dedup_key, source, last_observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nowIso, host, category, severity, title, detail || null, dedupKey, source, nowIso);
  return result.lastInsertRowid;
}

function resolveAlert(db, host, title) {
  db.prepare(`
    UPDATE alerts SET resolved_at = ? WHERE host = ? AND title = ? AND resolved_at IS NULL
  `).run(new Date().toISOString(), host, title);
}

/** Resolve all active alerts sharing a dedup_key. Returns the number resolved. */
function resolveAlertByDedupKey(db, dedupKey) {
  if (!dedupKey) return 0;
  const info = db.prepare(
    'UPDATE alerts SET resolved_at = ? WHERE dedup_key = ? AND resolved_at IS NULL'
  ).run(new Date().toISOString(), dedupKey);
  return info.changes;
}

function acknowledgeAlert(db, id) {
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
}

/** Resolve (dismiss) a single active alert by id. Returns true if a row was resolved. */
function resolveAlertById(db, id) {
  const info = db.prepare(
    'UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL'
  ).run(new Date().toISOString(), id);
  return info.changes > 0;
}

/** Pending, retry-due critical alerts. Repeated active observations share one row. */
function getPendingCriticalAlertNotifications(db, nowIso, limit = 3) {
  return db.prepare(`
    SELECT id, host, category, severity, title, detail, source,
           notification_attempts
    FROM alerts
    WHERE resolved_at IS NULL
      AND severity = 'critical'
      AND notification_sent_at IS NULL
      AND (notification_next_attempt_at IS NULL OR notification_next_attempt_at <= ?)
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(nowIso, limit);
}

function markCriticalAlertNotificationSent(db, id, sentAt) {
  db.prepare(`
    UPDATE alerts
    SET notification_sent_at = ?,
        notification_last_error = NULL,
        notification_next_attempt_at = NULL
    WHERE id = ?
  `).run(sentAt, id);
}

function markCriticalAlertNotificationFailed(db, id, errorClass, nextAttemptAt) {
  db.prepare(`
    UPDATE alerts
    SET notification_attempts = notification_attempts + 1,
        notification_last_error = ?,
        notification_next_attempt_at = ?
    WHERE id = ?
  `).run(errorClass, nextAttemptAt, id);
}

function insertServiceVersion(db, checkedAt, service, host, deployedCommit, latestCommit, commitsBehind, driftState, driftReason) {
  db.prepare(`
    INSERT INTO service_versions
      (checked_at, service, host, deployed_commit, latest_commit, commits_behind, drift_state, drift_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(checkedAt, service, host, deployedCommit, latestCommit, commitsBehind,
    driftState || null, driftReason || null);
}

function getLatestServiceVersions(db) {
  return db.prepare(`
    SELECT sv.* FROM service_versions sv
    INNER JOIN (
      SELECT service, MAX(checked_at) as max_checked
      FROM service_versions
      GROUP BY service
    ) latest ON sv.service = latest.service AND sv.checked_at = latest.max_checked
    ORDER BY sv.service
  `).all();
}

function getDriftHistory(db, limitPerService = 24) {
  return db.prepare(`
    SELECT service, host, checked_at, deployed_commit, latest_commit, commits_behind, drift_state, drift_reason
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY service ORDER BY checked_at DESC) as rn
      FROM service_versions
    )
    WHERE rn <= ?
    ORDER BY service ASC, checked_at DESC
  `).all(limitPerService);
}

function getLastCollectionTime(db, host) {
  const row = db.prepare(`
    SELECT MAX(timestamp) as last FROM metrics WHERE host = ?
  `).get(host);
  return row ? row.last : null;
}

function saveProcessSnapshot(db, host, sortBy, processes) {
  // Keep only latest per host+sortBy
  db.prepare('DELETE FROM process_snapshots WHERE host = ? AND sort_by = ?').run(host, sortBy);
  db.prepare(`
    INSERT INTO process_snapshots (timestamp, host, sort_by, processes)
    VALUES (?, ?, ?, ?)
  `).run(new Date().toISOString(), host, sortBy, JSON.stringify(processes));
}

function getProcessSnapshot(db, host, sortBy) {
  return db.prepare(`
    SELECT * FROM process_snapshots WHERE host = ? AND sort_by = ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(host, sortBy);
}

// --- Fleet (push-agent telemetry) ---

/**
 * Normalize an always_on value to 0/1, accepting booleans, 0/1, and the
 * strings "0"/"false"/"1"/"true" (config files and fixtures supply all of
 * these). Default is 1 (always-on) when unset/undefined. Crucially `0` and
 * "0"/"false" map to 0 — otherwise a non-always-on host would false-alarm.
 */
function normAlwaysOn(v) {
  if (v === undefined || v === null) return 1;
  return (v === false || v === 0 || v === '0' || v === 'false') ? 0 : 1;
}

/**
 * Seed/refresh a host's CONFIG fields (label/role/always_on) from
 * heimdall.config.json. Does not touch dynamic fields (last_seen/os/ip).
 */
function upsertFleetHostConfig(db, { hostname, label, role, always_on }) {
  db.prepare(`
    INSERT INTO fleet_hosts (hostname, label, role, always_on)
    VALUES (@hostname, @label, @role, @always_on)
    ON CONFLICT(hostname) DO UPDATE SET
      label = excluded.label,
      role = excluded.role,
      always_on = excluded.always_on
  `).run({
    hostname,
    label: label ?? hostname,
    role: role ?? null,
    always_on: normAlwaysOn(always_on),
  });
}

const FLEET_SERIES_COLS = new Set(['cpu_pct', 'ram_used_pct', 'temp_cpu_c', 'temp_gpu_c', 'load_1']);

/**
 * Persist one fleet push: inserts a fleet_metrics row, upserts the host's
 * dynamic fields (os/platform/ip/last_seen), and fans the scalar metrics into
 * the generic `metrics` table so the existing chart endpoint works for fleet
 * hosts too. `p` is a validated/normalized payload; `receivedAt` is ISO.
 */
function recordFleetPush(db, p, receivedAt) {
  const ts = p.ts || receivedAt;
  // Capability evidence is a bounded agent observation retained alongside the
  // existing extensible telemetry map. It does not confer topology/workload
  // authority on Heimdall and is intentionally not promoted into host config.
  const extra = p.capability_contract && p.capability_contract.evidence
    ? { ...(p.extra || {}), capability_evidence: p.capability_contract.evidence }
    : p.extra;
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO fleet_metrics
        (timestamp, hostname, cpu_pct, ram_total_mb, ram_used_mb, ram_used_pct,
         uptime_s, load_1, load_5, load_15, temp_cpu_c, temp_gpu_c, disk, extra, received_at)
      VALUES (@timestamp,@hostname,@cpu_pct,@ram_total_mb,@ram_used_mb,@ram_used_pct,
         @uptime_s,@load_1,@load_5,@load_15,@temp_cpu_c,@temp_gpu_c,@disk,@extra,@received_at)
    `).run({
      timestamp: ts,
      hostname: p.hostname,
      cpu_pct: p.cpu_pct ?? null,
      ram_total_mb: p.ram_total_mb ?? null,
      ram_used_mb: p.ram_used_mb ?? null,
      ram_used_pct: p.ram_used_pct ?? null,
      uptime_s: p.uptime_s ?? null,
      load_1: p.load_1 ?? null,
      load_5: p.load_5 ?? null,
      load_15: p.load_15 ?? null,
      temp_cpu_c: p.temp_cpu_c ?? null,
      temp_gpu_c: p.temp_gpu_c ?? null,
      disk: p.disk ? JSON.stringify(p.disk) : null,
      extra: extra ? JSON.stringify(extra) : null,
      received_at: receivedAt,
    });

    db.prepare(`
      INSERT INTO fleet_hosts (hostname, label, os, platform, ip, first_seen, last_seen)
      VALUES (@hostname, @hostname, @os, @platform, @ip, @ts, @ts)
      ON CONFLICT(hostname) DO UPDATE SET
        os = excluded.os,
        platform = excluded.platform,
        ip = COALESCE(excluded.ip, fleet_hosts.ip),
        last_seen = excluded.last_seen,
        first_seen = COALESCE(fleet_hosts.first_seen, excluded.first_seen)
    `).run({
      hostname: p.hostname,
      os: p.os ?? null,
      platform: p.platform ?? null,
      ip: p.ip ?? null,
      ts: receivedAt,
    });

    // Fan scalars into the generic metrics table (for /api/metrics charts).
    const rows = [];
    const add = (metric, value, unit) => {
      if (value != null && Number.isFinite(value)) rows.push({ timestamp: ts, host: p.hostname, metric, value, unit });
    };
    add('cpu_pct', p.cpu_pct, 'percent');
    add('ram_used_pct', p.ram_used_pct, 'percent');
    add('temp_cpu_c', p.temp_cpu_c, 'celsius');
    add('load_1', p.load_1, 'load');
    add('uptime_s', p.uptime_s, 'seconds');
    if (rows.length) insertMetrics(db, rows);
  });
  tx();
}

function getFleetHosts(db) {
  return db.prepare('SELECT * FROM fleet_hosts ORDER BY hostname').all();
}

const METRIC_HOST_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Closed allowlist for the /api/metrics/:host/:metric endpoint: the two
 * SSH-collected hosts, plus any fleet host that has actually pushed
 * telemetry (fleet_hosts). Never charts an arbitrary/unknown host — this
 * bounds the query surface to hosts the DB actually knows about.
 */
function isValidMetricHost(db, host) {
  if (typeof host !== 'string' || !METRIC_HOST_PATTERN.test(host)) return false;
  if (host === 'control-node' || host === 'nas') return true;
  return getFleetHosts(db).some((h) => h.hostname === host);
}

function getLatestFleetMetric(db, hostname) {
  // Order by server-stamped received_at (not the agent-supplied timestamp) so a
  // clock-skewed agent can't pin the "latest" displayed values; id breaks ties.
  return db.prepare(
    'SELECT * FROM fleet_metrics WHERE hostname = ? ORDER BY received_at DESC, id DESC LIMIT 1'
  ).get(hostname);
}

/** Recent series of one numeric column, oldest→newest, for sparklines. */
function getFleetMetricSeries(db, hostname, column, limit = 30) {
  if (!FLEET_SERIES_COLS.has(column)) throw new Error(`invalid fleet series column: ${column}`);
  const rows = db.prepare(
    `SELECT ${column} AS v FROM fleet_metrics WHERE hostname = ? AND ${column} IS NOT NULL ORDER BY received_at DESC, id DESC LIMIT ?`
  ).all(hostname, limit);
  return rows.map((r) => r.v).reverse();
}

/** Delete raw fleet_metrics older than the given ISO cutoff. Returns row count. */
function pruneFleetMetrics(db, olderThanIso) {
  return db.prepare('DELETE FROM fleet_metrics WHERE received_at < ?').run(olderThanIso).changes;
}

// --- Service contract snapshots (discovery poller writes; pages read) ---

/**
 * Upsert the latest descriptor snapshot for one service.
 * snap: { service, kind, status, descriptor(object|null), fetchedAt, reachable,
 *         schemaVersion, source, error }
 */
/**
 * Strip empty scaffolding from a descriptor before it is persisted.
 *
 * Every stored descriptor on the live instance carried `"metrics":[],"panels":[]`
 * — zero information, repeated once per service, inside a blob an operator
 * sometimes has to read by hand. `serviceView` already defaults an absent array
 * to [], so dropping them changes nothing except the noise.
 *
 * Required identity fields (`service`, `kind`, `status`) are never dropped, even
 * when null: their absence is itself meaningful.
 */
const DESCRIPTOR_REQUIRED = new Set(['service', 'kind', 'status', '_schema']);

function compactDescriptor(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (DESCRIPTOR_REQUIRED.has(k)) { out[k] = v; continue; }
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function upsertServiceSnapshot(db, snap) {
  db.prepare(`
    INSERT INTO service_snapshots
      (service, kind, status, descriptor, fetched_at, reachable, schema_version, source, error)
    VALUES (@service, @kind, @status, @descriptor, @fetched_at, @reachable, @schema_version, @source, @error)
    ON CONFLICT(service) DO UPDATE SET
      kind = excluded.kind,
      status = excluded.status,
      descriptor = excluded.descriptor,
      fetched_at = excluded.fetched_at,
      reachable = excluded.reachable,
      schema_version = excluded.schema_version,
      source = excluded.source,
      error = excluded.error
  `).run({
    service: snap.service,
    kind: snap.kind ?? null,
    status: snap.status ?? null,
    descriptor: snap.descriptor ? JSON.stringify(compactDescriptor(snap.descriptor)) : null,
    fetched_at: snap.fetchedAt ?? null,
    reachable: snap.reachable ? 1 : 0,
    schema_version: snap.schemaVersion ?? null,
    source: snap.source ?? null,
    error: snap.error ?? null,
  });
}

function hydrateSnapshot(row) {
  if (!row) return row;
  let descriptor = null;
  try { descriptor = row.descriptor ? JSON.parse(row.descriptor) : null; } catch { /* keep null */ }
  // Expose fetchedAt (camelCase) alongside the raw fetched_at column so the
  // renderer's formatAge(v.fetchedAt) reports a real age instead of "never".
  return { ...row, descriptor, fetchedAt: row.fetched_at };
}

function getServiceSnapshots(db) {
  return db.prepare('SELECT * FROM service_snapshots ORDER BY service').all().map(hydrateSnapshot);
}

function getServiceSnapshot(db, service) {
  return hydrateSnapshot(db.prepare('SELECT * FROM service_snapshots WHERE service = ?').get(service));
}

/**
 * Latest systemd-timer run state for a service (#97), read from the timer_*
 * metrics that drift.js persists (`timer_last_result_<name>` value 1=ok/0=fail
 * with metadata 'ok'|'exit N'; `timer_last_run_<name>` / `timer_next_run_<name>`
 * metadata = ISO timestamp). Returns null when the service has no timer metrics.
 */
function getLatestTimerRun(db, service) {
  const latest = (prefix) => db.prepare(
    'SELECT value, metadata, timestamp FROM metrics WHERE metric = ? ORDER BY timestamp DESC, id DESC LIMIT 1',
  ).get(`${prefix}_${service}`);
  const result = latest('timer_last_result');
  const run = latest('timer_last_run');
  const next = latest('timer_next_run');
  if (!result && !run && !next) return null;
  // Metadata is JSON-encoded by insertMetrics (a plain string becomes "\"x\"").
  const meta = (r) => {
    if (!r || r.metadata == null) return null;
    try { return JSON.parse(r.metadata); } catch { return r.metadata; }
  };
  return {
    exitOk: result ? result.value === 1 : null,
    lastResult: meta(result),
    lastRun: meta(run),
    nextRun: meta(next),
    collectedAt: (result || run || next || {}).timestamp || null,
  };
}

/**
 * Reconcile snapshots to the current service set (#93): delete rows whose
 * `service` is not in `keepNames`. Returns the number of rows removed.
 *
 * Guard: an empty keep list (after filtering out non-string/empty entries) is a
 * no-op — a transient config-load failure must never wipe the whole dashboard.
 */
function pruneServiceSnapshots(db, keepNames) {
  const keep = Array.isArray(keepNames)
    ? keepNames.filter((n) => typeof n === 'string' && n.length > 0)
    : [];
  if (keep.length === 0) return 0;
  const placeholders = keep.map(() => '?').join(', ');
  const info = db.prepare(
    `DELETE FROM service_snapshots WHERE service NOT IN (${placeholders})`,
  ).run(...keep);
  return info.changes;
}

// --- Typed panels (generic push ingest, #57) ---

// This Brokkr card was deployment prose, not live telemetry. Keep its stored
// row untouched for rollback, but retire it from every public read/count path.
// Exact identity matching preserves Brokkr's useful hw-health and photos panels.
const RETIRED_PUSHED_PANEL = Object.freeze({ service: 'brokkr', panel: 'm5-memlimits' });

function isRetiredPushedPanel(service, panel) {
  return service === RETIRED_PUSHED_PANEL.service && panel === RETIRED_PUSHED_PANEL.panel;
}

const VISIBLE_PANEL_SQL = 'NOT (service = ? AND panel = ?)';
const visiblePanelParams = () => [RETIRED_PUSHED_PANEL.service, RETIRED_PUSHED_PANEL.panel];

/**
 * Upsert one typed panel by (service, panel). `data` is the kind-specific
 * payload object (serialized to JSON). Latest push wins.
 * row: { service, panel, kind, label, unit, data(object), updated_at? }
 */
function upsertPanel(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO panels (service, panel, kind, label, unit, data, updated_at)
    VALUES (@service, @panel, @kind, @label, @unit, @data, @updated_at)
  `).run({
    service: row.service,
    panel: row.panel,
    kind: row.kind,
    label: row.label ?? null,
    unit: row.unit ?? null,
    data: row.data != null ? JSON.stringify(row.data) : null,
    updated_at: row.updated_at != null ? row.updated_at : Date.now(),
  });
}

function hydratePanel(row) {
  if (!row) return row;
  let data = null;
  try { data = row.data ? JSON.parse(row.data) : null; } catch { /* keep null */ }
  return { ...row, data };
}

/** All pushed panels for one service, ordered by panel id, with `data` parsed. */
function getPanelsForService(db, service) {
  return db.prepare(`SELECT * FROM panels WHERE service = ? AND ${VISIBLE_PANEL_SQL} ORDER BY panel`)
    .all(service, ...visiblePanelParams()).map(hydratePanel);
}

/** Count of distinct pushed panels for one service (per-service cap input). */
function countPanelsForService(db, service) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM panels WHERE service = ? AND ${VISIBLE_PANEL_SQL}`)
    .get(service, ...visiblePanelParams());
  return row ? row.n : 0;
}

/** Total panel row count across all services (global cap input). */
function countPanels(db) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM panels WHERE ${VISIBLE_PANEL_SQL}`)
    .get(...visiblePanelParams());
  return row ? row.n : 0;
}

/** Count of distinct service ids in the panels table (global cap input). */
function countPanelServices(db) {
  const row = db.prepare(`SELECT COUNT(DISTINCT service) AS n FROM panels WHERE ${VISIBLE_PANEL_SQL}`)
    .get(...visiblePanelParams());
  return row ? row.n : 0;
}

/** Distinct pushed-panel services with panel count + latest push time (#102). */
function listPanelServices(db) {
  return db.prepare(
    `SELECT service, COUNT(*) AS panels, MAX(updated_at) AS updated_at
     FROM panels WHERE ${VISIBLE_PANEL_SQL} GROUP BY service ORDER BY service`,
  ).all(...visiblePanelParams());
}

/** All pushed panels, summary columns only (no data payload) — read-back listing (#102). */
function listPanels(db) {
  return db.prepare(
    `SELECT service, panel, kind, label, unit, updated_at
     FROM panels WHERE ${VISIBLE_PANEL_SQL} ORDER BY service, panel`,
  ).all(...visiblePanelParams());
}

module.exports = {
  openDatabase,
  upsertPanel,
  getPanelsForService,
  countPanelsForService,
  countPanels,
  countPanelServices,
  listPanelServices,
  listPanels,
  isRetiredPushedPanel,
  insertMetric,
  insertMetrics,
  getLatestMetrics,
  getMetricHistory,
  getMetricHistoryWithRollup,
  insertEvent,
  getRecentEvents,
  searchEvents,
  getActiveAlerts,
  getUnacknowledgedAlerts,
  createAlert,
  resolveAlert,
  resolveAlertByDedupKey,
  acknowledgeAlert,
  resolveAlertById,
  getPendingCriticalAlertNotifications,
  markCriticalAlertNotificationSent,
  markCriticalAlertNotificationFailed,
  insertServiceVersion,
  getLatestServiceVersions,
  getDriftHistory,
  getLastCollectionTime,
  saveProcessSnapshot,
  getProcessSnapshot,
  upsertFleetHostConfig,
  normAlwaysOn,
  recordFleetPush,
  getFleetHosts,
  isValidMetricHost,
  getLatestFleetMetric,
  getFleetMetricSeries,
  pruneFleetMetrics,
  upsertServiceSnapshot,
  getServiceSnapshots,
  getServiceSnapshot,
  pruneServiceSnapshots,
  getLatestTimerRun,
  compactDescriptor,
};
