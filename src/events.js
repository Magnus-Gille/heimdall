'use strict';

const { execSync } = require('child_process');
const { createAlert, resolveAlert } = require('./db');

function logEvent(db, host, category, severity, title, detail, source) {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO events (timestamp, host, category, severity, title, detail, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(timestamp, host, category, severity, title, detail || null, source || 'collector');
}

function detectSSHLogins(since) {
  try {
    // since can be an ISO timestamp or relative string like "5 minutes ago"
    const sinceArg = String(since).replace(/[^a-zA-Z0-9T:\-+. ]/g, '');
    const output = execSync(
      `journalctl --output=json -u ssh.service --since "${sinceArg}" --no-pager 2>/dev/null || true`,
      { encoding: 'utf8', timeout: 5000 }
    );
    if (!output.trim()) return [];

    const events = [];
    for (const line of output.trim().split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.MESSAGE && /Accepted|session opened/.test(entry.MESSAGE)) {
          events.push({
            category: 'security',
            severity: 'info',
            title: 'SSH login detected',
            detail: entry.MESSAGE.slice(0, 500),
          });
        }
      } catch { /* skip malformed lines */ }
    }
    return events;
  } catch {
    return [];
  }
}

function detectServiceRestarts(since) {
  const units = [
    'heimdall.service',
    'hugin.service',
    'munin-memory.service',
    'cloudflared.service',
    'smbd.service',
    'avahi-daemon.service',
  ];
  try {
    const sinceArg = String(since).replace(/[^a-zA-Z0-9T:\-+. ]/g, '');
    const unitArgs = units.map(u => `-u ${u}`).join(' ');
    const output = execSync(
      `journalctl --output=json ${unitArgs} --since "${sinceArg}" --no-pager 2>/dev/null || true`,
      { encoding: 'utf8', timeout: 5000 }
    );
    if (!output.trim()) return [];

    const events = [];
    for (const line of output.trim().split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.MESSAGE && /Started|Stopped|Failed/.test(entry.MESSAGE)) {
          const severity = /Failed/.test(entry.MESSAGE) ? 'error' : 'info';
          events.push({
            category: 'system',
            severity,
            title: `Service event: ${(entry.UNIT || entry._SYSTEMD_UNIT || 'unknown').slice(0, 100)}`,
            detail: entry.MESSAGE.slice(0, 500),
          });
        }
      } catch { /* skip malformed lines */ }
    }
    return events;
  } catch {
    return [];
  }
}

// Anomaly thresholds
const THRESHOLDS = {
  cpu_temp: { warning: 65, critical: 75, unit: '°C' },
  mem_used_pct: { warning: 80, critical: 90, unit: '%' },
  disk_used_pct_sd: { warning: 80, critical: 90, unit: '%' },
  disk_used_pct_nas: { warning: 80, critical: 90, unit: '%' },
  load_1m: { warning: 2.0, critical: 4.0, unit: '' },
};

function checkThresholds(db, host, metrics) {
  for (const [metric, thresholds] of Object.entries(THRESHOLDS)) {
    const value = metrics[metric];
    const alertTitle = `${metric} ${thresholds.unit} threshold on ${host}`;

    if (value == null) {
      // The metric is no longer in this host's payload. `continue` left the
      // resolve branch unreachable, which is how "disk_used_pct_nas % threshold
      // on nas" stayed open from 2026-07-02 after the NAS probe stopped
      // delivering that series on 2026-07-22. We cannot assert a breach we can
      // no longer measure, so clear it.
      resolveAlert(db, host, alertTitle);
      continue;
    }

    if (value >= thresholds.critical) {
      logEvent(db, host, 'anomaly', 'critical',
        `${metric} critical: ${value}${thresholds.unit}`,
        `Value ${value} exceeds critical threshold ${thresholds.critical}`, 'collector');
      createAlert(
        db,
        host,
        'anomaly',
        'critical',
        alertTitle,
        `${value}${thresholds.unit} >= ${thresholds.critical}${thresholds.unit}`,
      );
    } else if (value >= thresholds.warning) {
      logEvent(db, host, 'anomaly', 'warning',
        `${metric} warning: ${value}${thresholds.unit}`,
        `Value ${value} exceeds warning threshold ${thresholds.warning}`, 'collector');
      createAlert(
        db,
        host,
        'anomaly',
        'warning',
        alertTitle,
        `${value}${thresholds.unit} >= ${thresholds.warning}${thresholds.unit}`,
      );
    } else {
      resolveAlert(db, host, alertTitle);
    }
  }
}

function checkTempRateOfChange(db, host, currentTemp) {
  if (currentTemp == null) return;
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60000).toISOString();
  const prev = db.prepare(`
    SELECT value FROM metrics
    WHERE host = ? AND metric = 'cpu_temp' AND timestamp >= ?
    ORDER BY timestamp ASC LIMIT 1
  `).get(host, fifteenMinsAgo);

  if (prev && prev.value != null) {
    const delta = currentTemp - prev.value;
    if (delta > 10) {
      logEvent(db, host, 'anomaly', 'warning',
        `Rapid temp increase: +${delta.toFixed(1)}°C in 15min`,
        `From ${prev.value}°C to ${currentTemp}°C — possible cooling failure`,
        'collector');
    }
  }
}

function detectReboot(db, host, currentUptime, previousUptime) {
  if (previousUptime != null && currentUptime != null && currentUptime < previousUptime) {
    logEvent(db, host, 'system', 'warning',
      `${host} rebooted`,
      `Uptime dropped from ${previousUptime}s to ${currentUptime}s`,
      'collector');
  }
}

module.exports = {
  logEvent,
  detectSSHLogins,
  detectServiceRestarts,
  checkThresholds,
  checkTempRateOfChange,
  detectReboot,
  THRESHOLDS,
};
