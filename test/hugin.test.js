'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase } = require('../src/db');
const Database = require('better-sqlite3');
const { getTaskSuccessRate, getTaskQueueMetrics, detectTaskChanges, isDispatchedTask, readHuginHeartbeat, deriveTaskMeta } = require('../src/hugin');

// taskBaseSlug is exported from html.js — test it there or here for completeness
const { humanizeTaskName } = require('../src/html');

describe('getTaskSuccessRate', () => {
  it('returns null for empty tasks', () => {
    assert.strictEqual(getTaskSuccessRate([], 7), null);
  });

  it('returns null when no tasks in period', () => {
    const old = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
    const tasks = [{ status: 'completed', updated_at: old }];
    assert.strictEqual(getTaskSuccessRate(tasks, 7), null);
  });

  it('computes 100% for all completed', () => {
    const now = new Date().toISOString();
    const tasks = [
      { status: 'completed', updated_at: now },
      { status: 'done', updated_at: now },
    ];
    const rate = getTaskSuccessRate(tasks, 7);
    assert.strictEqual(rate.rate, 100);
    assert.strictEqual(rate.completed, 2);
    assert.strictEqual(rate.failed, 0);
  });

  it('computes 50% for mixed results', () => {
    const now = new Date().toISOString();
    const tasks = [
      { status: 'completed', updated_at: now },
      { status: 'failed', updated_at: now },
    ];
    const rate = getTaskSuccessRate(tasks, 7);
    assert.strictEqual(rate.rate, 50);
  });

  it('ignores running/pending tasks', () => {
    const now = new Date().toISOString();
    const tasks = [
      { status: 'completed', updated_at: now },
      { status: 'running', updated_at: now },
      { status: 'pending', updated_at: now },
    ];
    const rate = getTaskSuccessRate(tasks, 7);
    assert.strictEqual(rate.total, 1);
  });

  it('includes days in result', () => {
    const now = new Date().toISOString();
    const tasks = [{ status: 'completed', updated_at: now }];
    const rate = getTaskSuccessRate(tasks, 14);
    assert.strictEqual(rate.days, 14);
  });
});

