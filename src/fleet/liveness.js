'use strict';

/**
 * liveness.js — pure fleet liveness state machine.
 *
 * State is DERIVED from last_seen + always_on at read time (never stored), so it
 * is always correct without a background job. The single `always_on` flag is
 * what makes the intermittent laptop a first-class citizen: a quiet always-on
 * host goes `offline` (and alerts); a quiet non-always-on host goes `sleeping`
 * (and never alerts).
 *
 *   online   : last push < staleAfterS
 *   stale    : staleAfterS ≤ age < (offline|sleep threshold)   (amber, no alert)
 *   offline  : age past threshold AND always_on                (red, ALERTS)
 *   sleeping : age past threshold AND NOT always_on            (grey, no alert)
 */

const DEFAULTS = Object.freeze({
  staleAfterS: 90,       // 3× the 30s push interval
  offlineAfterS: 600,    // always-on host silent >10m → offline + alert
  sleepAfterS: 1800,     // non-always-on host silent >30m → sleeping (no alert)
});

/**
 * @param {{last_seen?: string|null, always_on?: boolean|number}} host
 * @param {number} now epoch ms (injectable for tests)
 * @param {object} [cfg] threshold overrides
 * @returns {'online'|'stale'|'offline'|'sleeping'}
 */
function deriveState(host, now, cfg = {}) {
  const { staleAfterS, offlineAfterS, sleepAfterS } = { ...DEFAULTS, ...cfg };
  const alwaysOn = host.always_on === true || host.always_on === 1;

  const lastSeenMs = host.last_seen ? Date.parse(host.last_seen) : NaN;
  if (!Number.isFinite(lastSeenMs)) {
    // Never seen (or unparseable): an always-on host that has never reported is
    // offline; a laptop that has never reported is simply sleeping.
    return alwaysOn ? 'offline' : 'sleeping';
  }

  const ageS = (now - lastSeenMs) / 1000;
  if (ageS < staleAfterS) return 'online';

  const threshold = alwaysOn ? offlineAfterS : sleepAfterS;
  if (ageS < threshold) return 'stale';
  return alwaysOn ? 'offline' : 'sleeping';
}

/**
 * Display state for a configured/observed host.
 *
 * Keep deriveState's historical four-state API intact for callers that already
 * treat a missing timestamp as offline/sleeping. The fleet UI needs to explain
 * that missing evidence separately, so it uses this explicit state machine.
 */
function deriveDisplayState(host, now, cfg = {}) {
  if (host && (
    host.membership_state === 'retired'
    || host.membership_state === 'retired-unregistered'
    || host.membership === 'retired'
    || host.membership === 'retired-unregistered'
  )) {
    return 'retired-unregistered';
  }
  if (!host || !host.last_seen || !Number.isFinite(Date.parse(host.last_seen))) {
    return 'never-seen';
  }
  return deriveState(host, now, cfg);
}

/** Whether a derived state should raise an alert (only configured always-on outages). */
function shouldAlert(state, host = null) {
  if (host && (
    host.membership_state === 'retired'
    || host.membership_state === 'retired-unregistered'
    || host.membership === 'retired'
    || host.membership === 'retired-unregistered'
  )) return false;
  if (state === 'offline') return true;
  return state === 'never-seen'
    && host != null
    && (host.always_on === true || host.always_on === 1);
}

/** Map derived states → aggregate counts for the overview strip. */
function aggregateCounts(states) {
  const counts = { ok: 0, warn: 0, crit: 0, stale: 0 };
  for (const s of states) {
    if (s === 'online') counts.ok += 1;
    else if (s === 'stale') counts.warn += 1;
    else if (s === 'offline' || s === 'never-seen') counts.crit += 1;
    else if (s === 'sleeping') counts.stale += 1;
    // Retired/unregistered rows are historical context, not fleet members.
  }
  return counts;
}

module.exports = { deriveState, deriveDisplayState, shouldAlert, aggregateCounts, DEFAULTS };
