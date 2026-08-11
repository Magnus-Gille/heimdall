'use strict';

const fs = require('fs');
const path = require('path');
const { normAlwaysOn } = require('../db');
const { loadHostAliases } = require('../host-identity');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'heimdall.config.json');

const DEFAULT_THRESHOLDS = { staleAfterS: 90, offlineAfterS: 600, sleepAfterS: 1800 };

/**
 * Load the `fleet` section of heimdall.config.json:
 *   { hosts: [{hostname, label, role, always_on}], hostAliases: {...}, thresholds: {...} }
 * Missing file/section → empty host list + default thresholds (never throws).
 */
function loadFleetConfig(configPath = CONFIG_PATH) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch { /* missing/invalid config — fall back to defaults */ }

  const fleet = raw && typeof raw === 'object' ? raw.fleet || {} : {};
  const hosts = Array.isArray(fleet.hosts)
    ? fleet.hosts
        .filter((h) => h && typeof h.hostname === 'string')
        .map((h) => ({
          hostname: h.hostname,
          label: h.label || h.hostname,
          role: h.role || null,
          // robustly handle false/0/"0"/"false"; default true (normAlwaysOn → 1/0)
          always_on: normAlwaysOn(h.always_on) === 1,
        }))
    : [];

  const thresholds = {
    staleAfterS: numOr(fleet.stale_after_s, DEFAULT_THRESHOLDS.staleAfterS),
    offlineAfterS: numOr(fleet.offline_after_s, DEFAULT_THRESHOLDS.offlineAfterS),
    sleepAfterS: numOr(fleet.sleep_after_s, DEFAULT_THRESHOLDS.sleepAfterS),
  };

  return { hosts, hostAliases: loadHostAliases(raw), thresholds };
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

module.exports = { loadFleetConfig, DEFAULT_THRESHOLDS, CONFIG_PATH };
