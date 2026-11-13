'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, getActiveAlerts, getPendingCriticalAlertNotifications } = require('../src/db');
const { EXPECTED_SLOTS } = require('../src/code-health/registry');
const {
  evaluateCodeHealthStalenessAlerts, freshnessCapMs, titleFor, CATEGORY,
} = require('../src/code-health-alerts');

const NOW = Date.parse('2026-10-10T12:00:00Z');
const HOUR = 3600000;

function admitRun(db, repoName, runId, runCreatedAt) {
  db.prepare(`INSERT INTO code_health_objective_runs (repo_owner, repo_name, run_id, attempt, outcome,
    run_created_at, first_handled_at, last_handled_at, expires_at)
    VALUES ('Magnus-Gille', ?, ?, 1, 'admitted', ?, ?, ?, '2027-04-01T00:00:00Z')`)
    .run(repoName, runId, runCreatedAt, runCreatedAt, runCreatedAt);
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const active = (db) => getActiveAlerts(db).filter((alert) => alert.category === CATEGORY);

describe('code-health staleness alerts', () => {
  let db;
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  it('uses the shortest registered freshness cap for each repository', () => {
    for (const [name, expected] of EXPECTED_SLOTS) {
      assert.equal(freshnessCapMs(name), Math.min(...expected.slots.map((slot) => slot.freshness_ms)));
    }
    assert.equal(freshnessCapMs('not-registered'), null);
  });

  it('fires once after the cap, does not duplicate, and clears on the next admission', () => {
    const cap = freshnessCapMs('gille-inference');
    admitRun(db, 'gille-inference', 1, iso(NOW - cap - HOUR));
    admitRun(db, 'sagascript', 2, iso(NOW - HOUR));

    const first = evaluateCodeHealthStalenessAlerts(db, { enabled: true, configured: true, now: NOW });
    assert.deepEqual(first.stale.map((item) => item.repository), ['gille-inference']);
    const second = evaluateCodeHealthStalenessAlerts(db, { enabled: true, configured: true, now: NOW + 5 * 60000 });
    assert.equal(second.stale.length, 1);
    const alerts = active(db);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].title, titleFor('gille-inference'));
    assert.equal(alerts[0].severity, 'warning');
    assert.equal(alerts[0].host, 'control-node');
    assert.match(alerts[0].detail, /newest admitted run was created 2026-10-08T11:00:00Z/);
    assert.equal(getPendingCriticalAlertNotifications(db, new Date(NOW).toISOString(), 10).length, 0);

    admitRun(db, 'gille-inference', 3, iso(NOW - 2 * HOUR));
    const cleared = evaluateCodeHealthStalenessAlerts(db, { enabled: true, configured: true, now: NOW + 10 * 60000 });
    assert.equal(cleared.stale.length, 0);
    assert.equal(active(db).length, 0);
  });

  it('does not alert within the cap or without a known admission', () => {
    const cap = freshnessCapMs('sagascript');
    admitRun(db, 'sagascript', 1, iso(NOW - cap + HOUR));
    const result = evaluateCodeHealthStalenessAlerts(db, { enabled: true, configured: true, now: NOW });
    assert.equal(result.stale.length, 0);
    assert.deepEqual(result.unknown, ['gille-inference']);
    assert.equal(active(db).length, 0);
  });

  it('falls back to the newest stored snapshot collection time when no run row is known', () => {
    const cap = freshnessCapMs('gille-inference');
    db.prepare(`INSERT INTO code_health_objective_snapshots (snapshot_id, repo_owner, repo_name, commit_sha, observed_at,
      collected_at, expires_at, source_run_id, source_attempt, artifact_sha256, payload_sha256, payload_json)
      VALUES ('ref:legacy', 'Magnus-Gille', 'gille-inference', ?, ?, ?, '2027-04-01T00:00:00Z', 5, 1, ?, ?, '{}')`)
      .run('a'.repeat(40), iso(NOW - cap - 2 * HOUR), iso(NOW - cap - HOUR), 'b'.repeat(64), 'c'.repeat(64));
    const result = evaluateCodeHealthStalenessAlerts(db, { enabled: true, configured: true, now: NOW });
    assert.deepEqual(result.stale.map((item) => item.repository), ['gille-inference']);
  });

  it('clears and skips evaluation when the objective source is disabled or unconfigured', () => {
    const cap = freshnessCapMs('gille-inference');
    admitRun(db, 'gille-inference', 1, iso(NOW - cap - HOUR));
    evaluateCodeHealthStalenessAlerts(db, { enabled: true, configured: true, now: NOW });
    assert.equal(active(db).length, 1);
    const off = evaluateCodeHealthStalenessAlerts(db, { enabled: true, configured: false, now: NOW });
    assert.equal(off.stale.length, 0);
    assert.equal(active(db).length, 0);
    evaluateCodeHealthStalenessAlerts(db, { enabled: false, configured: true, now: NOW });
    assert.equal(active(db).length, 0);
  });
});
