'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const { humanizeTaskName } = require('./html');

const MUNIN_DB_PATH = path.join(os.homedir(), '.munin-memory', 'memory.db');

// Dispatched tasks have date-prefixed IDs: tasks/20260321-082800-foo or tasks/20260402-research-foo.
// There is always a non-empty slug after the date (or date-time). Two legal shapes:
//   date-time-slug: tasks/<8d>-<6d>-<slug>   |   date-slug: tasks/<8d>-<slug> (slug not a bare time)
// This rejects bare timestamp fragments with no slug: `tasks/<8d>`, `tasks/<8d>-<6d>`, `tasks/<8d>-<6d>-`.
const TASK_NS_RE = /^tasks\/(?:\d{8}-\d{6}-.+|\d{8}-(?!\d{6}(?:-|$)).+)$/;

function isDispatchedTask(namespace) {
  return TASK_NS_RE.test(namespace);
}

// Pure: derive shared task metadata from a namespace's key→row map.
// Lifecycle metadata (status/runtime/tags) comes ONLY from the authoritative
// `status`/`result` entries — an orphaned namespace with neither reports `unknown`
// and never inherits a lifecycle tag (e.g. a stray `running`) from an auxiliary row.
// `meta` is used only for safe timestamp access and falls back to the NEWEST auxiliary
// row, so the list and detail readers agree deterministically regardless of row order.
// (issue #12; hardened per cross-model review)
function deriveTaskMeta(byKey) {
  const statusEntry = byKey.status || null;
  const resultEntry = byKey.result || null;
  const authoritative = statusEntry || resultEntry;

  let tags = [];
  if (authoritative) {
    try { tags = JSON.parse(authoritative.tags || '[]'); } catch { /* ok */ }
  }
  const status = tags.find(t => ['pending', 'running', 'claimed', 'completed', 'done', 'failed', 'error'].includes(t)) || 'unknown';
  const runtimeTag = tags.find(t => typeof t === 'string' && t.startsWith('runtime:'));
  const runtime = runtimeTag ? runtimeTag.split(':')[1] : null;

  const newestRow = Object.values(byKey)
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
  const meta = authoritative || newestRow || {};

  return { statusEntry, resultEntry, meta, tags, status, runtime };
}