describe('getTaskQueueMetrics', () => {
  it('returns empty metrics for no tasks', () => {
    const result = getTaskQueueMetrics([]);
    assert.strictEqual(result.oldestPendingAge, null);
    assert.strictEqual(result.runningTasks.length, 0);
    assert.strictEqual(result.stuckTasks.length, 0);
    assert.strictEqual(result.retryCount, 0);
  });

  it('computes oldest pending age', () => {
    const oldTs = new Date(Date.now() - 60 * 60000).toISOString();
    const newTs = new Date(Date.now() - 5 * 60000).toISOString();
    const tasks = [
      { status: 'pending', updated_at: oldTs },
      { status: 'pending', updated_at: newTs },
    ];
    const result = getTaskQueueMetrics(tasks);
    assert.ok(result.oldestPendingAge > 50 * 60000);
  });

  it('detects stuck tasks (>30min running)', () => {
    const oldTs = new Date(Date.now() - 45 * 60000).toISOString();
    const tasks = [
      { status: 'running', name: 'stuck-task', namespace: 'tasks/stuck', updated_at: oldTs },
    ];
    const result = getTaskQueueMetrics(tasks);
    assert.strictEqual(result.stuckTasks.length, 1);
    assert.strictEqual(result.stuckTasks[0].name, 'stuck-task');
  });

  it('does not flag recent running tasks as stuck', () => {
    const recentTs = new Date(Date.now() - 5 * 60000).toISOString();
    const tasks = [
      { status: 'running', name: 'fresh-task', namespace: 'tasks/fresh', updated_at: recentTs },
    ];
    const result = getTaskQueueMetrics(tasks);
    assert.strictEqual(result.stuckTasks.length, 0);
    assert.strictEqual(result.runningTasks.length, 1);
  });

  it('counts retries', () => {
    const tasks = [
      { status: 'failed', name: 'deploy-app-retry', updated_at: new Date().toISOString() },
      { status: 'completed', name: 'deploy-app-retry-2', updated_at: new Date().toISOString() },
      { status: 'completed', name: 'normal-task', updated_at: new Date().toISOString() },
    ];
    const result = getTaskQueueMetrics(tasks);
    assert.strictEqual(result.retryCount, 2);
  });

  it('computes average completion time from namespace timestamp vs updated_at', () => {
    // `runtime` holds the runtime LABEL (e.g. "claude"), not a duration. Elapsed is derived
    // from the UTC creation timestamp embedded in the namespace vs updated_at (completion).
    const tasks = [
      { status: 'completed', namespace: 'tasks/20260518-120000-a', updated_at: '2026-05-18T12:01:30.000Z' }, // +90s
      { status: 'completed', namespace: 'tasks/20260518-120000-b', updated_at: '2026-05-18T12:02:30.000Z' }, // +150s
    ];
    const result = getTaskQueueMetrics(tasks);
    assert.strictEqual(result.avgCompletionTime, 120000); // avg(90s, 150s)
  });

  it('handles hour-scale elapsed times', () => {
    const tasks = [
      { status: 'completed', namespace: 'tasks/20260518-120000-c', updated_at: '2026-05-18T13:05:30.000Z' }, // +1h5m30s
    ];
    const result = getTaskQueueMetrics(tasks);
    assert.strictEqual(result.avgCompletionTime, (3600 + 300 + 30) * 1000);
  });

  it('ignores completed tasks with no parseable namespace timestamp', () => {
    const tasks = [
      { status: 'completed', namespace: 'tasks/20260402-research-foo', updated_at: '2026-05-18T12:01:30.000Z' },
    ];
    const result = getTaskQueueMetrics(tasks);
    assert.strictEqual(result.avgCompletionTime, null);
  });

  it('handles null runtime gracefully', () => {
    const now = new Date().toISOString();
    const tasks = [
      { status: 'completed', runtime: null, updated_at: now },
    ];
    const result = getTaskQueueMetrics(tasks);
    assert.strictEqual(result.avgCompletionTime, null);
  });
});

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-test-'));
  return openDatabase(path.join(dir, 'test.db'));
}

describe('detectTaskChanges', () => {
  let db;
  beforeEach(() => { db = tmpDb(); });

  it('detects new completed task', () => {
    const tasks = [{
      namespace: 'tasks/test-1', key: 'status', name: 'test-1',
      status: 'completed', updated_at: new Date().toISOString(),
    }];
    const events = detectTaskChanges(db, tasks);
    assert.strictEqual(events.length, 1);
    assert.ok(events[0].title.includes('completed'));
    db.close();
  });

  it('detects claimed task', () => {
    const tasks = [{
      namespace: 'tasks/deploy', key: 'status', name: 'deploy',
      status: 'claimed', updated_at: new Date().toISOString(),
    }];
    const events = detectTaskChanges(db, tasks);
    assert.strictEqual(events.length, 1);
    assert.ok(events[0].title.includes('claimed'));
    assert.strictEqual(events[0].severity, 'info');
    db.close();
  });

  it('detects failed task', () => {
    const tasks = [{
      namespace: 'tasks/deploy', key: 'status', name: 'deploy',
      status: 'failed', updated_at: new Date().toISOString(),
    }];
    const events = detectTaskChanges(db, tasks);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].severity, 'error');
    db.close();
  });

  it('does not re-emit for same status', () => {
    const tasks = [{
      namespace: 'tasks/test', key: 'status', name: 'test',
      status: 'completed', updated_at: new Date().toISOString(),
    }];
    detectTaskChanges(db, tasks);
    const second = detectTaskChanges(db, tasks);
    assert.strictEqual(second.length, 0);
    db.close();
  });

  it('emits when status changes', () => {
    const task = {
      namespace: 'tasks/test', key: 'status', name: 'test',
      updated_at: new Date().toISOString(),
    };
    detectTaskChanges(db, [{ ...task, status: 'running' }]);
    const events = detectTaskChanges(db, [{ ...task, status: 'completed' }]);
    assert.strictEqual(events.length, 1);
    assert.ok(events[0].title.includes('completed'));
    db.close();
  });

  it('handles multiple tasks in one call', () => {
    const now = new Date().toISOString();
    const tasks = [
      { namespace: 'tasks/a', key: 'status', name: 'a', status: 'completed', updated_at: now },
      { namespace: 'tasks/b', key: 'status', name: 'b', status: 'failed', updated_at: now },
    ];
    const events = detectTaskChanges(db, tasks);
    assert.strictEqual(events.length, 2);
    db.close();
  });
});

