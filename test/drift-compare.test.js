'use strict';

/**
 * Regression tests for the deploy-drift comparison.
 *
 * The live instance recorded `commits_behind = -1` for grimnir-validate,
 * grimnir-security-scan, ratatoskr, hugin and munin-memory, and drove six
 * "Deploy drift" warnings from it. A negative behind-count is not a measurement;
 * it was the old sentinel for "the two values differ, count unknown" — and it
 * was written even when the two values were not comparable at all (munin-memory
 * reports the literal string `ok`, because its /health has no commit and its
 * deploy path has no .git).
 *
 * The contract these tests pin:
 *   - `commits_behind` is either null (nothing counted) or a NON-NEGATIVE count.
 *   - an explicit `state` says whether the comparison means anything:
 *       'up-to-date' | 'drift' | 'ahead' | 'unknown'
 *   - anything that cannot be interpreted is `unknown` with a reason, never `drift`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compareCommits } = require('../src/drift-compare');

describe('compareCommits', () => {
  it('reports up-to-date when the deployed commit matches origin/main', () => {
    const r = compareCommits('71e6429', '71e6429');
    assert.strictEqual(r.state, 'up-to-date');
    assert.strictEqual(r.commitsBehind, 0);
  });

  it('accepts a short/long hash prefix match as up-to-date', () => {
    const r = compareCommits('71e6429', '71e6429abcdef0123456789abcdef0123456789');
    assert.strictEqual(r.state, 'up-to-date');
    assert.strictEqual(r.commitsBehind, 0);
  });

  it('never emits a negative commits_behind for two differing SHAs', () => {
    const r = compareCommits('22bcf5d', 'cd4655b');
    assert.strictEqual(r.state, 'drift');
    assert.ok(r.commitsBehind === null || r.commitsBehind >= 0,
      `commits_behind must be null or >= 0, got ${r.commitsBehind}`);
  });

  it('reports drift with a real count when the ancestry probe supplies one', () => {
    const r = compareCommits('22bcf5d', 'cd4655b', { count: () => ({ behind: 4, ahead: 0 }) });
    assert.strictEqual(r.state, 'drift');
    assert.strictEqual(r.commitsBehind, 4);
  });

  it('does not call a deployed revision that is AHEAD of origin/main "behind"', () => {
    const r = compareCommits('22bcf5d', 'cd4655b', { count: () => ({ behind: 0, ahead: 3 }) });
    assert.strictEqual(r.state, 'ahead');
    assert.strictEqual(r.commitsBehind, 0);
  });

  it('is unknown when the deployed "version" is not a commit at all (munin-memory: "ok")', () => {
    const r = compareCommits('ok', '2eaa4e5');
    assert.strictEqual(r.state, 'unknown');
    assert.strictEqual(r.commitsBehind, null);
    assert.match(r.reason, /commit/i);
  });

  it('is unknown when no deployed commit was collected (brokkr-maintenance-os, mimir)', () => {
    for (const deployed of [null, '', undefined]) {
      const r = compareCommits(deployed, '6a33634');
      assert.strictEqual(r.state, 'unknown', `deployed=${JSON.stringify(deployed)}`);
      assert.strictEqual(r.commitsBehind, null);
    }
  });

  it('is unknown when origin/main could not be resolved (skuld)', () => {
    const r = compareCommits('f1ca836', null);
    assert.strictEqual(r.state, 'unknown');
    assert.strictEqual(r.commitsBehind, null);
  });

  it('is unknown when neither side is known (tallriksvis)', () => {
    const r = compareCommits(null, null);
    assert.strictEqual(r.state, 'unknown');
    assert.strictEqual(r.commitsBehind, null);
  });

  it('always supplies a human reason for an unknown', () => {
    for (const args of [['ok', 'abc1234'], [null, 'abc1234'], ['abc1234', null], [null, null]]) {
      const r = compareCommits(...args);
      assert.strictEqual(r.state, 'unknown');
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `missing reason for ${JSON.stringify(args)}`);
    }
  });

  it('falls back to "differs, count unknown" when the counting probe throws', () => {
    const r = compareCommits('22bcf5d', 'cd4655b', { count: () => { throw new Error('no .git'); } });
    assert.strictEqual(r.state, 'drift');
    assert.strictEqual(r.commitsBehind, null);
  });

  it('is unknown when the probe reports the revisions are unrelated', () => {
    const r = compareCommits('22bcf5d', 'cd4655b', { count: () => null });
    assert.strictEqual(r.state, 'drift');
    assert.strictEqual(r.commitsBehind, null);
  });
});

describe('driftStateFromRow (persisted row → render/alert state)', () => {
  const { driftStateFromRow } = require('../src/drift-compare');

  it('reads the persisted drift_state when present', () => {
    assert.strictEqual(driftStateFromRow({ drift_state: 'unknown', commits_behind: null }), 'unknown');
    assert.strictEqual(driftStateFromRow({ drift_state: 'drift', commits_behind: 3 }), 'drift');
  });

  it('never resurrects the legacy -1 sentinel as drift', () => {
    // Rows written before this fix still carry -1. They are NOT evidence of drift.
    assert.strictEqual(driftStateFromRow({ commits_behind: -1 }), 'unknown');
  });

  it('derives from the commit pair when no state was persisted', () => {
    assert.strictEqual(driftStateFromRow({ deployed_commit: 'abc1234', latest_commit: 'abc1234' }), 'up-to-date');
    assert.strictEqual(driftStateFromRow({ deployed_commit: 'abc1234', latest_commit: 'def5678' }), 'drift');
    assert.strictEqual(driftStateFromRow({ deployed_commit: 'ok', latest_commit: 'def5678' }), 'unknown');
    assert.strictEqual(driftStateFromRow({ deployed_commit: null, latest_commit: null }), 'unknown');
  });
});
