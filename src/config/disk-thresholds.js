'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'heimdall.config.json');

function configError(metric, field, message) {
  return new Error(`Invalid disk threshold configuration for ${JSON.stringify(metric)}.${field}: ${message}`);
}

function finiteNumber(value, metric, field) {
  if (!Number.isFinite(value)) throw configError(metric, field, 'must be a finite number');
  return value;
}

function percentage(value, metric, field) {
  finiteNumber(value, metric, field);
  if (value <= 0 || value >= 100) throw configError(metric, field, 'must be greater than 0 and less than 100');
  return value;
}

function reserveFraction(value, metric, field) {
  finiteNumber(value, metric, field);
  if (value <= 0 || value >= 1) throw configError(metric, field, 'must be greater than 0 and less than 1');
  return value;
}

/**
 * Turn public, purpose-aware per-volume rules into the conventional percentage
 * thresholds used by the alert engine. A quota backup reserves the filesystem
 * space outside its managed quota: warning/critical fire only after the stated
 * fraction of that reserve remains, so a full healthy Time Machine quota does
 * not demand deleting retained backups.
 */
function validateDiskThresholds(volumes) {
  if (!volumes || typeof volumes !== 'object' || Array.isArray(volumes)) {
    throw new Error('Invalid disk threshold configuration: disk_volumes must be a non-empty object');
  }
  const entries = Object.entries(volumes);
  if (entries.length === 0) throw new Error('Invalid disk threshold configuration: disk_volumes must not be empty');

  const validated = {};
  for (const [metric, raw] of entries) {
    if (!metric.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Invalid disk threshold configuration for ${JSON.stringify(metric)}: expected an object`);
    }
    if (raw.purpose === 'general') {
      const warning = percentage(raw.warning_pct, metric, 'warning_pct');
      const critical = percentage(raw.critical_pct, metric, 'critical_pct');
      if (critical <= warning) throw configError(metric, 'critical_pct', 'must be greater than warning_pct');
      validated[metric] = Object.freeze({ warning, critical, unit: '%', purpose: raw.purpose });
      continue;
    }
    if (raw.purpose !== 'quota_backup') {
      throw configError(metric, 'purpose', 'must be "general" or "quota_backup"');
    }
    const total = finiteNumber(raw.total_bytes, metric, 'total_bytes');
    const quota = finiteNumber(raw.quota_bytes, metric, 'quota_bytes');
    if (total <= 0) throw configError(metric, 'total_bytes', 'must be a positive finite number');
    if (quota <= 0 || quota >= total) throw configError(metric, 'quota_bytes', 'must be greater than 0 and less than total_bytes');
    const warningReserve = reserveFraction(raw.warning_reserve_fraction, metric, 'warning_reserve_fraction');
    const criticalReserve = reserveFraction(raw.critical_reserve_fraction, metric, 'critical_reserve_fraction');
    if (criticalReserve >= warningReserve) {
      throw configError(metric, 'critical_reserve_fraction', 'must be less than warning_reserve_fraction');
    }
    const reserve = total - quota;
    const warning = 100 * (1 - ((reserve * warningReserve) / total));
    const critical = 100 * (1 - ((reserve * criticalReserve) / total));
    validated[metric] = Object.freeze({ warning, critical, unit: '%', purpose: raw.purpose });
  }
  return Object.freeze(validated);
}

function readConfig(configPath) {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (err) {
    throw new Error(`Unable to load disk threshold configuration from ${configPath}: ${err.message}`, { cause: err });
  }
}

/** A private overlay inherits the committed public volume policy unless replaced explicitly. */
function loadDiskThresholds(configPath = process.env.HEIMDALL_CONFIG_PATH || DEFAULT_CONFIG_PATH) {
  const canonical = validateDiskThresholds(readConfig(DEFAULT_CONFIG_PATH).disk_volumes);
  if (configPath === DEFAULT_CONFIG_PATH) return canonical;
  const overlay = readConfig(configPath);
  if (!Object.prototype.hasOwnProperty.call(overlay, 'disk_volumes')) return canonical;
  return validateDiskThresholds(overlay.disk_volumes);
}

module.exports = { loadDiskThresholds, validateDiskThresholds };