function readHuginTasks({ limit = 50 } = {}) {
  try {
    const munin = new Database(MUNIN_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const rows = munin.prepare(`
        SELECT namespace, key, content, tags, updated_at
        FROM entries
        WHERE namespace GLOB 'tasks/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-*'
          AND entry_type = 'state'
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(limit);

      // Group by namespace — each task has "status" and optionally "result" keys
      const byNs = new Map();
      for (const row of rows) {
        if (!byNs.has(row.namespace)) byNs.set(row.namespace, {});
        byNs.get(row.namespace)[row.key] = row;
      }

      return Array.from(byNs.entries())
        .filter(([ns]) => isDispatchedTask(ns))
        .map(([ns, keys]) => {
        const { statusEntry, resultEntry, meta, status, runtime } = deriveTaskMeta(keys);
        const name = ns.split('/').pop();

        // For failed tasks, extract a one-line failure reason from result content
        let failureReason = null;
        if ((status === 'failed' || status === 'error') && resultEntry) {
          failureReason = extractFailureReason(String(resultEntry.content || ''));
        }

        return {
          namespace: ns,
          key: statusEntry ? 'status' : Object.keys(keys)[0],
          name,
          status,
          runtime,
          updated_at: meta.updated_at,
          tags: meta.tags,
          content: (statusEntry || {}).content || null,
          result_snippet: resultEntry ? String(resultEntry.content).slice(0, 500) : null,
          failureReason,
        };
      });
    } finally {
      munin.close();
    }
  } catch (err) {
    console.error('Failed to read Munin DB:', err.message);
    return [];
  }
}

// Ensure task tracking table exists
function ensureTaskTrackingTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hugin_task_state (
      task_key TEXT PRIMARY KEY,
      last_status TEXT,
      last_updated TEXT
    )
  `);
}

function detectTaskChanges(db, currentTasks) {
  ensureTaskTrackingTable(db);
  const events = [];

  const getStmt = db.prepare('SELECT last_status, last_updated FROM hugin_task_state WHERE task_key = ?');
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO hugin_task_state (task_key, last_status, last_updated)
    VALUES (?, ?, ?)
  `);

  for (const task of currentTasks) {
    const taskKey = task.namespace + '/' + task.key;
    const prev = getStmt.get(taskKey);
    const prevStatus = prev?.last_status;

    // Only log if status actually changed
    if (prevStatus !== task.status) {
      if (task.status === 'completed' || task.status === 'done') {
        events.push({
          category: 'task',
          severity: 'info',
          title: `${humanizeTaskName(task.name)} completed`,
          detail: JSON.stringify({
            task: task.name,
            outcome: 'succeeded',
            runtime: task.runtime || null,
          }),
          source: 'hugin',
        });
      } else if (task.status === 'claimed' || task.status === 'running') {
        events.push({
          category: 'task',
          severity: 'info',
          title: `${humanizeTaskName(task.name)} claimed`,
          detail: JSON.stringify({ task: task.name, status: 'claimed' }),
          source: 'hugin',
        });
      } else if (task.status === 'failed' || task.status === 'error') {
        events.push({
          category: 'task',
          severity: 'error',
          title: `${humanizeTaskName(task.name)} failed`,
          detail: JSON.stringify({
            task: task.name,
            outcome: 'failed',
          }),
          source: 'hugin',
        });
      }

      upsertStmt.run(taskKey, task.status, task.updated_at);
    }
  }

  return events;
}

// Lines that are markdown formatting noise, not meaningful failure info
function isMdNoise(line) {
  const t = line.trim();
  return /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t) || /^```/.test(t) || t === '';
}

function extractFailureReason(content) {
  if (!content) return null;
  // Check for exit code patterns
  const exitMatch = content.match(/exit[- _]?code[:\s]+(-?\d+)/i) || content.match(/exited? (?:with )?(-?\d+)/i);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;

  if (exitCode === 143) return 'Killed (SIGTERM)';
  if (exitCode === 137) return 'Killed (SIGKILL / OOM)';
  if (exitCode === 124) return 'Timeout';
  if (exitCode === -1) return content.toLowerCase().includes('timeout') ? 'Timeout' : 'Abnormal exit';

  if (content.toLowerCase().includes('timeout')) return 'Timeout';
  if (content.toLowerCase().includes('parse error')) return 'Parse error';

  if (exitCode != null && exitCode !== 0) {
    // Try to get first meaningful line of output
    const lines = content.split('\n').filter(l => l.trim() && !l.match(/^(exit|duration|status|DONE|FAILED)/i) && !isMdNoise(l));
    if (lines.length > 0) {
      const firstLine = lines[0].trim().slice(0, 80);
      return `Exit ${exitCode} — ${firstLine}`;
    }
    return `Exit code ${exitCode}`;
  }

  // Fallback: first non-empty, non-markdown-noise line
  const firstLine = content.split('\n').find(l => l.trim() && !isMdNoise(l));
  return firstLine ? firstLine.trim().slice(0, 80) : 'Unknown failure';
}

function getTaskSuccessRate(tasks, days) {
  const since = Date.now() - days * 24 * 3600000;
  const recent = tasks.filter(t => {
    if (!t.updated_at) return false;
    return new Date(t.updated_at).getTime() >= since;
  });
  const completed = recent.filter(t => t.status === 'completed' || t.status === 'done').length;
  const failed = recent.filter(t => t.status === 'failed' || t.status === 'error').length;
  const total = completed + failed;
  if (total === 0) return null;
  return { rate: Math.round((completed / total) * 100), completed, failed, total, days };
}

/**
 * Compute operator-useful queue metrics from task data.
 * Returns { oldestPendingAge, runningDuration, avgCompletionMs, stuckTasks[], retryCount }
 */
function getTaskQueueMetrics(tasks) {
  const now = Date.now();
  const result = {
    oldestPendingAge: null,
    runningTasks: [],
    avgCompletionTime: null,
    stuckTasks: [],
    retryCount: 0,
  };

  // Oldest pending task age
  const pending = tasks.filter(t => t.status === 'pending');
  if (pending.length > 0) {
    const ages = pending
      .filter(t => t.updated_at)
      .map(t => now - new Date(t.updated_at).getTime());
    if (ages.length > 0) {
      result.oldestPendingAge = Math.max(...ages);
    }
  }

  // Running tasks with duration
  const running = tasks.filter(t => t.status === 'running' || t.status === 'claimed');
  result.runningTasks = running.map(t => {
    const duration = t.updated_at ? now - new Date(t.updated_at).getTime() : null;
    return { name: t.name, namespace: t.namespace, duration };
  });

  // Stuck task detection: running for >30 min (generous threshold)
  const STUCK_THRESHOLD_MS = 30 * 60000;
  result.stuckTasks = result.runningTasks.filter(t => t.duration && t.duration > STUCK_THRESHOLD_MS);

  // Average completion time from last 10 completed tasks
  // runtime tag holds the runtime label (e.g. "claude", "codex"), not a duration string.
  // Derive elapsed time from the creation timestamp embedded in the namespace (tasks/YYYYMMDD-HHmmss-...)
  // vs updated_at (when the task reached completed/done status). Hugin task IDs are UTC, so the
  // namespace timestamp is parsed as UTC (trailing `Z`) to match updated_at, not as local time.
  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'done');
  if (completed.length > 0) {
    const runtimes = completed.slice(0, 10)
      .map(t => {
        if (!t.updated_at) return null;
        const m = (t.namespace || '').match(/tasks\/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/);
        if (!m) return null;
        const createdAt = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
        if (!isFinite(createdAt)) return null;
        return new Date(t.updated_at).getTime() - createdAt;
      })
      .filter(r => r != null && r > 0);
    if (runtimes.length > 0) {
      result.avgCompletionTime = Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length);
    }
  }

  // Retry count: tasks with -retry in name
  result.retryCount = tasks.filter(t => /-retry(-\d+)?$/.test(t.name)).length;

  return result;
}

