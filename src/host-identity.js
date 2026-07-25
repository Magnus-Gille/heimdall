'use strict';

/**
 * host-identity.js — one machine, one identity.
 *
 * The live instance ran the same Pi 5 under two host ids: Heimdall's own
 * collectors write `control-node`, while Grimnir's services.json declares
 * `host: "huginmunin.local"` (so every service_versions row and every deploy
 * alert landed on `huginmunin`) and the fleet push agent used to report
 * `huginmunin` as well. Metric series and alerts split across the two and could
 * never meet: an alert raised against `huginmunin` was never re-evaluated,
 * because nothing writes that host any more.
 *
 * The alias table lives in the config overlay (`fleet.host_aliases`) so a rename
 * is a config edit rather than a code change, and so Heimdall never has to edit
 * another repository's registry to agree with it.
 */

const MAX_ALIAS_HOPS = 4;

/** Normalize a host id for matching: trimmed, lowercased, no `.local` suffix. */
function normalizeHostKey(host) {
  if (typeof host !== 'string') return host;
  return host.trim().replace(/\.local$/i, '').toLowerCase();
}

/**
 * Resolve a host id to its canonical identity.
 *
 * Non-strings pass through untouched. Unaliased hosts keep their (suffix-stripped)
 * name. Alias chains are followed a bounded number of hops so a mis-configured
 * cycle degrades to a stable answer instead of hanging.
 */
function canonicalHost(host, aliases) {
  if (typeof host !== 'string') return host;
  let current = normalizeHostKey(host);
  if (!aliases || typeof aliases !== 'object') return current;
  const seen = new Set([current]);
  for (let i = 0; i < MAX_ALIAS_HOPS; i++) {
    const next = aliases[current];
    if (typeof next !== 'string' || !next) break;
    const key = normalizeHostKey(next);
    if (seen.has(key)) break; // cycle — stop at the last stable value
    seen.add(key);
    current = key;
  }
  return current;
}

/**
 * Read `fleet.host_aliases` out of a parsed heimdall.config.json. Keys are
 * normalized so `HuginMunin.local` and `huginmunin` both match.
 */
function loadHostAliases(config) {
  const raw = config && config.fleet && config.fleet.host_aliases;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [from, to] of Object.entries(raw)) {
    if (typeof to !== 'string' || !to) continue;
    out[normalizeHostKey(from)] = normalizeHostKey(to);
  }
  return out;
}

module.exports = { canonicalHost, loadHostAliases, normalizeHostKey };
