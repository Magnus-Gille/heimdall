'use strict';

// Keep legacy callers on one authoritative alert transition implementation.
// This matters for notification state: every warning↔critical transition must
// update the same durable outbox fields regardless of which collector raised it.
const {
  createAlert,
  resolveAlert,
  acknowledgeAlert,
  getActiveAlerts,
} = require('./db');
const { loadBackupDefinitions } = require('./backup-config');

function formatMultiplier(multiplier) {
  return Number.isInteger(multiplier) ? String(multiplier) : multiplier.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function checkBackupStaleness(db, backupName, timestamp, backups = loadBackupDefinitions()) {
  if (!timestamp) return;
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageHours = ageMs / 3600000;
  const alertTitle = `Backup stale: ${backupName}`;
  const info = backups[backupName];
  if (!info) throw new Error(`No backup freshness configuration declared for ${JSON.stringify(backupName)}`);
  const warnHours = info.expectedIntervalHours * info.warningAfterIntervals;
  const critHours = info.expectedIntervalHours * info.criticalAfterIntervals;

  const ageMins = Math.floor(ageMs / 60000);
  const ageH = Math.floor(ageMins / 60);
  const ageM = ageMins % 60;
  const ageStr = ageH > 0 ? `${ageH}h ${ageM}m` : `${ageM}m`;

  const cadence = `expected every ${info.expectedIntervalHours}h; warning after ${formatMultiplier(info.warningAfterIntervals)}× expected interval, critical after ${formatMultiplier(info.criticalAfterIntervals)}× expected interval`;

  if (ageHours > critHours) {
    createAlert(db, 'nas', 'backup', 'critical', alertTitle,
      `${info.description} · runs ${info.schedule} · ${cadence} · last seen ${ageStr} ago · threshold: >${critHours}h critical`);
  } else if (ageHours > warnHours) {
    createAlert(db, 'nas', 'backup', 'warning', alertTitle,
      `${info.description} · runs ${info.schedule} · ${cadence} · last seen ${ageStr} ago · threshold: >${warnHours}h warning`);
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
