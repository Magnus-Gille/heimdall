'use strict';

/**
 * Causality hint engine — simple correlation rules that identify
 * likely root causes when multiple signals degrade together.
 *
 * Returns { hint: string } or null if no pattern matches.
 * Most specific match wins (rules are ordered by specificity).
 *
 * @param {object} metrics - flat metrics map
 * @param {object} nasState - NAS state object
 * @param {Array} alerts - active alerts
 * @param {object} [extra] - pre-collected data (restart counts, drift info)
 * @param {number} [extra.totalRestarts] - total service restarts in 24h
 * @param {boolean} [extra.hasDrift] - whether any service has version drift
 */
function detectCausalityHint(metrics, nasState, alerts, extra) {
  const m = metrics || {};
  const activeAlerts = alerts || [];
  const { totalRestarts = 0, hasDrift = false } = extra || {};

  // Helper: check if NAS is unreachable
  const nasDown = nasState && (nasState.state === 'unreachable' || nasState.state === 'ssh_broken');

  // Helper: check for stale backups/sync
  const backupAlerts = activeAlerts.filter(a => a.category === 'backup');
  const hasStaleBackups = backupAlerts.length > 0;

  // Rule 1: NAS connectivity → backups and sync
  // Most specific: NAS unreachable explains stale backups
  if (nasDown && hasStaleBackups) {
    return { hint: 'NAS connectivity issue — backups and sync depend on NAS' };
  }

  // Rule 2: Thermal throttling
  // High temp + CPU throttled + high load
  const cpuThrottled = m.cpu_throttled != null && (m.cpu_throttled & 0x4) !== 0;
  const highTemp = m.cpu_temp != null && m.cpu_temp > 70;
  const highLoad = m.load_1m != null && m.load_1m > 2;
  if (highTemp && cpuThrottled && highLoad) {
    return { hint: 'Thermal throttling — CPU reduced to manage temperature' };
  }

  // Rule 3: Memory pressure
  // High memory + swap active + high load
  const highMem = m.mem_used_pct != null && m.mem_used_pct > 85;
  const swapActive = m.swap_used_pct != null && m.swap_used_pct > 10;
  if (highMem && swapActive && highLoad) {
    return { hint: 'Memory pressure — processes swapping' };
  }

  // Rule 4: Disk I/O bottleneck
  // High load + high iowait + slow disk (high disk usage)
  const highIowait = m.iowait_pct != null && m.iowait_pct > 15;
  const highDisk = m.disk_used_pct_sd != null && m.disk_used_pct_sd > 80;
  if (highLoad && highIowait && highDisk) {
    return { hint: 'Disk I/O bottleneck — high iowait with near-full disk' };
  }

  // Rule 5: Deployment instability
  // Multiple service restarts AND version drift — both required
  if (totalRestarts > 3 && hasDrift) {
    return { hint: 'Recent deployment may have introduced instability' };
  }

  // Rule 5b: Service flapping without deploy evidence
  if (totalRestarts > 3) {
    return { hint: 'Service flapping — multiple restarts without deploy activity' };
  }

  // Rule 6: Collector failure → stale metrics
  const collectorFailed = m.collector_success != null && m.collector_success === 0;
  if (collectorFailed) {
    return { hint: 'Collector not running — metrics may be stale' };
  }

  return null;
}

module.exports = { detectCausalityHint };
