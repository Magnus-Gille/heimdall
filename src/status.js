'use strict';

const { getActiveAlerts, getLatestMetrics, getLastCollectionTime } = require('./db');
const { getState } = require('./nas-state');
const { readHuginTasks } = require('./hugin');

/**
 * Compute overall system status: healthy, degraded, or attention.
 * Returns { state: 'healthy'|'degraded'|'attention', reasons: string[] }
 */
function computeOverallStatus(db) {
  const reasons = [];
  let hasCritical = false;
  let hasWarning = false;

  // 1. Check active alerts. Overall status reflects ALL active alerts, including
  // acknowledged ones: dismissing is "I've seen it" (it clears the Alerts tab + nav
  // badge), NOT "it's fine" — the overall-status banner stays a true-health signal.
  const alerts = getActiveAlerts(db);
  const criticalAlerts = alerts.filter(a => a.severity === 'critical');
  const warningAlerts = alerts.filter(a => a.severity === 'warning');
  if (criticalAlerts.length > 0) {
    hasCritical = true;
    reasons.push(`${criticalAlerts.length} critical alert${criticalAlerts.length > 1 ? 's' : ''} active`);
  }
  if (warningAlerts.length > 0) {
    hasWarning = true;
    if (reasons.length < 3) reasons.push(`${warningAlerts.length} warning alert${warningAlerts.length > 1 ? 's' : ''}`);
  }

  // 2. Check host freshness
  const now = Date.now();
  for (const host of ['control-node', 'nas']) {
    const lastCollection = getLastCollectionTime(db, host);
    if (!lastCollection) {
      hasWarning = true;
      if (reasons.length < 3) reasons.push(`${host}: no data collected`);
      continue;
    }
    const ageMin = (now - new Date(lastCollection).getTime()) / 60000;
    if (ageMin > 15) {
      hasCritical = true;
      if (reasons.length < 3) reasons.push(`${host}: no data for ${Math.round(ageMin)}min`);
    }
  }

  // 3. Check NAS state
  const nasState = getState(db);
  if (nasState.state === 'unknown' || nasState.state === 'unreachable' || nasState.state === 'ssh_broken') {
    hasCritical = true;
    if (reasons.length < 3) reasons.push(`NAS ${nasState.state}`);
  } else if (nasState.state === 'degraded') {
    hasWarning = true;
    if (reasons.length < 3) reasons.push('NAS degraded');
  }

  // 4. Check collector health
  const huginMetrics = getLatestMetrics(db, 'control-node');
  const metricsMap = {};
  for (const r of huginMetrics) metricsMap[r.metric] = r;

  if (metricsMap.collector_success && metricsMap.collector_success.value === 0) {
    hasWarning = true;
    if (reasons.length < 3) reasons.push('Last collector run failed');
  }

  const lastRun = metricsMap.collector_last_run;
  if (lastRun) {
    const runAgeMin = (now - lastRun.value * 1000) / 60000;
    if (runAgeMin > 12) {
      hasWarning = true;
      if (reasons.length < 3) reasons.push(`Collector not run for ${Math.round(runAgeMin)}min`);
    }
  }

  // 4b. Check MCP transport health
  if (metricsMap.mcp_healthy && metricsMap.mcp_healthy.value === 0) {
    hasWarning = true;
    if (reasons.length < 3) reasons.push('MCP transport unhealthy');
  }

  // 5. Check for stuck tasks
  try {
    const tasks = readHuginTasks();
    const running = tasks.filter(t => t.status === 'running' || t.status === 'claimed');
    for (const t of running) {
      if (t.updated_at) {
        const taskAgeMin = (now - new Date(t.updated_at).getTime()) / 60000;
        if (taskAgeMin > 60) {
          hasWarning = true;
          if (reasons.length < 3) reasons.push('Stuck task detected');
          break;
        }
      }
    }
  } catch { /* task check is best-effort */ }

  // 6. Check network quality
  if (metricsMap.net_latency_nas_ms && metricsMap.net_latency_nas_ms.value > 200) {
    hasCritical = true;
    if (reasons.length < 3) reasons.push('NAS latency critical (>200ms)');
  } else if (metricsMap.net_latency_nas_ms && metricsMap.net_latency_nas_ms.value > 50) {
    hasWarning = true;
    if (reasons.length < 3) reasons.push('NAS latency elevated (>50ms)');
  }
  if (metricsMap.net_loss_nas_pct && metricsMap.net_loss_nas_pct.value > 20) {
    hasCritical = true;
    if (reasons.length < 3) reasons.push('NAS packet loss critical (>20%)');
  } else if (metricsMap.net_loss_nas_pct && metricsMap.net_loss_nas_pct.value > 5) {
    hasWarning = true;
    if (reasons.length < 3) reasons.push('NAS packet loss elevated (>5%)');
  }
  if (metricsMap.net_loss_internet_pct && metricsMap.net_loss_internet_pct.value > 20) {
    hasCritical = true;
    if (reasons.length < 3) reasons.push('Internet packet loss critical');
  } else if (metricsMap.net_loss_internet_pct && metricsMap.net_loss_internet_pct.value > 5) {
    hasWarning = true;
    if (reasons.length < 3) reasons.push('Internet packet loss elevated');
  }

  // 7. Check service restart counts (from cached metrics, not journalctl)
  try {
    const { loadServiceRegistry } = require('./drift');
    const registry = loadServiceRegistry();
    for (const svc of registry) {
      const metricName = `service_restarts_24h_${svc.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      const row = db.prepare('SELECT value FROM metrics WHERE host = ? AND metric = ? ORDER BY timestamp DESC LIMIT 1')
        .get('control-node', metricName);
      if (row && row.value > 3) {
        hasWarning = true;
        if (reasons.length < 3) reasons.push(`${svc.name}: ${row.value} restarts in 24h`);
      }
    }
  } catch { /* restart check is best-effort */ }

  // 8. Check backup alerts specifically
  const backupAlerts = alerts.filter(a => a.category === 'backup');
  if (backupAlerts.length > 0 && !reasons.some(r => r.includes('alert'))) {
    hasWarning = true;
    if (reasons.length < 3) reasons.push(`${backupAlerts.length} stale backup${backupAlerts.length > 1 ? 's' : ''}`);
  }

  // Determine state
  let state;
  if (hasCritical) {
    state = 'degraded';
  } else if (hasWarning) {
    state = 'attention';
  } else {
    state = 'healthy';
    if (reasons.length === 0) reasons.push('All systems operational');
  }

  return { state, reasons };
}

module.exports = { computeOverallStatus };
