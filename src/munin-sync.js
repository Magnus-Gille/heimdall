'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { muninRpc: muninRpcShared } = require('./munin-rpc');

const NAMESPACE = 'infrastructure/alerts';
const STATE_FILE = path.join(os.homedir(), '.heimdall', 'munin-sync-state.json');

function loadApiKey() {
  if (process.env.MUNIN_API_KEY) return process.env.MUNIN_API_KEY;
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'munin-memory', '.env'), 'utf8');
    const match = envFile.match(/^MUNIN_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ok */ }
  return null;
}

/**
 * Load previously synced alert titles from disk.
 * Returns { titles: Map<title, {severity, host, category}>, fingerprint: string }
 */
function loadSyncState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const titles = new Map(Object.entries(data.alerts || {}));
    return { titles, fingerprint: data.fingerprint || '' };
  } catch {
    return { titles: new Map(), fingerprint: '' };
  }
}

/**
 * Save current alert state to disk for next cycle comparison.
 */
function saveSyncState(alertMap, fingerprint) {
  const data = {
    fingerprint,
    alerts: Object.fromEntries(alertMap),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

const muninRpc = (method, args) => muninRpcShared(method, args, { apiKey: loadApiKey(), timeoutMs: 5000, label: 'Munin sync' });

/**
 * Compute a fingerprint of current active alerts for change detection.
 */
function computeFingerprint(alertMap) {
  const keys = [...alertMap.entries()]
    .map(([key, info]) => `${key}:${info.severity}`)
    .sort()
    .join('|');
  return crypto.createHash('md5').update(keys).digest('hex');
}

/**
 * Sync current alert state to Munin.
 * Only writes when alert state changes (new alert fires or existing alert resolves).
 * Persists sync state to disk so it survives process restarts.
 * @param {object} db - better-sqlite3 database instance
 */
async function syncAlertsToMunin(db) {
  const { getActiveAlerts } = require('./alerts');
  const activeAlerts = getActiveAlerts(db);

  // Build latest-state map: host:title → { severity, host, category, detail, title }
  // Key on host:title to match the DB's (host, title) dedup identity
  const currentState = new Map();
  for (const alert of activeAlerts) {
    currentState.set(`${alert.host}:${alert.title}`, {
      severity: alert.severity,
      host: alert.host,
      category: alert.category,
      detail: alert.detail,
      title: alert.title,
    });
  }

  const currentFingerprint = computeFingerprint(currentState);
  const prevState = loadSyncState();

  // No state change — skip all Munin writes
  if (currentFingerprint === prevState.fingerprint) {
    return;
  }

  let logged = 0;

  // Detect newly fired alerts (in current but not in previous, or severity changed)
  for (const [key, info] of currentState) {
    const prev = prevState.titles.get(key);
    if (!prev || prev.severity !== info.severity) {
      const msg = `ALERT FIRED [${info.severity}] ${info.title} on ${info.host} — ${info.detail || 'no detail'}`;
      await muninRpc('memory_log', {
        namespace: NAMESPACE,
        content: msg,
        tags: ['alert', info.severity, 'fired', info.host, info.category],
      });
      logged++;
    }
  }

  // Detect resolved alerts (in previous but not in current)
  for (const [key, info] of prevState.titles) {
    if (!currentState.has(key)) {
      const msg = `ALERT RESOLVED [${info.severity}] ${info.title} on ${info.host}`;
      await muninRpc('memory_log', {
        namespace: NAMESPACE,
        content: msg,
        tags: ['alert', info.severity, 'resolved', info.host, info.category],
      });
      logged++;
    }
  }

  // Write active alerts summary (structured for LLM consumption)
  const lines = [];
  if (currentState.size === 0) {
    lines.push('No active infrastructure alerts. All systems healthy.');
  } else {
    lines.push(`${currentState.size} active alert(s) as of ${new Date().toISOString()}:\n`);
    for (const [key, info] of currentState) {
      lines.push(`- severity: ${info.severity} | host: ${info.host} | category: ${info.category}`);
      lines.push(`  title: ${info.title}`);
      if (info.detail) lines.push(`  detail: ${info.detail}`);
    }
  }
  await muninRpc('memory_write', {
    namespace: NAMESPACE,
    key: 'active',
    content: lines.join('\n'),
    tags: ['alert', 'infrastructure', 'status'],
  });

  // Persist state for next cycle (keyed by host:title)
  const stateToSave = new Map();
  for (const [key, info] of currentState) {
    stateToSave.set(key, { severity: info.severity, host: info.host, category: info.category, title: info.title });
  }
  saveSyncState(stateToSave, currentFingerprint);

  if (logged > 0) {
    console.log(`  Munin sync: ${logged} alert state change(s) logged`);
  } else {
    console.log('  Munin sync: active alerts summary updated');
  }
}

module.exports = { syncAlertsToMunin };
