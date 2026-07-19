'use strict';

/**
 * validate.js — pure validation/normalization of a fleet push payload.
 * Strict on the one required field (hostname); permissive but type-checked on
 * the rest (a missing metric renders as "—", never an error). Unknown keys are
 * dropped except under a bounded, shallow `extra` scalar map.
 */

const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXTRA_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_DISKS = 32;
const MAX_MOUNT = 200;
const MAX_EXTRA_KEYS = 32;
const MAX_EXTRA_STRING = 500;

const NUMERIC_FIELDS = [
  'cpu_pct', 'ram_total_mb', 'ram_used_mb', 'ram_used_pct',
  'uptime_s', 'load_1', 'load_5', 'load_15', 'temp_cpu_c', 'temp_gpu_c',
];

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {any} body parsed JSON request body
 * @returns {{ok: boolean, errors: string[], value?: object}}
 */
function validatePushPayload(body) {
  const errors = [];
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }

  const hostname = body.hostname;
  if (typeof hostname !== 'string' || !HOSTNAME_RE.test(hostname)) {
    errors.push('hostname is required and must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  }

  const value = { hostname };

  if (body.os != null) {
    if (typeof body.os !== 'string' || body.os.length > 32) errors.push('os must be a string ≤32 chars');
    else value.os = body.os;
  }
  if (body.platform != null) {
    if (typeof body.platform !== 'string' || body.platform.length > 32) errors.push('platform must be a string ≤32 chars');
    else value.platform = body.platform;
  }
  if (body.ts != null) {
    const t = Date.parse(body.ts);
    if (typeof body.ts !== 'string' || !Number.isFinite(t)) errors.push('ts must be an ISO-8601 string');
    else value.ts = new Date(t).toISOString();
  }

  for (const f of NUMERIC_FIELDS) {
    if (body[f] == null) continue;
    if (!isFiniteNum(body[f])) { errors.push(`${f} must be a finite number`); continue; }
    value[f] = body[f];
  }
  // Clamp percentages defensively (agents occasionally report >100 transiently).
  for (const f of ['cpu_pct', 'ram_used_pct']) {
    if (value[f] != null) value[f] = Math.max(0, Math.min(100, value[f]));
  }

  if (body.disk != null) {
    if (!Array.isArray(body.disk)) {
      errors.push('disk must be an array');
    } else {
      value.disk = body.disk
        .filter((d) => d && typeof d === 'object' && typeof d.mount === 'string')
        .slice(0, MAX_DISKS)
        .map((d) => ({
          mount: d.mount.slice(0, MAX_MOUNT),
          total_mb: isFiniteNum(d.total_mb) ? d.total_mb : null,
          used_mb: isFiniteNum(d.used_mb) ? d.used_mb : null,
          used_pct: isFiniteNum(d.used_pct) ? Math.max(0, Math.min(100, d.used_pct)) : null,
        }));
    }
  }

  if (body.extra != null) {
    if (typeof body.extra !== 'object' || Array.isArray(body.extra)) errors.push('extra must be an object');
    else {
      value.extra = {};
      let kept = 0;
      for (const [key, raw] of Object.entries(body.extra)) {
        if (kept >= MAX_EXTRA_KEYS) break;
        if (!EXTRA_KEY_RE.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        if (typeof raw === 'string') { value.extra[key] = raw.slice(0, MAX_EXTRA_STRING); kept += 1; }
        else if (typeof raw === 'boolean') { value.extra[key] = raw; kept += 1; }
        else if (isFiniteNum(raw)) { value.extra[key] = raw; kept += 1; }
      }
      // hoist a couple of well-known extras to top-level columns if present
      if (value.temp_gpu_c == null && isFiniteNum(value.extra.temp_gpu_c)) value.temp_gpu_c = value.extra.temp_gpu_c;
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], value };
}

module.exports = {
  validatePushPayload, HOSTNAME_RE, NUMERIC_FIELDS,
  MAX_DISKS, MAX_MOUNT, MAX_EXTRA_KEYS, MAX_EXTRA_STRING,
};
