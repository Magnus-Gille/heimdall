'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'heimdall.config.json');

function configError(source, field, message) {
  return new Error(`Invalid backup freshness configuration for ${JSON.stringify(source)}.${field}: ${message}`);
}

function positiveNumber(value, source, field) {
  if (!Number.isFinite(value) || value <= 0) {
    throw configError(source, field, 'must be a positive finite number');
  }
  return value;
}

/**
 * Validate the explicit cadence contract for every backup source.
 *
 * Staleness is deliberately source-local: warning and critical are expressed
 * as multipliers of that source's expected interval, rather than inheriting a
 * generic six-hour timeout. This makes slow schedules (for example weekly
 * archives) safe to monitor without suppressing missed cycles.
 */
function validateBackupDefinitions(backups) {
  if (!backups || typeof backups !== 'object' || Array.isArray(backups)) {
    throw new Error('Invalid backup freshness configuration: backups must be a non-empty object');
  }
  const entries = Object.entries(backups);
  if (entries.length === 0) {
    throw new Error('Invalid backup freshness configuration: backups must not be empty');
  }

  const validated = {};
  for (const [name, raw] of entries) {
    if (!name.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Invalid backup freshness configuration for ${JSON.stringify(name)}: expected an object`);
    }
    if (typeof raw.description !== 'string' || !raw.description.trim()) {
      throw configError(name, 'description', 'must be a non-empty string');
    }
    if (typeof raw.schedule !== 'string' || !raw.schedule.trim()) {
      throw configError(name, 'schedule', 'must be a non-empty string');
    }
    const expectedIntervalHours = positiveNumber(raw.expected_interval_hours, name, 'expected_interval_hours');
    const warningAfterIntervals = positiveNumber(raw.warning_after_intervals, name, 'warning_after_intervals');
    const criticalAfterIntervals = positiveNumber(raw.critical_after_intervals, name, 'critical_after_intervals');
    if (criticalAfterIntervals <= warningAfterIntervals) {
      throw configError(name, 'critical_after_intervals', 'must be greater than warning_after_intervals');
    }
    validated[name] = Object.freeze({
      description: raw.description.trim(),
      schedule: raw.schedule.trim(),
      expectedIntervalHours,
      warningAfterIntervals,
      criticalAfterIntervals,
    });
  }
  return Object.freeze(validated);
}

function readConfig(configPath) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Unable to load backup freshness configuration from ${configPath}: ${err.message}`, { cause: err });
  }
  return config;
}

/**
 * The committed config owns the public backup cadence contract. A host-local
 * config selected through HEIMDALL_CONFIG_PATH is an overlay for private host
 * facts, so it inherits that contract unless it explicitly provides `backups`.
 */
function loadBackupDefinitions(configPath = process.env.HEIMDALL_CONFIG_PATH || DEFAULT_CONFIG_PATH) {
  const canonical = validateBackupDefinitions(readConfig(DEFAULT_CONFIG_PATH).backups);
  if (configPath === DEFAULT_CONFIG_PATH) return canonical;

  const overlay = readConfig(configPath);
  if (!Object.prototype.hasOwnProperty.call(overlay, 'backups')) return canonical;
  return validateBackupDefinitions(overlay.backups);
}

module.exports = { loadBackupDefinitions, validateBackupDefinitions };
