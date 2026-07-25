'use strict';

const path = require('path');
const os = require('os');
const { openDatabase, insertMetrics, getLastCollectionTime, saveProcessSnapshot } = require('./db');
const { execSync } = require('child_process');
const { collectLocalMetrics, parseSSHOutput, collectRemoteViaSSH, ping, checkInternetConnectivity, collectNetworkQuality, computeCpuBusyPct, CPU_TICK_FIELDS } = require('./metrics');
const { STATES, recordState, getState } = require('./nas-state');
const { readHuginTasks, detectTaskChanges, readHuginHeartbeat, getTimeoutCalibration } = require('./hugin');
const { collectServiceDrift } = require('./drift');
const { logEvent, detectSSHLogins, detectServiceRestarts, checkThresholds, checkTempRateOfChange, detectReboot } = require('./events');
const { checkBackupStaleness } = require('./alerts');
const { loadBackupDefinitions } = require('./backup-config');
const { collectMicrosoftMcpHealth } = require('./microsoft-mcp');
const { collectMcpHealth } = require('./mcp-probe');
const { collectInferenceHealth } = require('./inference');
const { syncAlertsToMunin } = require('./munin-sync');
const { checkAndHeal } = require('./self-heal');

const NAS_IP = process.env.HEIMDALL_STORAGE_SSH_HOST || '192.0.2.20';
const SSH_KEY = path.join(os.homedir(), '.ssh', 'heimdall_ed25519');

// Derive a cpu_busy_pct metric row from this cycle's CPU ticks vs. the previous
// cycle's stored ticks. Returns null if either snapshot is incomplete (e.g. the
// very first cycle). Must be called BEFORE the current ticks are inserted, so
// the DB's latest tick row is genuinely the previous cycle.
function deriveCpuBusyRow(db, host, curFlat, timestamp) {
  const cur = {};
  for (const f of CPU_TICK_FIELDS) {
    if (curFlat[f] == null) return null;
    cur[f] = curFlat[f];
  }
  const prev = {};
  for (const f of CPU_TICK_FIELDS) {
    const r = db.prepare(
      'SELECT value FROM metrics WHERE host = ? AND metric = ? AND value IS NOT NULL ORDER BY timestamp DESC LIMIT 1'
    ).get(host, f);
    if (!r) return null;
    prev[f] = r.value;
  }
  const busy = computeCpuBusyPct(prev, cur);
  if (busy == null) return null;
  return { timestamp, host, metric: 'cpu_busy_pct', value: busy, unit: 'percent', metadata: null };
}