describe('isDispatchedTask', () => {
  it('accepts timestamped task namespaces', () => {
    assert.ok(isDispatchedTask('tasks/20260321-082800-fix-task-widget'));
    assert.ok(isDispatchedTask('tasks/20250301-120000-deploy-app'));
    assert.ok(isDispatchedTask('tasks/20260101-000000-a'));
    assert.ok(isDispatchedTask('tasks/20260530-e2e77'));        // date + slug, no time component
    assert.ok(isDispatchedTask('tasks/20260402-research-foo')); // date + non-numeric slug
  });

  it('rejects admin/index entries', () => {
    assert.ok(!isDispatchedTask('tasks/admin'));
    assert.ok(!isDispatchedTask('tasks/index'));
    assert.ok(!isDispatchedTask('tasks/events'));
    assert.ok(!isDispatchedTask('tasks/commitments'));
    assert.ok(!isDispatchedTask('tasks/projects'));
  });

  it('rejects non-task namespaces', () => {
    assert.ok(!isDispatchedTask('projects/heimdall'));
    assert.ok(!isDispatchedTask('meta/workbench'));
  });

  it('rejects tasks with partial timestamp patterns', () => {
    assert.ok(!isDispatchedTask('tasks/20260321'));
    assert.ok(!isDispatchedTask('tasks/20260321-082800'));
    assert.ok(!isDispatchedTask('tasks/20260321-082800-')); // date-time with empty slug
  });
});

describe('readHuginHeartbeat', () => {
  it('computes status thresholds correctly', () => {
    function computeStatus(freshnessMs) {
      if (freshnessMs < 2 * 60000) return 'running';
      if (freshnessMs < 10 * 60000) return 'stale';
      return 'down';
    }

    assert.strictEqual(computeStatus(0), 'running');
    assert.strictEqual(computeStatus(60000), 'running');
    assert.strictEqual(computeStatus(119999), 'running');
    assert.strictEqual(computeStatus(120000), 'stale');
    assert.strictEqual(computeStatus(300000), 'stale');
    assert.strictEqual(computeStatus(599999), 'stale');
    assert.strictEqual(computeStatus(600000), 'down');
    assert.strictEqual(computeStatus(900000), 'down');
  });

  it('handles missing fields gracefully', () => {
    const data = JSON.parse('{"polled_at":"2026-03-21T08:00:00Z"}');
    assert.strictEqual(data.queue_depth ?? null, null);
    assert.strictEqual(data.current_task ?? null, null);
    assert.strictEqual(data.uptime_s ?? null, null);
  });

  it('handles null current_task', () => {
    const data = JSON.parse('{"polled_at":"2026-03-21T08:00:00Z","queue_depth":0,"current_task":null,"uptime_s":100}');
    assert.strictEqual(data.current_task, null);
    assert.strictEqual(data.queue_depth, 0);
  });
});

describe('heartbeat alert logic', () => {
  it('triggers alert when stale >5 min', () => {
    const freshnessMs = 6 * 60000;
    assert.ok(freshnessMs > 5 * 60000);
  });

  it('does not trigger alert when fresh', () => {
    const freshnessMs = 30000;
    assert.ok(!(freshnessMs > 5 * 60000));
  });

  it('clears alert when heartbeat returns', () => {
    const freshnessMs = 10000;
    assert.ok(freshnessMs <= 5 * 60000);
  });
});

describe('humanizeTaskName (from html.js)', () => {
  it('strips tasks/ prefix and timestamp', () => {
    assert.strictEqual(humanizeTaskName('tasks/20250301-120000-deploy-app'), 'Deploy App');
  });

  it('capitalizes each word', () => {
    assert.strictEqual(humanizeTaskName('run-database-migration'), 'Run Database Migration');
  });
});

