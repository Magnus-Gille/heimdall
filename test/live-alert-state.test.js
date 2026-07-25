'use strict';

/**
 * End-to-end replay of the LIVE alert state observed on 2026-07-25.
 *
 * This is the whole complaint in one test: nine open alerts, of which six were
 * false, two were unresolvable zombies, one was real — and the one genuinely
 * broken thing (a maintenance job exiting 1) had no alert at all.
 *
 * Observed open alerts (id | host | title):
 *   717 | nas         | disk_used_pct_nas % threshold on nas      ← metric retired 2026-07-22
 *   852 | nas         | Backup stale: TM Backup                   ← evidence probe dead since 2026-07-22
 *   871 | huginmunin  | mem_used_pct % threshold on huginmunin    ← host id dead since 2026-07-23
 *   895 | huginmunin  | Deploy drift: ratatoskr                   ← commits_behind = -1
 *   896 | huginmunin  | Deploy drift: hugin                       ← real drift
 *   897 | huginmunin  | Deploy drift: hugin-daily-analysis        ← duplicate of 896 (same repo)
 *   900 | huginmunin  | Deploy drift: grimnir-security-scan       ← real drift, but duplicated
 *   901 | huginmunin  | Deploy drift: grimnir-validate            ← duplicate of 900 (same repo)
 *   903 | huginmunin  | Deploy drift: munin-memory                ← not measurable (no .git, /health has no commit)
 *
 * Silent at the same time:
 *   brokkr-maintenance-os — status "fail", timer.lastResult "exit 1"
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  openDatabase, createAlert, getActiveAlerts, insertServiceVersion,
} = require('../src/db');
const { evaluateDriftAlerts } = require('../src/drift-alerts');
const { evaluateTimerAlerts } = require('../src/timer-alerts');
const { reapStaleAlerts, reconcileAlertHosts } = require('../src/alert-reaper');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-live-replay-'));
  return openDatabase(path.join(dir, 'test.db'));
}

const NOW = Date.parse('2026-07-25T18:40:00Z');

// The live service_versions rows at 2026-07-25T18:35:38.551Z, with the drift
// state the corrected comparison assigns to each.
const LIVE_VERSIONS = [
  { service: 'munin-memory', repo: 'Magnus-Gille/munin-memory', deployed_commit: 'ok', latest_commit: '2eaa4e5', commits_behind: null, drift_state: 'unknown', drift_reason: 'deployed version "ok" is not a commit — drift is not measurable here' },
  { service: 'hugin', repo: 'Magnus-Gille/hugin', deployed_commit: '22bcf5d', latest_commit: 'cd4655b', commits_behind: 4, drift_state: 'drift' },
  { service: 'hugin-daily-analysis', repo: 'Magnus-Gille/hugin', deployed_commit: '22bcf5d', latest_commit: 'cd4655b', commits_behind: 4, drift_state: 'drift' },
  { service: 'heimdall', repo: 'Magnus-Gille/heimdall', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' },
  { service: 'heimdall-collect', repo: 'Magnus-Gille/heimdall', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' },
  { service: 'heimdall-maintain', repo: 'Magnus-Gille/heimdall', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' },
  { service: 'heimdall-boot-check', repo: 'Magnus-Gille/heimdall', deployed_commit: '71e6429', latest_commit: '71e6429', commits_behind: 0, drift_state: 'up-to-date' },
  { service: 'ratatoskr', repo: 'Magnus-Gille/ratatoskr', deployed_commit: '6ff0610', latest_commit: '2a2ce05', commits_behind: 2, drift_state: 'drift' },
  { service: 'skuld', repo: 'Magnus-Gille/skuld', deployed_commit: 'f1ca836', latest_commit: null, commits_behind: null, drift_state: 'unknown', drift_reason: 'origin/main could not be resolved' },
  { service: 'mimir', repo: 'Magnus-Gille/mimir', deployed_commit: null, latest_commit: 'c3500dc', commits_behind: null, drift_state: 'unknown', drift_reason: 'no deployed commit was collected for this service' },
  { service: 'grimnir-security-scan', repo: 'Magnus-Gille/grimnir', deployed_commit: 'a201afd', latest_commit: '0526c0d', commits_behind: 3, drift_state: 'drift' },
  { service: 'grimnir-validate', repo: 'Magnus-Gille/grimnir', deployed_commit: 'a201afd', latest_commit: '0526c0d', commits_behind: 3, drift_state: 'drift' },
  { service: 'brokkr-maintenance-os', repo: 'Magnus-Gille/brokkr', deployed_commit: null, latest_commit: '6a33634', commits_behind: null, drift_state: 'unknown', drift_reason: 'no deployed commit was collected for this service' },
  { service: 'brokkr-maintenance-deps', repo: 'Magnus-Gille/brokkr', deployed_commit: null, latest_commit: '6a33634', commits_behind: null, drift_state: 'unknown', drift_reason: 'no deployed commit was collected for this service' },
  { service: 'tallriksvis', repo: null, deployed_commit: null, latest_commit: null, commits_behind: null, drift_state: 'unknown', drift_reason: 'no deployed commit was collected for this service' },
].map((v) => ({ ...v, host: 'control-node' }));

// The timers, with the outcomes the corrected model assigns.
const LIVE_TIMERS = [
  { service: 'brokkr-maintenance-os', host: 'control-node', type: 'timer', timer_status: { lastRun: '2026-07-25T05:02:28Z', lastResult: 'exit 1', exitOk: false, nextRun: '2026-07-26T05:00:00Z' } },
  { service: 'grimnir-validate', host: 'control-node', type: 'timer', findings_exit_codes: [1], timer_status: { lastRun: '2026-07-25T04:31:00Z', lastResult: 'exit 1', exitOk: false, nextRun: '2026-07-26T04:30:00Z', findings: 2 } },
  { service: 'grimnir-security-scan', host: 'control-node', type: 'timer', timer_status: { lastRun: '2026-07-25T04:00:00Z', lastResult: 'ok', exitOk: true, nextRun: '2026-07-26T04:00:00Z' } },
  { service: 'heimdall-collect', host: 'control-node', type: 'timer', timer_status: { lastRun: '2026-07-25T18:35:00Z', lastResult: 'ok', exitOk: true, nextRun: '2026-07-25T18:40:00Z' } },
];

/** Recreate the nine alerts exactly as they were open on the live instance. */
function seedLiveAlerts(db) {
  const rows = [
    ['nas', 'anomaly', 'warning', 'disk_used_pct_nas % threshold on nas', '80% >= 80%', '2026-07-02T04:10:21.080Z'],
    ['nas', 'backup', 'critical', 'Backup stale: TM Backup', 'last seen 23h 24m ago', '2026-07-21T21:20:35.457Z'],
    ['huginmunin', 'anomaly', 'warning', 'mem_used_pct % threshold on huginmunin', '84.2% >= 80%', '2026-07-23T05:05:34.142Z'],
    ['huginmunin', 'deploy', 'warning', 'Deploy drift: ratatoskr', 'behind for 3+ checks', '2026-07-24T09:51:00.991Z'],
    ['huginmunin', 'deploy', 'warning', 'Deploy drift: hugin', 'behind for 3+ checks', '2026-07-24T15:51:04.022Z'],
    ['huginmunin', 'deploy', 'warning', 'Deploy drift: hugin-daily-analysis', 'behind for 3+ checks', '2026-07-24T15:51:04.022Z'],
    ['huginmunin', 'deploy', 'warning', 'Deploy drift: grimnir-security-scan', 'behind for 3+ checks', '2026-07-25T08:21:09.279Z'],
    ['huginmunin', 'deploy', 'warning', 'Deploy drift: grimnir-validate', 'behind for 3+ checks', '2026-07-25T08:21:09.279Z'],
    ['huginmunin', 'deploy', 'warning', 'Deploy drift: munin-memory', 'behind for 3+ checks', '2026-07-25T18:16:03.827Z'],
  ];
  for (const [host, category, severity, title, detail, createdAt] of rows) {
    const id = createAlert(db, host, category, severity, title, detail);
    db.prepare('UPDATE alerts SET created_at = ?, last_observed_at = ? WHERE id = ?').run(createdAt, createdAt, id);
  }
}

