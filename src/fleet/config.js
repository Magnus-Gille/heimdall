'use strict';

const fs = require('fs');
const path = require('path');
const { normAlwaysOn } = require('../db');
const { loadHostAliases } = require('../host-identity');

const CONFIG_PATH = process.env.HEIMDALL_CONFIG_PATH
  || path.join(__dirname, '..', '..', 'heimdall.config.json');

const DEFAULT_THRESHOLDS = { staleAfterS: 90, offlineAfterS: 600, sleepAfterS: 1800 };

/**
 * Load the `fleet` section of heimdall.config.json:
 *   { hosts: [{hostname, label, role, always_on}], hostAliases: {...}, thresholds: {...} }
 * A valid `fleet.hosts: []` is an intentional empty fleet and is authoritative:
 * it retires previously observed rows. An unavailable, malformed, or fleet-less
 * overlay is not an authority and must not trigger lifecycle reconciliation.
 */
function loadFleetConfig(configPath = CONFIG_PATH) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return emptyConfig('unavailable');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyConfig('malformed');
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyConfig('malformed');
  }

  if (!Object.hasOwn(raw, 'fleet')) {
    return emptyConfig('fleet-less');
  }

  const fleet = raw.fleet;
  if (!fleet || typeof fleet !== 'object' || Array.isArray(fleet)) {
    return emptyConfig('malformed');
  }
  if (!Object.hasOwn(fleet, 'hosts')) {
    return emptyConfig('fleet-less');
  }
  if (!Array.isArray(fleet.hosts)) {
    return emptyConfig('malformed');
  }
  if (fleet.hosts.some((h) => !h || typeof h !== 'object'
    || typeof h.hostname !== 'string' || h.hostname.trim() === '')) {
    return emptyConfig('malformed');
  }

  const hosts = fleet.hosts
    .map((h) => ({
      hostname: h.hostname,
      label: h.label || h.hostname,
      role: h.role || null,
      // robustly handle false/0/"0"/"false"; default true (normAlwaysOn → 1/0)
      always_on: normAlwaysOn(h.always_on) === 1,
    }));

  const thresholds = {
    staleAfterS: numOr(fleet.stale_after_s, DEFAULT_THRESHOLDS.staleAfterS),
    offlineAfterS: numOr(fleet.offline_after_s, DEFAULT_THRESHOLDS.offlineAfterS),
    sleepAfterS: numOr(fleet.sleep_after_s, DEFAULT_THRESHOLDS.sleepAfterS),
  };

  return {
    hosts,
    hostAliases: loadHostAliases(raw),
    thresholds,
    authority: {
      status: 'loaded',
      intentionallyEmpty: hosts.length === 0,
    },
  };
}

function emptyConfig(status) {
  return {
    hosts: [],
    hostAliases: {},
    thresholds: { ...DEFAULT_THRESHOLDS },
    authority: { status, intentionallyEmpty: false },
  };
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

module.exports = { loadFleetConfig, DEFAULT_THRESHOLDS, CONFIG_PATH };