/**
 * Read Hugin dispatcher heartbeat from Munin DB.
 * Returns { polled_at, queue_depth, current_task, uptime_s, status, freshness_ms } or null.
 */
function readHuginHeartbeat() {
  try {
    const munin = new Database(MUNIN_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const row = munin.prepare(`
        SELECT content, updated_at FROM entries
        WHERE namespace = 'tasks/_heartbeat' AND key = 'status' AND entry_type = 'state'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get();

      if (!row || !row.content) return null;

      const data = JSON.parse(row.content);
      const polledAt = data.polled_at || row.updated_at;
      const parsed = polledAt ? new Date(polledAt).getTime() : NaN;
      const freshnessMs = isFinite(parsed) ? Date.now() - parsed : null;

      let status = 'unknown';
      if (freshnessMs != null) {
        if (freshnessMs < 2 * 60000) status = 'running';
        else if (freshnessMs < 10 * 60000) status = 'stale';
        else status = 'down';
      }

      return {
        polled_at: polledAt,
        queue_depth: data.queue_depth ?? null,
        current_task: data.current_task ?? null,
        uptime_s: data.uptime_s ?? null,
        status,
        freshness_ms: freshnessMs,
      };
    } finally {
      munin.close();
    }
  } catch (err) {
    console.error('Failed to read Hugin heartbeat:', err.message);
    return null;
  }
}

/**
 * Read full task data for a single task (both status + result keys, untruncated).
 * Used for task detail views where the full prompt and output are needed.
 */
function readHuginTaskFull(namespace) {
  if (!TASK_NS_RE.test(namespace)) return null;
  try {
    const munin = new Database(MUNIN_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const rows = munin.prepare(`
        SELECT key, content, tags, updated_at, created_at
        FROM entries
        WHERE namespace = ? AND entry_type = 'state'
      `).all(namespace);

      if (rows.length === 0) return null;

      const byKey = {};
      for (const row of rows) byKey[row.key] = row;

      const { statusEntry, resultEntry, meta, tags, status, runtime } = deriveTaskMeta(byKey);
      const name = namespace.split('/').pop();

      let failureReason = null;
      if ((status === 'failed' || status === 'error') && resultEntry) {
        failureReason = extractFailureReason(String(resultEntry.content || ''));
      }

      return {
        namespace,
        name,
        status,
        runtime,
        tags,
        content: statusEntry ? statusEntry.content : null,
        result: resultEntry ? resultEntry.content : null,
        failureReason,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
      };
    } finally {
      munin.close();
    }
  } catch (err) {
    console.error('Failed to read task:', err.message);
    return null;
  }
}

/**
 * Compute timeout calibration metrics from completed task results.
 * Reads duration and timeout from Munin task result entries.
 * Returns { sampleSize, timeoutRatio, overUtilized, underUtilized, medianDurationS, medianTimeoutS }
 */
function getTimeoutCalibration(days = 30) {
  try {
    const munin = new Database(MUNIN_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const since = new Date(Date.now() - days * 24 * 3600000).toISOString();
      const rows = munin.prepare(`
        SELECT namespace, content FROM entries
        WHERE namespace GLOB 'tasks/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-*'
          AND key = 'result' AND entry_type = 'state'
          AND updated_at >= ?
        ORDER BY updated_at DESC
      `).all(since);

      const tasks = [];
      for (const row of rows) {
        const c = row.content || '';
        const durMatch = c.match(/\*\*Duration:\*\*\s*(\d+)s/);
        const toMatch = c.match(/\*\*Timeout:\*\*\s*(\d+)/);
        if (!durMatch) continue;
        const durationS = parseInt(durMatch[1], 10);
        // Timeout is in ms in the task spec, but result may show it either way
        let timeoutS = null;
        if (toMatch) {
          const val = parseInt(toMatch[1], 10);
          timeoutS = val > 10000 ? Math.round(val / 1000) : val; // ms → s if large
        }
        tasks.push({ namespace: row.namespace, durationS, timeoutS });
      }

      if (tasks.length === 0) return null;

      // Tasks with known timeout
      const withTimeout = tasks.filter(t => t.timeoutS != null && t.timeoutS > 0);
      const ratios = withTimeout.map(t => t.durationS / t.timeoutS);

      // Over-utilized: used >80% of timeout (close to being killed)
      const overUtilized = ratios.filter(r => r > 0.8).length;
      // Under-utilized: finished in <20% of timeout (timeout too generous)
      const underUtilized = ratios.filter(r => r < 0.2).length;
      // Timed out: exit code TIMEOUT or duration >= timeout
      const timedOut = withTimeout.filter(t => t.durationS >= t.timeoutS * 0.95).length;

      const durations = tasks.map(t => t.durationS).sort((a, b) => a - b);
      const medianDurationS = durations[Math.floor(durations.length / 2)];

      const timeouts = withTimeout.map(t => t.timeoutS).sort((a, b) => a - b);
      const medianTimeoutS = timeouts.length > 0 ? timeouts[Math.floor(timeouts.length / 2)] : null;

      return {
        sampleSize: tasks.length,
        withTimeoutCount: withTimeout.length,
        timedOut,
        overUtilized,
        underUtilized,
        timeoutRatio: withTimeout.length > 0 ? +(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(3) : null,
        medianDurationS,
        medianTimeoutS,
        days,
      };
    } finally {
      munin.close();
    }
  } catch (err) {
    console.error('Failed to compute timeout calibration:', err.message);
    return null;
  }
}

module.exports = { readHuginTasks, readHuginTaskFull, detectTaskChanges, getTaskSuccessRate, getTaskQueueMetrics, getTimeoutCalibration, isDispatchedTask, readHuginHeartbeat, deriveTaskMeta };
