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
const TELEGRAM_TEXT_MAX = 4096;
const ALERT_TEXT_MAX = 800;
const ALERT_RETRY_BASE_MS = 60_000;
const ALERT_RETRY_MAX_MS = 60 * 60_000;

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

/** Remove presentation-only Markdown while retaining readable text and lines. */
function stripMarkdownForTelegram(text) {
  let result = String(text || '');

  // Keep fenced content, dropping only the fence and optional language marker.
  result = result.replace(/^```[^\n]*\n?/gm, '').replace(/^```\s*$/gm, '');
  result = result.replace(/`([^`]+)`/g, '$1');
  result = result.replace(/^#{1,6}\s+/gm, '');
  result = result.replace(/\*{3}(.+?)\*{3}/g, '$1');
  result = result.replace(/\*{2}(.+?)\*{2}/g, '$1');
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/~~(.+?)~~/g, '$1');
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  result = result.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1');
  result = result.replace(/^>\s?/gm, '');
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');
  result = result.replace(/^(\s*)[-*+]\s+/gm, '$1');

  // Tables need their lines: flattening them loses both headers and values.
  result = result.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!/^\|.*\|$/.test(trimmed)) return line;
    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return '';
    return cells.join(' · ');
  }).join('\n');

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** Bound the complete payload without splitting words, preserving Telegram's limit. */
function truncateForTelegram(text) {
  if (text.length <= TELEGRAM_TEXT_MAX) return text;
  const footer = '\n\nFull result in Munin.';
  const maxContent = TELEGRAM_TEXT_MAX - footer.length - 1; // one ellipsis
  const candidate = text.slice(0, maxContent + 1);
  const boundary = Math.max(
    candidate.lastIndexOf(' '),
    candidate.lastIndexOf('\n'),
    candidate.lastIndexOf('\t'),
  );
  const content = (boundary > 0 ? candidate.slice(0, boundary) : text.slice(0, maxContent)).trimEnd();
  return `${content}…${footer}`;
}

/**
 * Build a concise plain-text Telegram message for a terminal task.
 * @param {{ name:string, status:string, result:string|null }} task
 * @returns {string}
 */
function buildNotifyText(task) {
  const statusLabel = (task.status === 'completed' || task.status === 'done') ? 'completed' : task.status || 'unknown';
  const name = task.name || 'unknown task';
  const outcome = extractResultOutput(task.result) || task.result || '';
  const snippet = stripMarkdownForTelegram(outcome);
  let text = `[Grimnir] ${name} — ${statusLabel}`;
  if (snippet) text += `\n${snippet}`;
  return truncateForTelegram(text);
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
    if (!res.ok) {
      const err = new Error(`ratatoskr ${res.status}`);
      err.code = 'RATATOSKR_HTTP';
      err.status = res.status;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

// --- Critical infrastructure alerts -----------------------------------------

function oneLine(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Build bounded plain text for the private operator channel. Alert fields can
 * originate in authenticated pushed envelopes, so collapse newlines before
 * composing the message and keep the transport payload small.
 */
function buildCriticalAlertText(alert) {
  const title = oneLine(alert && alert.title, 200) || 'Unknown alert';
  const host = oneLine(alert && alert.host, 120) || 'unknown host';
  const detail = oneLine(alert && alert.detail, 400);
  let text = `[Grimnir alert] CRITICAL: ${title}\nHost: ${host}`;
  if (detail) text += `\n${detail}`;
  return text.slice(0, ALERT_TEXT_MAX);
}

function safeDeliveryError(err) {
  if (err && err.code === 'RATATOSKR_HTTP' && Number.isInteger(err.status)) {
    return `ratatoskr-http-${err.status}`;
  }
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return 'timeout';
  return 'transport-error';
}

function nextRetryAt(now, attemptsBeforeFailure) {
  const exponent = Math.min(Math.max(attemptsBeforeFailure, 0), 6);
  const delay = Math.min(ALERT_RETRY_BASE_MS * (2 ** exponent), ALERT_RETRY_MAX_MS);
  return new Date(now.getTime() + delay).toISOString();
}

function parseChatId(supplied) {
  if (supplied === null || supplied === undefined || supplied === '') return null;
  if (typeof supplied === 'number') {
    return Number.isSafeInteger(supplied) && supplied !== 0 ? supplied : null;
  }
  const raw = String(supplied).trim();
  if (!/^-?\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

function configuredChatId(deps) {
  const supplied = Object.prototype.hasOwnProperty.call(deps, 'chatId')
    ? deps.chatId
    : process.env.HEIMDALL_NOTIFY_CHAT_ID;
  return parseChatId(supplied);
}

/**
 * Deliver retry-due active critical alerts through the existing Ratatoskr
 * transport. The database row is the durable outbox:
 *   - active-row dedup means repeated observations do not resend;
 *   - failure leaves the row retryable with persistent exponential backoff;
 *   - resolve + recurrence creates a fresh pending row.
 *
 * No destination, token, raw transport exception, or alert detail is logged.
 */
async function sendCriticalAlertNotifications(db, deps = {}) {
  const {
    getPendingCriticalAlertNotifications,
    markCriticalAlertNotificationSent,
    markCriticalAlertNotificationFailed,
  } = require('./db');
  const nowValue = typeof deps.now === 'function' ? deps.now() : new Date();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowIso = now.toISOString();
  const limit = Number.isSafeInteger(deps.limit) && deps.limit > 0
    ? Math.min(deps.limit, MAX_PER_CYCLE)
    : MAX_PER_CYCLE;
  const pending = getPendingCriticalAlertNotifications(db, nowIso, limit);
  if (pending.length === 0) return { sent: 0, failed: 0, pending: 0 };

  const chatId = configuredChatId(deps);
  const send = typeof deps.sendTelegram === 'function' ? deps.sendTelegram : sendTelegram;
  const onError = typeof deps.onError === 'function'
    ? deps.onError
    : (alertId, errorClass) =>
      console.error(`  Critical alert notification failed for alert ${alertId}: ${errorClass}`);
  let sent = 0;
  let failed = 0;

  for (const alert of pending) {
    if (chatId === null) {
      markCriticalAlertNotificationFailed(
        db,
        alert.id,
        'not-configured',
        nextRetryAt(now, alert.notification_attempts || 0),
      );
      failed += 1;
      continue;
    }
    try {
      await send(chatId, buildCriticalAlertText(alert));
      markCriticalAlertNotificationSent(db, alert.id, nowIso);
      sent += 1;
    } catch (err) {
      const errorClass = safeDeliveryError(err);
      markCriticalAlertNotificationFailed(
        db,
        alert.id,
        errorClass,
        nextRetryAt(now, alert.notification_attempts || 0),
      );
      onError(alert.id, errorClass);
      failed += 1;
    }
  }

  return {
    sent,
    failed,
    pending: pending.length,
    ...(chatId === null ? { skipped: true } : {}),
  };
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
  const chatId = parseChatId(chatIdRaw);
  if (chatId === null) {
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
module.exports = {
  sendTaskNotifications,
  buildNotifyText,
  stripMarkdownForTelegram,
  truncateForTelegram,
  markNotified,
  markNotifyFailed,
  sendTelegram,
  buildCriticalAlertText,
  sendCriticalAlertNotifications,
  safeDeliveryError,
  parseChatId,
};
