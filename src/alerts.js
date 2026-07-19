'use strict';

function createAlert(db, host, category, severity, title, detail) {
  const existing = db.prepare(
    'SELECT id FROM alerts WHERE host = ? AND title = ? AND resolved_at IS NULL'
  ).get(host, title);
  if (existing) {
    db.prepare('UPDATE alerts SET detail = ?, severity = ? WHERE id = ?')
      .run(detail || null, severity, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO alerts (created_at, host, category, severity, title, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), host, category, severity, title, detail || null);
  return result.lastInsertRowid;
}

function resolveAlert(db, host, title) {
  db.prepare(
    'UPDATE alerts SET resolved_at = ? WHERE host = ? AND title = ? AND resolved_at IS NULL'
  ).run(new Date().toISOString(), host, title);
}

function acknowledgeAlert(db, alertId) {
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(alertId);
}

function getActiveAlerts(db) {
  return db.prepare(
    'SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC'
  ).all();
}

const backupInfo = {
  'TM Backup': { desc: 'macOS Time Machine → NAS USB drive', schedule: 'automatic (macOS)', warnHours: 2, critHours: 6 },
  // Relocated to the external HDD on a daily GFS schedule (2026-04-27). A 6h
  // threshold against a once-a-day backup would be critical ~18h of every day,
  // so tolerate a full day plus slack: warn after ~26h, critical after ~30h.
  'Munin DB': { desc: 'Munin SQLite → NAS (external HDD)', schedule: 'daily 03:00 (systemd timer)', warnHours: 26, critHours: 30 },
  'Mímir Backup': { desc: 'NAS SD → NAS USB drive', schedule: 'hourly (cron)', warnHours: 2, critHours: 6 },
  'Mímir Sync': { desc: 'Workstation artifacts → storage node', schedule: 'every 30 min', warnHours: 2, critHours: 6 },
};

function checkBackupStaleness(db, backupName, timestamp) {
  if (!timestamp) return;
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageHours = ageMs / 3600000;
  const alertTitle = `Backup stale: ${backupName}`;
  const info = backupInfo[backupName];
  const warnHours = info ? info.warnHours : 2;
  const critHours = info ? info.critHours : 6;

  const ageMins = Math.floor(ageMs / 60000);
  const ageH = Math.floor(ageMins / 60);
  const ageM = ageMins % 60;
  const ageStr = ageH > 0 ? `${ageH}h ${ageM}m` : `${ageM}m`;

  const schedule = info ? info.schedule : 'unknown';
  const desc = info ? info.desc : backupName;

  if (ageHours > critHours) {
    createAlert(db, 'nas', 'backup', 'critical', alertTitle,
      `${desc} · runs ${schedule} · last seen ${ageStr} ago · threshold: >${critHours}h critical`);
  } else if (ageHours > warnHours) {
    createAlert(db, 'nas', 'backup', 'warning', alertTitle,
      `${desc} · runs ${schedule} · last seen ${ageStr} ago · threshold: >${warnHours}h warning`);
  } else {
    resolveAlert(db, 'nas', alertTitle);
  }
}

module.exports = {
  createAlert,
  resolveAlert,
  acknowledgeAlert,
  getActiveAlerts,
  checkBackupStaleness,
};
