'use strict';

/**
 * notify.js — Task-completion notifications via ratatoskr / Telegram.
 *
 * Replaces src/email.js. Same query / rate-limit / mark-notified semantics.
 * Best-effort: never throws out of sendTaskNotifications.
 *
 * Environment variables:
 *   HEIMDALL_NOTIFY_CHAT_ID   — Telegram chat_id (integer). Required to send.
 *                               Unset → skip silently (fail-safe, no crash).
 *   RATATOSKR_URL             — ratatoskr endpoint (default: loopback)
 *   RATATOSKR_SEND_API_KEY    — optional Bearer token for forward-compat with ratatoskr auth
 */

const { extractResultOutput } = require('./task-utils');

// Local-only is the safe default. Set RATATOSKR_URL explicitly when the router
// runs on another host and protect that connection with its bearer token.
const RATATOSKR_DEFAULT = 'http://127.0.0.1:3034/api/send';
const MAX_PER_CYCLE = 3;
const FETCH_TIMEOUT_MS = 8000;

// --- DB helpers (ported from email.js) ---------------------------------------

function ensureNotifyColumns(db) {
  try {
    db.prepare('SELECT notified_at FROM hugin_task_state LIMIT 0').run();
  } catch {
    db.exec('ALTER TABLE hugin_task_state ADD COLUMN notified_at TEXT');
    db.exec('ALTER TABLE hugin_task_state ADD COLUMN notify_attempts INTEGER DEFAULT 0');
    // Backfill: mark all existing terminal tasks so we don't spam on first deploy
    db.exec("UPDATE hugin_task_state SET notified_at = 'backfilled' WHERE last_status IN ('completed', 'done', 'failed', 'error')");
  }
}

function getUnnotifiedTasks(db) {
  ensureNotifyColumns(db);
  return db.prepare(`
    SELECT task_key, last_status, last_updated FROM hugin_task_state
    WHERE last_status IN ('completed', 'done', 'failed', 'error')
      AND notified_at IS NULL
      AND (notify_attempts IS NULL OR notify_attempts < 3)
      AND last_updated > datetime('now', '-30 minutes')
  `).all();
}

function markNotified(db, taskKey) {
  db.prepare("UPDATE hugin_task_state SET notified_at = datetime('now'), notify_attempts = 0 WHERE task_key = ?").run(taskKey);
}

function markNotifyFailed(db, taskKey) {
  db.prepare('UPDATE hugin_task_state SET notify_attempts = COALESCE(notify_attempts, 0) + 1 WHERE task_key = ?').run(taskKey);
}

// --- Message builder ---------------------------------------------------------

/**
 * Build a concise plain-text Telegram message for a terminal task.
 * @param {{ name:string, status:string, result:string|null }} task
 * @returns {string}
 */
function buildNotifyText(task) {
  const statusLabel = (task.status === 'completed' || task.status === 'done') ? 'completed' : task.status || 'unknown';
  const name = task.name || 'unknown task';
  const outcome = extractResultOutput(task.result) || task.result || '';
  const snippet = outcome.slice(0, 200).replace(/\n+/g, ' ');
  let text = `[Grimnir] ${name} — ${statusLabel}`;
  if (snippet) text += `\n${snippet}`;
  return text;
}

// --- Telegram send -----------------------------------------------------------

async function sendTelegram(chatId, text) {
  const url = process.env.RATATOSKR_URL || RATATOSKR_DEFAULT;
  const apiKey = process.env.RATATOSKR_SEND_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ratatoskr ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

// --- Main entry point --------------------------------------------------------

/**
 * Find unnotified terminal tasks and send Telegram notifications via ratatoskr.
 * Called from the collector after detectTaskChanges. Never throws.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{sent:number, failed:number, skipped?:true}>}
 */
async function sendTaskNotifications(db) {
  const chatIdRaw = process.env.HEIMDALL_NOTIFY_CHAT_ID;
  if (!chatIdRaw) {
    console.log('  Notifications: HEIMDALL_NOTIFY_CHAT_ID not set — skipping');
    return { sent: 0, failed: 0, skipped: true };
  }
  const chatId = parseInt(chatIdRaw, 10);
  if (isNaN(chatId)) {
    console.error('  Notifications: HEIMDALL_NOTIFY_CHAT_ID is not a valid integer — skipping');
    return { sent: 0, failed: 0, skipped: true };
  }

  // Backfill stale failed tasks to prevent eternal retry spam
  ensureNotifyColumns(db);
  const stale = db.prepare(`
    SELECT COUNT(*) as c FROM hugin_task_state
    WHERE last_status IN ('completed', 'done', 'failed', 'error')
      AND notified_at IS NULL AND notify_attempts >= 3
  `).get();
  if (stale.c > 0) {
    db.exec("UPDATE hugin_task_state SET notified_at = 'backfilled' WHERE last_status IN ('completed', 'done', 'failed', 'error') AND notified_at IS NULL AND last_updated < datetime('now', '-1 hour')");
  }

  const pending = getUnnotifiedTasks(db);
  if (pending.length === 0) return { sent: 0, failed: 0 };

  if (pending.length > MAX_PER_CYCLE) {
    console.log(`  Notifications: ${pending.length} pending, capping at ${MAX_PER_CYCLE} per cycle`);
  }
  const batch = pending.slice(0, MAX_PER_CYCLE);

  let sent = 0;
  let failed = 0;

  for (const row of batch) {
    const ns = row.task_key.replace(/\/status$/, '').replace(/\/result$/, '');
    try {
      const { readHuginTaskFull } = require('./hugin');
      const task = readHuginTaskFull(ns);
      if (!task) {
        markNotified(db, row.task_key);
        continue;
      }
      const text = buildNotifyText(task);
      await sendTelegram(chatId, text);
      markNotified(db, row.task_key);
      sent++;
    } catch (err) {
      console.error(`  Telegram notification failed for ${ns}:`, err.message);
      markNotifyFailed(db, row.task_key);
      failed++;
    }
  }

  return { sent, failed };
}

// sendTelegram is exported so infrastructure alerts (e.g. the boot health check) can
// push ad-hoc Telegram messages via Ratatoskr without going through the Hugin-task path.
module.exports = { sendTaskNotifications, buildNotifyText, markNotified, markNotifyFailed, sendTelegram };