/** One full corrected collector pass over the live inputs. */
function runCycle(db) {
  const at = new Date(NOW).toISOString();
  for (let i = 0; i < 3; i++) {
    for (const v of LIVE_VERSIONS) {
      insertServiceVersion(db, `2026-07-25T18:${20 + i}:00.000Z`, v.service, v.host,
        v.deployed_commit, v.latest_commit, v.commits_behind, v.drift_state, v.drift_reason);
    }
  }
  void at;
  reconcileAlertHosts(db, { huginmunin: 'control-node' }, { now: NOW });
  const drift = evaluateDriftAlerts(db, LIVE_VERSIONS);
  const timers = evaluateTimerAlerts(db, LIVE_TIMERS, { now: NOW });
  const reaped = reapStaleAlerts(db, { now: NOW });
  return { drift, timers, reaped };
}

describe('live alert state replay (2026-07-25)', () => {
  let db;
  beforeEach(() => { db = tmpDb(); seedLiveAlerts(db); });

  it('starts from the nine alerts the owner actually saw', () => {
    assert.strictEqual(getActiveAlerts(db).length, 9);
  });

  it('leaves only true, actionable alerts open after one corrected cycle', () => {
    runCycle(db);
    const titles = getActiveAlerts(db).map((a) => a.title).sort();
    assert.deepStrictEqual(titles, [
      'Deploy drift: grimnir',
      'Deploy drift: hugin',
      'Deploy drift: ratatoskr',
      'Scheduled job failing: brokkr-maintenance-os',
    ]);
  });

  it('closes the two zombie alerts bound to dead evidence', () => {
    const { reaped } = runCycle(db);
    const closed = reaped.resolved.map((r) => r.title).sort();
    assert.ok(closed.includes('mem_used_pct % threshold on huginmunin'));
    assert.ok(closed.includes('disk_used_pct_nas % threshold on nas'));
    assert.ok(closed.includes('Backup stale: TM Backup'));
  });

  it('drops the false drift alert for the service whose drift is not measurable', () => {
    runCycle(db);
    const titles = getActiveAlerts(db).map((a) => a.title);
    assert.ok(!titles.includes('Deploy drift: munin-memory'),
      'munin-memory has no .git in its deploy path — drift there is not a measurement');
  });

  it('collapses the two grimnir units and the two hugin units to one alert each', () => {
    runCycle(db);
    const titles = getActiveAlerts(db).map((a) => a.title);
    assert.ok(!titles.includes('Deploy drift: grimnir-validate'));
    assert.ok(!titles.includes('Deploy drift: grimnir-security-scan'));
    assert.ok(!titles.includes('Deploy drift: hugin-daily-analysis'));
    assert.strictEqual(titles.filter((t) => t.startsWith('Deploy drift: grimnir')).length, 1);
    assert.strictEqual(titles.filter((t) => t.startsWith('Deploy drift: hugin')).length, 1);
  });

  it('finally raises the alert for the maintenance job that could not run', () => {
    runCycle(db);
    const a = getActiveAlerts(db).find((x) => x.title.includes('brokkr-maintenance-os'));
    assert.ok(a, 'the one genuinely broken thing must now be visible');
    assert.match(a.detail, /exit 1/);
  });

  it('does NOT raise a failure alert for the audit that ran and found 2 issues', () => {
    const { timers } = runCycle(db);
    const titles = getActiveAlerts(db).map((a) => a.title);
    assert.ok(!titles.some((t) => t.includes('grimnir-validate') && t.includes('failing')),
      'grimnir-validate ran fine; exit 1 was its findings signal, not a crash');
    assert.deepStrictEqual(timers.findings.map((f) => [f.service, f.count]), [['grimnir-validate', 2]]);
  });

  it('cuts the open-alert count from 9 to 4, and every survivor is real', () => {
    runCycle(db);
    const active = getActiveAlerts(db);
    assert.strictEqual(active.length, 4);
    for (const a of active) {
      assert.doesNotMatch(a.detail || '', /-1/, `alert "${a.title}" still exposes the -1 sentinel`);
    }
  });
});