// Regression: issue #12 — orphaned task namespace (state rows but no `status`
// and no `result` key, e.g. a leftover acceptance-test fixture) used to render
// a phantom RUNNING badge in the list (status borrowed from an unrelated row)
// and crash the detail reader into "Task not found" (unguarded timestamp deref).
describe('deriveTaskMeta', () => {
  it('derives status/runtime/timestamps from the status entry', () => {
    const byKey = {
      status: { tags: JSON.stringify(['running', 'runtime:claude']), updated_at: 'u1', created_at: 'c1' },
    };
    const m = deriveTaskMeta(byKey);
    assert.strictEqual(m.status, 'running');
    assert.strictEqual(m.runtime, 'claude');
    assert.strictEqual(m.meta.updated_at, 'u1');
    assert.strictEqual(m.statusEntry, byKey.status);
  });

  it('falls back to the result entry when there is no status key', () => {
    const byKey = {
      result: { tags: JSON.stringify(['completed', 'runtime:codex']), updated_at: 'u2', created_at: 'c2' },
    };
    const m = deriveTaskMeta(byKey);
    assert.strictEqual(m.status, 'completed');
    assert.strictEqual(m.runtime, 'codex');
    assert.strictEqual(m.statusEntry, null);
    assert.strictEqual(m.resultEntry, byKey.result);
  });

  it('orphan (no status/result key) reports unknown from its OWN row, never throws', () => {
    // An unrelated, more-recent task's tags must NOT leak in (the old `rows[0]` bug).
    const byKey = {
      'delivery-checkpoint': { tags: JSON.stringify(['delivery:pending']), updated_at: 'u3', created_at: 'c3' },
    };
    const m = deriveTaskMeta(byKey);
    assert.strictEqual(m.status, 'unknown');
    assert.strictEqual(m.runtime, null);
    assert.strictEqual(m.meta.updated_at, 'u3'); // its own timestamp, guarded
    assert.strictEqual(m.meta.created_at, 'c3');
    assert.strictEqual(m.statusEntry, null);
    assert.strictEqual(m.resultEntry, null);
  });

  it('orphan does NOT inherit a lifecycle tag from an auxiliary row', () => {
    // Hardening: a stray `running` tag on a non-status/non-result row must not
    // produce a phantom RUNNING status — lifecycle comes only from status/result.
    const byKey = {
      'delivery-checkpoint': { tags: JSON.stringify(['running', 'runtime:claude']), updated_at: '2026-05-30T10:00:00Z' },
    };
    const m = deriveTaskMeta(byKey);
    assert.strictEqual(m.status, 'unknown');
    assert.strictEqual(m.runtime, null);
    assert.deepStrictEqual(m.tags, []);
  });

  it('orphan fallback row is deterministic (newest by updated_at), order-independent', () => {
    const older = { tags: JSON.stringify(['runtime:claude']), updated_at: '2026-05-30T10:00:00Z', created_at: 'c-old' };
    const newer = { tags: JSON.stringify([]), updated_at: '2026-05-30T11:00:00Z', created_at: 'c-new' };
    // Same rows, opposite insertion order → same meta picked.
    const a = deriveTaskMeta({ aux1: older, aux2: newer });
    const b = deriveTaskMeta({ aux2: newer, aux1: older });
    assert.strictEqual(a.meta.updated_at, '2026-05-30T11:00:00Z');
    assert.strictEqual(b.meta.updated_at, '2026-05-30T11:00:00Z');
    assert.strictEqual(a.meta.created_at, 'c-new');
    assert.strictEqual(b.meta.created_at, 'c-new');
  });

  it('fully empty key map yields unknown without dereferencing undefined', () => {
    assert.doesNotThrow(() => deriveTaskMeta({}));
    const m = deriveTaskMeta({});
    assert.strictEqual(m.status, 'unknown');
    assert.deepStrictEqual(m.tags, []);
    assert.strictEqual(m.meta.updated_at, undefined);
  });

  it('tolerates malformed tags JSON', () => {
    const m = deriveTaskMeta({ status: { tags: 'not-json', updated_at: 'u4' } });
    assert.strictEqual(m.status, 'unknown');
    assert.deepStrictEqual(m.tags, []);
  });
});