async function run() {
  const db = openDatabase();
  // Fail before collecting partial data if a source lacks an explicit cadence.
  const backupDefinitions = loadBackupDefinitions();
  const timestamp = new Date().toISOString();
  const cycleStartMs = Date.now();
  let collectorSuccess = 1;
  let collectorLastError = null;

  console.log(`[${timestamp}] Starting collection cycle`);

  // 0. Internet connectivity check
  try {
    const internetOk = checkInternetConnectivity();
    insertMetrics(db, [{
      timestamp, host: 'control-node', metric: 'internet_ok',
      value: internetOk ? 1 : 0, unit: 'boolean', metadata: null,
    }]);
    if (!internetOk) {
      logEvent(db, 'control-node', 'system', 'warning', 'Internet unreachable', null, 'collector');
    }
  } catch (err) {
    console.error('  Internet check failed:', err.message);
  }

  // 0b. Network quality probes (latency + packet loss)
  try {
    const netQuality = collectNetworkQuality(NAS_IP);
    const nqRows = [];
    for (const [metric, data] of Object.entries(netQuality)) {
      if (data.value != null) {
        nqRows.push({ timestamp, host: 'control-node', metric, value: data.value, unit: data.unit, metadata: null });
      }
    }
    if (nqRows.length > 0) insertMetrics(db, nqRows);
    console.log(`  Network quality: ${nqRows.length} metrics`);
  } catch (err) {
    console.error('  Network quality probes failed:', err.message);
  }

  // 1. Collect local metrics
  let localMetrics;
  try {
    localMetrics = collectLocalMetrics();
    const rows = [];
    for (const [metric, data] of Object.entries(localMetrics.metrics)) {
      if (data.value != null) {
        rows.push({
          timestamp: localMetrics.timestamp,
          host: 'control-node',
          metric,
          value: data.value,
          unit: data.unit,
          metadata: data.metadata || null,
        });
      }
    }
    // Derive CPU-busy % from this cycle's ticks vs. the previous cycle (before insert)
    const localFlat = {};
    for (const [k, v] of Object.entries(localMetrics.metrics)) { localFlat[k] = v.value; }
    const localBusyRow = deriveCpuBusyRow(db, 'control-node', localFlat, localMetrics.timestamp);
    if (localBusyRow) rows.push(localBusyRow);
    if (rows.length > 0) insertMetrics(db, rows);
    console.log(`  Local: ${rows.length} metrics collected`);

    // Check thresholds
    const metricsFlat = {};
    for (const [k, v] of Object.entries(localMetrics.metrics)) { metricsFlat[k] = v.value; }
    checkThresholds(db, 'control-node', metricsFlat);
    checkTempRateOfChange(db, 'control-node', metricsFlat.cpu_temp);

    // Optional reverse-proxy liveness alert. It is disabled by default because
    // Heimdall does not require or assume any particular public ingress.
    if (/^(1|true)$/i.test(process.env.HEIMDALL_MONITOR_CLOUDFLARED || '')) {
      const tunnelTitle = 'Cloudflare Tunnel down';
      if (metricsFlat.cloudflared_active === 0) {
        const { createAlert } = require('./alerts');
        createAlert(db, 'control-node', 'system', 'critical', tunnelTitle, 'Configured cloudflared service is not active');
      } else {
        const { resolveAlert } = require('./alerts');
        resolveAlert(db, 'control-node', tunnelTitle);
      }
    }

    // Under-voltage alert
    const uvTitle = 'Under-voltage detected on control-node';
    if (metricsFlat.under_voltage === 1) {
      const { createAlert } = require('./alerts');
      createAlert(db, 'control-node', 'system', 'critical', uvTitle, 'Check power supply — inadequate power can cause instability');
      logEvent(db, 'control-node', 'system', 'critical', uvTitle, null, 'collector');
    } else if (metricsFlat.under_voltage === 0) {
      const { resolveAlert } = require('./alerts');
      resolveAlert(db, 'control-node', uvTitle);
    }

    // Detect reboot
    const prevUptime = db.prepare(
      "SELECT value FROM metrics WHERE host = 'control-node' AND metric = 'uptime' AND timestamp < ? ORDER BY timestamp DESC LIMIT 1"
    ).get(localMetrics.timestamp);
    if (prevUptime) {
      detectReboot(db, 'control-node', metricsFlat.uptime, prevUptime.value);
    }
  } catch (err) {
    console.error('  Local collection failed:', err.message);
    logEvent(db, 'control-node', 'system', 'error', 'Local collection failed', err.message, 'collector');
    collectorSuccess = 0;
    collectorLastError = `local: ${err.message}`;
  }

  // 1b. Collect top processes
  try {
    function parsePs(output) {
      const lines = output.trim().split('\n').slice(1); // skip header
      return lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          user: parts[0],
          pid: parseInt(parts[1]),
          cpu: parseFloat(parts[2]),
          mem: parseFloat(parts[3]),
          command: parts.slice(10).join(' ').slice(0, 80),
        };
      }).filter(p => p.pid);
    }
    const psCpu = execSync('ps aux --sort=-%cpu | head -6', { encoding: 'utf8', timeout: 5000 });
    const psMem = execSync('ps aux --sort=-%mem | head -6', { encoding: 'utf8', timeout: 5000 });
    saveProcessSnapshot(db, 'control-node', 'cpu', parsePs(psCpu));
    saveProcessSnapshot(db, 'control-node', 'mem', parsePs(psMem));
    console.log('  Processes: snapshot saved');
  } catch (err) {
    console.error('  Process collection failed:', err.message);
  }

  // 2. Collect remote metrics (NAS)
  try {
    const pingOk = ping(NAS_IP, 3);

    if (!pingOk) {
      recordState(db, STATES.UNREACHABLE);
      logEvent(db, 'nas', 'system', 'critical', 'NAS host unreachable (ping failed)', null, 'collector');
      console.log('  NAS: unreachable (ping failed)');
    } else {
      try {
        const sshOutput = collectRemoteViaSSH(SSH_KEY, NAS_IP);
        const parsed = parseSSHOutput(sshOutput);

        const rows = [];
        let failures = 0;
        let total = 0;
        for (const [metric, data] of Object.entries(parsed)) {
          total++;
          if (data.value != null || data.metadata) {
            rows.push({
              timestamp,
              host: 'nas',
              metric,
              value: data.value,
              unit: data.unit,
              metadata: data.metadata || null,
            });
          } else if (data.unit !== 'text') {
            failures++;
          }
        }

        // Derive CPU-busy % from this cycle's ticks vs. the previous cycle (before insert)
        const nasTickFlat = {};
        for (const [k, v] of Object.entries(parsed)) { nasTickFlat[k] = v.value; }
        const nasBusyRow = deriveCpuBusyRow(db, 'nas', nasTickFlat, timestamp);
        if (nasBusyRow) rows.push(nasBusyRow);

        if (rows.length > 0) insertMetrics(db, rows);

        if (failures === 0 && total > 0) {
          // Log recovery event if transitioning from broken state
          const prevState = getState(db);
          if (prevState.state === STATES.SSH_BROKEN || prevState.state === STATES.UNREACHABLE) {
            logEvent(db, 'nas', 'system', 'info', 'NAS connection recovered',
              `Previous state: ${prevState.state}`, 'collector');
          }
          recordState(db, STATES.HEALTHY);
          console.log(`  NAS: ${rows.length} metrics collected (healthy)`);
        } else if (total === 0 || failures >= total) {
          recordState(db, STATES.DEGRADED, 'All probes failed');
          logEvent(db, 'nas', 'system', 'error',
            'NAS SSH succeeded but all probes failed', null, 'collector');
          console.log('  NAS: degraded (all probes failed)');
        } else {
          recordState(db, STATES.DEGRADED, `${failures} probes failed`);
          logEvent(db, 'nas', 'system', 'warning',
            `NAS degraded: ${failures} probes failed`, null, 'collector');
          console.log(`  NAS: degraded (${failures} probes failed)`);
        }

        // Check NAS thresholds
        const nasFlat = {};
        for (const [k, v] of Object.entries(parsed)) { nasFlat[k] = v.value; }
        checkThresholds(db, 'nas', nasFlat);
        checkTempRateOfChange(db, 'nas', nasFlat.cpu_temp);

        // Detect NAS reboot
        const prevNasUptime = db.prepare(
          "SELECT value FROM metrics WHERE host = 'nas' AND metric = 'uptime' AND timestamp < ? ORDER BY timestamp DESC LIMIT 1"
        ).get(timestamp);
        if (prevNasUptime) {
          detectReboot(db, 'nas', nasFlat.uptime, prevNasUptime.value);
        }

        // Check backup staleness and create events (Issue 3 + Issue 8)
        if (parsed.tm_last_backup?.value) {
          const tmTimestamp = new Date(parsed.tm_last_backup.value * 1000).toISOString();
          checkBackupStaleness(db, 'TM Backup', tmTimestamp, backupDefinitions);

          // Detect fresh TM backup (event)
          const prevTm = db.prepare(
            "SELECT value FROM metrics WHERE host = 'nas' AND metric = 'tm_last_backup' AND timestamp < ? ORDER BY timestamp DESC LIMIT 1"
          ).get(timestamp);
          if (prevTm && prevTm.value !== parsed.tm_last_backup.value) {
            logEvent(db, 'nas', 'backup', 'info', 'TM backup detected',
              `New backup at ${tmTimestamp}`, 'collector');
          }
        }

        if (parsed.munin_backup_latest?.metadata?.filename) {
          const filename = parsed.munin_backup_latest.metadata.filename;
          const match = filename.match(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})/);
          if (match) {
            checkBackupStaleness(db, 'Munin DB', `${match[1]}T${match[2]}:${match[3]}:00Z`, backupDefinitions);
          } else {
            const dateOnly = filename.match(/(\d{4}-\d{2}-\d{2})/);
            if (dateOnly) {
              checkBackupStaleness(db, 'Munin DB', dateOnly[1] + 'T00:00:00Z', backupDefinitions);
            }
          }
          // Detect new munin backup
          const prevMunin = db.prepare(
            "SELECT metadata FROM metrics WHERE host = 'nas' AND metric = 'munin_backup_latest' AND timestamp < ? ORDER BY timestamp DESC LIMIT 1"
          ).get(timestamp);
          if (prevMunin) {
            let prevMeta = {};
            try { prevMeta = JSON.parse(prevMunin.metadata || '{}'); } catch { /* ok */ }
            if (prevMeta.filename !== filename) {
              logEvent(db, 'nas', 'backup', 'info', 'Munin backup completed',
                `New backup: ${filename}`, 'collector');
            }
          }
        }

        if (parsed.mimir_sync_latest?.value) {
          const syncTimestamp = new Date(parsed.mimir_sync_latest.value * 1000).toISOString();
          checkBackupStaleness(db, 'Mímir Sync', syncTimestamp, backupDefinitions);
        }

        if (parsed.mimir_backup_last?.metadata?.line) {
          const line = parsed.mimir_backup_last.metadata.line;
          const match = line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/);
          if (match) {
            checkBackupStaleness(db, 'Mímir Backup', match[1].replace(' ', 'T') + ':00Z', backupDefinitions);
          }
        }
      } catch (sshErr) {
        recordState(db, STATES.SSH_BROKEN, sshErr.message);
        logEvent(db, 'nas', 'system', 'error',
          'NAS reachable but SSH collection failed', sshErr.message, 'collector');
        console.log('  NAS: SSH broken -', sshErr.message);
      }
    }
  } catch (err) {
    console.error('  NAS collection error:', err.message);
    logEvent(db, 'nas', 'system', 'error', 'NAS collection error', err.message, 'collector');
    collectorSuccess = 0;
    collectorLastError = `nas: ${err.message}`;
  }

  // 2b. Collect Munin DB stats
  try {
    const muninDbPath = path.join(os.homedir(), '.munin-memory', 'memory.db');
    const muninStat = require('fs').statSync(muninDbPath);
    const muninDb = require('better-sqlite3')(muninDbPath, { readonly: true, fileMustExist: true });
    try {
      const entryCount = muninDb.prepare('SELECT COUNT(*) as c FROM entries').get().c;
      insertMetrics(db, [
        { timestamp, host: 'control-node', metric: 'munin_db_size', value: muninStat.size, unit: 'bytes', metadata: null },
        { timestamp, host: 'control-node', metric: 'munin_entry_count', value: entryCount, unit: 'count', metadata: null },
      ]);
      console.log(`  Munin DB: ${entryCount} entries, ${(muninStat.size / 1024).toFixed(0)} KB`);
    } finally {
      muninDb.close();
    }
  } catch (err) {
    console.error('  Munin DB stats failed:', err.message);
  }

  // 2c. MCP transport health probe
  try {
    const mcpResult = await collectMcpHealth(db, timestamp);
    console.log(`  MCP probe: healthy=${mcpResult.healthy} latency=${mcpResult.latency_ms}ms${mcpResult.error ? ' error=' + mcpResult.error : ''}`);
  } catch (err) {
    console.error('  MCP probe failed:', err.message);
  }

  // 2d. M5 inference-gateway health + capability-ledger summary.
  // Reads HOMESERVER_GATEWAY_URL (M5 Tailscale URL, e.g. http://192.0.2.30:8080) and
  // HOMESERVER_GATEWAY_API_KEY (owner Bearer — needed for /ledger; healthz is public).
  // Both must be set in ~/.heimdall/env on the Pi. When unset/unreachable the card shows
  // "down" and the alert fires after two consecutive down probes (streak from DB).
  try {
    const infResult = await collectInferenceHealth(db, timestamp);
    console.log(`  M5 inference: healthy=${infResult.healthy} latency=${infResult.latency_ms}ms${infResult.error ? ' error=' + infResult.error : ''}`);
  } catch (err) {
    console.error('  M5 inference probe failed:', err.message);
  }

  // 3. Collect Hugin tasks
  try {
    const tasks = readHuginTasks();
    const taskEvents = detectTaskChanges(db, tasks);
    for (const evt of taskEvents) {
      logEvent(db, 'control-node', evt.category, evt.severity, evt.title, evt.detail, evt.source);
    }
    console.log(`  Hugin: ${tasks.length} tasks read, ${taskEvents.length} new events`);

    // 3a. Send Telegram notifications for completed/failed tasks (via ratatoskr)
    try {
      const { sendTaskNotifications } = require('./notify');
      const notifyResult = await sendTaskNotifications(db);
      if (!notifyResult.skipped) {
        console.log(`  Notifications: ${notifyResult.sent} sent, ${notifyResult.failed} failed`);
      }
    } catch (notifyErr) {
      console.error('  Task notification check failed:', notifyErr.message);
    }
  } catch (err) {
    console.error('  Hugin task collection failed:', err.message);
  }

  // 3b. Hugin dispatcher heartbeat
  try {
    const heartbeat = readHuginHeartbeat();
    const alertTitle = 'Hugin dispatcher may be down';
    if (heartbeat && heartbeat.status !== 'unknown') {
      insertMetrics(db, [
        { timestamp, host: 'control-node', metric: 'hugin_heartbeat_age_ms', value: heartbeat.freshness_ms, unit: 'ms', metadata: null },
        { timestamp, host: 'control-node', metric: 'hugin_queue_depth', value: heartbeat.queue_depth, unit: 'count', metadata: null },
        { timestamp, host: 'control-node', metric: 'hugin_uptime_s', value: heartbeat.uptime_s, unit: 'seconds', metadata: null },
      ]);

      // Alert if heartbeat stale >5 min
      if (heartbeat.freshness_ms > 5 * 60000) {
        const { createAlert } = require('./alerts');
        createAlert(db, 'control-node', 'task', 'warning', alertTitle,
          `No heartbeat since ${heartbeat.polled_at}`);
      } else {
        const { resolveAlert } = require('./alerts');
        resolveAlert(db, 'control-node', alertTitle);
      }
      console.log(`  Hugin heartbeat: ${heartbeat.status} (${Math.round(heartbeat.freshness_ms / 1000)}s ago)`);
    } else {
      console.log('  Hugin heartbeat: no data');
    }
  } catch (err) {
    console.error('  Hugin heartbeat collection failed:', err.message);
  }

  // 3c. Timeout calibration metrics
  try {
    const cal = getTimeoutCalibration(30);
    if (cal && cal.sampleSize > 0) {
      insertMetrics(db, [
        { timestamp, host: 'control-node', metric: 'hugin_timeout_sample_size', value: cal.sampleSize, unit: 'count', metadata: null },
        { timestamp, host: 'control-node', metric: 'hugin_timeout_ratio_avg', value: cal.timeoutRatio, unit: 'ratio', metadata: null },
        { timestamp, host: 'control-node', metric: 'hugin_timeout_over_utilized', value: cal.overUtilized, unit: 'count', metadata: null },
        { timestamp, host: 'control-node', metric: 'hugin_timeout_under_utilized', value: cal.underUtilized, unit: 'count', metadata: null },
        { timestamp, host: 'control-node', metric: 'hugin_timeout_timed_out', value: cal.timedOut, unit: 'count', metadata: null },
        { timestamp, host: 'control-node', metric: 'hugin_median_duration_s', value: cal.medianDurationS, unit: 'seconds', metadata: null },
      ]);
      console.log(`  Hugin calibration: ${cal.sampleSize} tasks, ${cal.overUtilized} over-utilized, ${cal.underUtilized} under-utilized, median ${cal.medianDurationS}s`);
    } else {
      console.log('  Hugin calibration: no data');
    }
  } catch (err) {
    console.error('  Hugin calibration failed:', err.message);
  }

  // 4. Collect deploy drift + service restart counts
  try {
    // Fold alerts still keyed to a retired host identity onto the canonical one
    // BEFORE evaluating, or the evaluator's resolve can never match them.
    try {
      const { reconcileAlertHosts } = require('./alert-reaper');
      const { loadConfig } = require('./config/services');
      const { loadHostAliases } = require('./host-identity');
      const rec = reconcileAlertHosts(db, loadHostAliases(loadConfig()));
      if (rec.migrated || rec.merged) {
        console.log(`  Alert host reconcile: ${rec.migrated} re-hosted, ${rec.merged} merged`);
      }
    } catch (err) {
      console.error('  Alert host reconcile failed:', err.message);
    }

    const driftResults = await collectServiceDrift(db);
    const drifting = driftResults.filter(s => s.drift_state === 'drift');
    const unmeasurable = driftResults.filter(s => s.drift_state === 'unknown');
    console.log(`  Drift: ${driftResults.length} services checked, ${drifting.length} behind, ${unmeasurable.length} not measurable`);

    // Deploy drift is a property of a repo CHECKOUT on a host, not of each
    // systemd unit reading from it, and an uninterpretable comparison is an
    // instrumentation failure rather than drift. Both rules live in drift-alerts.js.
    const { evaluateDriftAlerts } = require('./drift-alerts');
    const driftAlerts = evaluateDriftAlerts(db, driftResults);
    if (driftAlerts.fired.length) {
      console.log(`  Drift alerts: ${driftAlerts.fired.map(f => `${f.repo} (${f.units.join(', ')})`).join('; ')}`);
    }
    for (const u of driftAlerts.unknown) {
      // Reported, never alerted: a number nobody can interpret must not page anyone.
      console.log(`  Drift not measurable for ${u.service}: ${u.reason}`);
    }

    // A scheduled job that could not run is exactly what should reach the owner,
    // and it had no path to an alert at all before this (the alert engine only
    // evaluates descriptor rules, which config-only timers do not have).
    const { evaluateTimerAlerts } = require('./timer-alerts');
    const timerAlerts = evaluateTimerAlerts(db, driftResults);
    if (timerAlerts.failed.length) {
      console.log(`  Timer failures: ${timerAlerts.failed.map(f => `${f.service} (${f.outcome})`).join(', ')}`);
    }
    if (timerAlerts.findings.length) {
      // Findings are a RESULT, not a failure — reported, not alerted.
      console.log(`  Timer findings: ${timerAlerts.findings.map(f => `${f.service}${f.count != null ? ` (${f.count})` : ''}`).join(', ')}`);
    }

    // Cache restart counts as metrics (avoid journalctl in request handlers)
    const { loadServiceRegistry, getServiceRestartCount } = require('./drift');
    const registry = loadServiceRegistry();
    const restartRows = [];
    for (const svc of registry) {
      if (svc.systemd_unit) {
        const count = getServiceRestartCount(svc.systemd_unit);
        restartRows.push({
          timestamp, host: 'control-node',
          metric: `service_restarts_24h_${svc.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
          value: count, unit: 'count', metadata: null,
        });
      }
    }
    if (restartRows.length > 0) insertMetrics(db, restartRows);
    console.log(`  Restarts: ${restartRows.length} services checked`);
  } catch (err) {
    console.error('  Drift collection failed:', err.message);
  }

  // 5. Collect Skuld briefing status
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch('http://localhost:3040/health', { signal: controller.signal });
    clearTimeout(timeout);
    const health = await resp.json();
    const skuldRows = [];
    if (health.briefingDate) {
      skuldRows.push({
        timestamp, host: 'control-node',
        metric: 'skuld_briefing_date', value: 0,
        unit: 'date', metadata: health.briefingDate,
      });
    }
    skuldRows.push({
      timestamp, host: 'control-node',
      metric: 'skuld_has_briefing', value: health.hasBriefing ? 1 : 0,
      unit: 'bool', metadata: null,
    });
    if (skuldRows.length > 0) insertMetrics(db, skuldRows);
    console.log(`  Skuld: briefing=${health.hasBriefing}, date=${health.briefingDate || 'none'}`);
  } catch (err) {
    console.log(`  Skuld: unreachable (${err.message})`);
  }

  // 6. Detect system events — use last collection time to avoid gaps/overlaps (Issue 4)
  try {
    const lastCollection = getLastCollectionTime(db, 'control-node');
    // Default to 6 minutes ago if no previous collection (slightly wider than 5min interval)
    const since = lastCollection
      ? new Date(new Date(lastCollection).getTime() - 10000).toISOString() // 10s overlap for safety
      : new Date(Date.now() - 360000).toISOString();

    const sshEvents = detectSSHLogins(since);
    const restartEvents = detectServiceRestarts(since);

    for (const evt of [...sshEvents, ...restartEvents]) {
      // Deduplicate by checking if event with same title exists in the window
      const existing = db.prepare(
        "SELECT id FROM events WHERE title = ? AND detail = ? AND timestamp > ? LIMIT 1"
      ).get(evt.title, evt.detail, since);
      if (!existing) {
        logEvent(db, 'control-node', evt.category, evt.severity, evt.title, evt.detail, 'journald');
      }
    }
    if (sshEvents.length || restartEvents.length) {
      console.log(`  Events: ${sshEvents.length} SSH, ${restartEvents.length} service restarts`);
    }
  } catch (err) {
    console.error('  Event detection failed:', err.message);
  }

  // 6. Microsoft MCP token health (from synced health file)
  try {
    const mcpHealth = collectMicrosoftMcpHealth();
    insertMetrics(db, [{
      timestamp, host: 'control-node', metric: 'microsoft_mcp_token_healthy',
      value: mcpHealth.healthy ? 1 : 0, unit: 'boolean',
      metadata: {
        age_hours: mcpHealth.age_hours,
        accounts: mcpHealth.accounts,
        checked_at: mcpHealth.checked_at,
        ...(mcpHealth.error ? { error: mcpHealth.error } : {}),
      },
    }]);
    if (!mcpHealth.healthy) {
      logEvent(db, 'control-node', 'service', 'warning',
        `Microsoft MCP token unhealthy: ${mcpHealth.error || 'expired or stale'}`,
        null, 'collector');
    }
    console.log(`  Microsoft MCP: healthy=${mcpHealth.healthy} age=${mcpHealth.age_hours}h`);
  } catch (err) {
    console.error('  Microsoft MCP health check failed:', err.message);
  }

  // 7. Self-monitoring: check DB size
  try {
    const dbPath = process.env.DB_PATH || path.join(os.homedir(), '.heimdall', 'heimdall.db');
    const stat = require('fs').statSync(dbPath);
    if (stat.size > 200 * 1024 * 1024) {
      logEvent(db, 'control-node', 'system', 'warning',
        `Heimdall DB exceeds 200MB: ${(stat.size / 1024 / 1024).toFixed(1)}MB`,
        null, 'collector');
    }
  } catch { /* ok if db file doesn't exist yet */ }

  // 8. Check disk space guard
  try {
    const localDiskPct = localMetrics?.metrics?.disk_used_pct_sd?.value;
    if (localDiskPct != null && localDiskPct > 90) {
      console.error('  WARNING: SD card >90% full, collection will continue but monitor closely');
      logEvent(db, 'control-node', 'system', 'critical',
        `SD card ${localDiskPct.toFixed(0)}% full`, null, 'collector');
    }
  } catch { /* ok */ }

  // 9. Write collector health metrics
  try {
    const cycleDurationMs = Date.now() - cycleStartMs;
    const endTimestamp = new Date().toISOString();
    insertMetrics(db, [
      { timestamp: endTimestamp, host: 'control-node', metric: 'collector_last_run', value: Math.floor(Date.now() / 1000), unit: 'epoch', metadata: null },
      { timestamp: endTimestamp, host: 'control-node', metric: 'collector_run_duration_ms', value: cycleDurationMs, unit: 'ms', metadata: null },
      { timestamp: endTimestamp, host: 'control-node', metric: 'collector_success', value: collectorSuccess, unit: 'boolean', metadata: null },
      { timestamp: endTimestamp, host: 'control-node', metric: 'collector_last_error', value: null, unit: 'text', metadata: collectorLastError ? { error: collectorLastError } : null },
    ]);
    console.log(`  Collector health: duration=${cycleDurationMs}ms success=${collectorSuccess}`);
  } catch (err) {
    console.error('  Collector health metrics failed:', err.message);
  }

  // 9b. Generic declarative alert engine — evaluates declared rules
  // (descriptor.alerts.rules in service_snapshots) against the metrics written
  // above. Replaces the per-probe streak logic formerly in inference.js/mcp-probe.js.
  try {
    // Self-seed the Heimdall-built rule descriptors so alerting works regardless
    // of whether the dashboard server has run/seeded them this boot — the
    // collector is a separate process and must not depend on server ordering.
    const { upsertServiceSnapshot } = require('./db');
    try { upsertServiceSnapshot(db, require('./plugins/inference').m5Snapshot(db)); } catch { /* ignore */ }
    try { upsertServiceSnapshot(db, require('./mcp-probe').mcpSnapshot(db)); } catch { /* ignore */ }
    const { runAlertEngine } = require('./alert-engine');
    const r = runAlertEngine(db);
    if (r.fired.length) console.log(`  Alert engine: firing ${r.fired.length} (${r.fired.join(', ')})`);
  } catch (err) {
    console.error('  Alert engine failed:', err.message);
  }

  // 9b-2. Close alerts nothing can resolve any more. Runs AFTER every evaluator
  // above, so a live condition has already refreshed its observation stamp this
  // cycle and cannot be reaped. This is the class fix for alerts orphaned by a
  // host identity or metric that stopped reporting (src/alert-reaper.js).
  try {
    const { reapStaleAlerts } = require('./alert-reaper');
    const reaped = reapStaleAlerts(db);
    if (reaped.resolved.length) {
      console.log(`  Alert reaper: auto-closed ${reaped.resolved.length} stale alert(s): ${reaped.resolved.map(r => r.title).join(', ')}`);
    }
  } catch (err) {
    console.error('  Alert reaper failed:', err.message);
  }

  // 9c. Deliver newly fired critical alerts through the existing private
  // Ratatoskr/Telegram path. Delivery state is persisted on each alert row, so
  // repeats are quiet and transport failures retry on later collector cycles.
  try {
    const { sendCriticalAlertNotifications } = require('./notify');
    const result = await sendCriticalAlertNotifications(db);
    if (result.pending > 0) {
      console.log(`  Critical notifications: ${result.sent} sent, ${result.failed} failed`);
    }
  } catch (err) {
    console.error('  Critical notification check failed:', err.message);
  }

  // 10. Sync alert state changes to Munin
  try {
    await syncAlertsToMunin(db);
  } catch (err) {
    console.warn('  Munin alert sync failed:', err.message);
  }

  // 11. Self-heal: check for persistently unhealthy services, submit Hugin tasks
  try {
    await checkAndHeal(db);
  } catch (err) {
    console.warn('  Self-heal check failed:', err.message);
  }

  db.close();
  console.log(`[${new Date().toISOString()}] Collection cycle complete`);
}

run().catch(err => {
  console.error('Collector fatal error:', err);
  process.exit(1);
});
