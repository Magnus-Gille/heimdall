'use strict';

/**
 * Regression tests for deploy-drift ALERTING.
 *
 * Live defects this pins:
 *   1. six of nine open alerts were driven by `commits_behind = -1`, an
 *      uninterpretable value. Instrumentation failure must not read as drift.
 *   5. munin-memory's deploy path has no .git and its /health has no commit, so
 *      "behind origin/main" is not computable there — it raised drift anyway and
 *      flapped (resolved 18:06, re-fired 18:16).
 *   4. grimnir-validate + grimnir-security-scan are two systemd timers from ONE
 *      repo at ONE commit; they produced two identical alerts. Same for
 *      hugin + hugin-daily-analysis. Drift is a property of a repo checkout on a
 *      host, not of each unit.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase, getActiveAlerts, insertServiceVersion } = require('../src/db');
const { evaluateDriftAlerts, DRIFT_STREAK } = require('../src/drift-alerts');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-drift-alerts-'));
  return openDatabase(path.join(dir, 'test.db'));
}

/** Seed `n` identical history rows so the streak gate is satisfied. */
function seedHistory(db, rows, n = DRIFT_STREAK) {
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.UTC(2026, 6, 25, 10, i)).toISOString();
    for (const r of rows) {
      insertServiceVersion(db, at, r.service, r.host, r.deployed_commit, r.latest_commit, r.commits_behind, r.drift_state);
    }
  }
}

const titles = (db) => getActiveAlerts(db).map((a) => a.title).sort();

describe('evaluateDriftAlerts', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('does NOT alert when the drift state is unknown (uninterpretable instrumentation)', () => {
    const results = [{
      service: 'munin-memory', host: 'control-node', repo: 'Magnus-Gille/munin-memory',
      deployed_commit: 'ok', latest_commit: '2eaa4e5', commits_behind: null, drift_state: 'unknown',
      drift_reason: 'deployed version is not a commit',
    }];
    seedHistory(db, results);
    evaluateDriftAlerts(db, results);
    assert.deepStrictEqual(titles(db), []);
  });

  it('does NOT alert on the legacy -1 sentinel still sitting in history', () => {
    const results = [{
      service: 'ratatoskr', host: 'control-node', repo: 'Magnus-Gille/ratatoskr',
      deployed_commit: '6ff0610', latest_commit: '2a2ce05', commits_behind: -1, drift_state: 'unknown',
    }];
    seedHistory(db, results);
    evaluateDriftAlerts(db, results);
    assert.deepStrictEqual(titles(db), []);
  });

  it('raises ONE alert per repo+host, not one per systemd unit', () => {
    const results = [
      { service: 'grimnir-validate', host: 'control-node', repo: 'Magnus-Gille/grimnir', deployed_commit: 'a201afd', latest_commit: '0526c0d', commits_behind: 2, drift_state: 'drift' },
      { service: 'grimnir-security-scan', host: 'control-node', repo: 'Magnus-Gille/grimnir', deployed_commit: 'a201afd', latest_commit: '0526c0d', commits_behind: 2, drift_state: 'drift' },
    ];
    seedHistory(db, results);
    evaluateDriftAlerts(db, results);
    const active = getActiveAlerts(db);
    assert.strictEqual(active.length, 1, `expected 1 repo-level alert, got ${active.length}: ${active.map((a) => a.title).join(', ')}`);
    assert.match(active[0].title, /grimnir/);
    // the units are still named in the detail so it stays diagnosable
    assert.match(active[0].detail, /grimnir-validate/);
    assert.match(active[0].detail, /grimnir-security-scan/);
  });

  it('reports the real behind-count in the detail, never a negative number', () => {
    const results = [
      { service: 'hugin', host: 'control-node', repo: 'Magnus-Gille/hugin', deployed_commit: '22bcf5d', latest_commit: 'cd4655b', commits_behind: 4, drift_state: 'drift' },
    ];
    seedHistory(db, results);
    evaluateDriftAlerts(db, results);
    const active = getActiveAlerts(db);
    assert.strictEqual(active.length, 1);
    assert.match(active[0].detail, /4 commits behind/);
    assert.doesNotMatch(active[0].detail, /-1/);
  });

  it('resolves the legacy per-unit alert titles when it takes over a repo', () => {
    const { createAlert } = require('../src/db');
    createAlert(db, 'control-node', 'deploy', 'warning', 'Deploy drift: grimnir-validate', 'legacy');
    createAlert(db, 'control-node', 'deploy', 'warning', 'Deploy drift: grimnir-security-scan', 'legacy');
    const results = [
      { service: 'grimnir-validate', host: 'control-node', repo: 'Magnus-Gille/grimnir', deployed_commit: 'a201afd', latest_commit: '0526c0d', commits_behind: 2, drift_state: 'drift' },
      { service: 'grimnir-security-scan', host: 'control-node', repo: 'Magnus-Gille/grimnir', deployed_commit: 'a201afd', latest_commit: '0526c0d', commits_behind: 2, drift_state: 'drift' },
    ];
    seedHistory(db, results);
    evaluateDriftAlerts(db, results);
    const active = getActiveAlerts(db);
    assert.strictEqual(active.length, 1, `legacy per-unit alerts should be resolved; active: ${active.map((a) => a.title).join(', ')}`);
  });

  it('resolves an unknown repo\'s alert instead of leaving it firing', () => {
    const { createAlert } = require('../src/db');
    createAlert(db, 'control-node', 'deploy', 'warning', 'Deploy drift: munin-memory', 'legacy');
    const results = [{
      service: 'munin-memory', host: 'control-node', repo: 'Magnus-Gille/munin-memory',
      deployed_commit: 'ok', latest_commit: '2eaa4e5', commits_behind: null, drift_state: 'unknown',
    }];
    seedHistory(db, results);
    evaluateDriftAlerts(db, results);
    assert.deepStrictEqual(titles(db), []);
  });

  it('requires a sustained streak before it fires', () => {
    const results = [
      { service: 'hugin', host: 'control-node', repo: 'Magnus-Gille/hugin', deployed_commit: '22bcf5d', latest_commit: 'cd4655b', commits_behind: 4, drift_state: 'drift' },
    ];
    seedHistory(db, results, 1); // only one observation
    evaluateDriftAlerts(db, results);
    assert.deepStrictEqual(titles(db), []);
  });

  it('does not alert when the deployment is up to date', () => {
    const results = [
      { service: 'heimdall', host: 'control-node', repo: 'Magnus-Gille/heimdall', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' },
    ];
    seedHistory(db, results);
    evaluateDriftAlerts(db, results);
    assert.deepStrictEqual(titles(db), []);
  });

  it('reports uninterpretable drift as an instrumentation note, not an alert', () => {
    const results = [{
      service: 'munin-memory', host: 'control-node', repo: 'Magnus-Gille/munin-memory',
      deployed_commit: 'ok', latest_commit: '2eaa4e5', commits_behind: null, drift_state: 'unknown',
      drift_reason: 'deployed version is not a commit',
    }];
    seedHistory(db, results);
    const out = evaluateDriftAlerts(db, results);
    assert.ok(Array.isArray(out.unknown));
    assert.strictEqual(out.unknown.length, 1);
    assert.match(out.unknown[0].reason, /not a commit/);
  });
});
