'use strict';

/**
 * util.js — v2 canonical render helpers (escaping + formatting).
 * These are the forward-looking replacements for the equivalents scattered
 * across html.js; new render modules import from here, not html.js.
 */

/** HTML-escape ALL dynamic content inserted into templates (XSS guard). */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Relative age, e.g. "3m ago", "2h 5m ago". `now` injectable for tests. */
function formatAge(isoTimestamp, now = Date.now()) {
  if (!isoTimestamp) return 'never';
  const diff = now - new Date(isoTimestamp).getTime();
  if (Number.isNaN(diff)) return 'never';
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function formatAgeWithTimestamp(isoTimestamp, now = Date.now()) {
  if (!isoTimestamp) return 'never';
  return `<time datetime="${esc(isoTimestamp)}" title="${esc(isoTimestamp)}">${esc(formatAge(isoTimestamp, now))}</time>`;
}

/**
 * Forward-looking ETA, e.g. "in 3h 5m", "in 12m". The mirror of formatAge for
 * inherently-future timestamps (a timer's next scheduled run) — formatAge would
 * mislabel any future time as "just now".
 */
function formatEta(isoTimestamp, now = Date.now()) {
  if (!isoTimestamp) return 'unknown';
  const diff = new Date(isoTimestamp).getTime() - now;
  if (Number.isNaN(diff)) return 'unknown';
  if (diff <= 0) return 'due now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'in <1m';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

/** Human uptime from seconds, e.g. "10d 3h", "2h 14m". */
function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${Math.floor(seconds)}s`;
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatPct(value, digits = 0) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

module.exports = {
  esc,
  formatAge,
  formatAgeWithTimestamp,
  formatEta,
  formatUptime,
  formatBytes,
  formatPct,
};
