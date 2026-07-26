'use strict';

// NAS liveness state machine — persisted to DB for cross-process access
// States: unknown, healthy, unreachable, ssh_broken, degraded
// Stale overlay: >15min amber, >1h red

const STATES = {
  UNKNOWN: 'unknown',
  HEALTHY: 'healthy',
  UNREACHABLE: 'unreachable',
  SSH_BROKEN: 'ssh_broken',
  DEGRADED: 'degraded',
};

function ensureNASStateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nas_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL DEFAULT 'unknown',
      detail TEXT,
      last_success TEXT
    )
  `);
  // Ensure exactly one row
  db.prepare(`INSERT OR IGNORE INTO nas_state (id, state) VALUES (1, 'unknown')`).run();
}

function getState(db) {
  ensureNASStateTable(db);
  const row = db.prepare('SELECT state, detail, last_success FROM nas_state WHERE id = 1').get();
  const stale = getStaleLevel(row?.last_success);
  return {
    state: row?.state || STATES.UNKNOWN,
    detail: row?.detail || null,
    lastSuccess: row?.last_success || null,
    stale,
  };
}

function getStaleLevel(lastSuccess) {
  if (!lastSuccess) return 'red';
  const ageMs = Date.now() - new Date(lastSuccess).getTime();
  if (ageMs > 3600000) return 'red';   // >1h
  if (ageMs > 900000) return 'amber';  // >15m
  return null;
}

function recordState(db, state, detail) {
  ensureNASStateTable(db);
  if (state === STATES.HEALTHY) {
    db.prepare(
      'UPDATE nas_state SET state = ?, detail = ?, last_success = ? WHERE id = 1'
    ).run(state, detail || null, new Date().toISOString());
  } else {
    db.prepare(
      'UPDATE nas_state SET state = ?, detail = ? WHERE id = 1'
    ).run(state, detail || null);
  }
}

module.exports = {
  STATES,
  getState,
  getStaleLevel,
  recordState,
  ensureNASStateTable,
};
