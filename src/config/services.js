'use strict';

/**
 * config/services.js — the authoritative polled-service list (#92).
 *
 * Grimnir's `services.json` is the single source of truth for the component
 * inventory (name/host/port/systemd_units). Heimdall derives its service list
 * FROM that file so a unit rename/add/remove flows through without a manual
 * edit to `heimdall.config.json`. Heimdall's own `services` array becomes an
 * *overlay*: it supplies probe-specific details (health_url paths, tailnet IPs,
 * ssh_host) and additive entries that grimnir doesn't know about, and it wins on
 * conflict. When grimnir's file can't be read, the overlay list is returned
 * verbatim — a drift-prone but safe fallback that preserves prior behavior.
 *
 * Merge rules:
 *   - base (grimnir) drives WHICH services exist.
 *   - an overlay entry matched by name enriches its base entry (this is how
 *     heimdall pins health_url/ssh_host), but cannot replace registry-owned
 *     identity/deployment fields.
 *   - an overlay entry NOT matched to base is DROPPED (assumed stale after a
 *     rename) unless it carries `additive: true` (then appended verbatim).
 *   - `monitor: false` on an overlay entry excludes that name entirely.
 */

const fs = require('fs');
const path = require('path');
const { canonicalHost, loadHostAliases } = require('../host-identity');

const CONFIG_PATH = process.env.HEIMDALL_CONFIG_PATH
  || path.join(__dirname, '..', '..', 'heimdall.config.json');

// The host Heimdall itself runs on — services here get localhost health URLs.
const HEIMDALL_HOST = process.env.HEIMDALL_LOCAL_HOST_ID || 'control-node';

/** Candidate locations for grimnir services.json; first readable wins. */
function grimnirCandidates() {
  const out = [];
  if (process.env.GRIMNIR_SERVICES_JSON) out.push(process.env.GRIMNIR_SERVICES_JSON);
  out.push('/opt/grimnir/services.json'); // conventional service deploy path
  out.push(path.join(__dirname, '..', '..', '..', 'grimnir', 'services.json')); // sibling checkout (dev)
  return out;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Normalize a registry host id to Heimdall's canonical identity.
 *
 * Grimnir's services.json declares `host: "huginmunin.local"` for the box
 * Heimdall itself runs on and calls `control-node`. Left alone, that split every
 * service_versions row and every deploy alert onto a host identity no collector
 * writes any more — so those alerts could never be re-evaluated or resolved.
 * `fleet.host_aliases` in the config overlay reconciles the two names here,
 * without Heimdall having to edit another repository's registry.
 */
function stripHost(host, aliases) {
  if (typeof host !== 'string') return host;
  return canonicalHost(host, aliases);
}

/** Drop undefined keys so merged entries stay clean. */
function clean(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Strip overlay-only bookkeeping fields from a runtime service entry. */
function stripMeta(o) {
  const { additive, monitor, ...rest } = o;
  return rest;
}

/** The parsed config overlay object (or null). */
function loadConfig(configPath = CONFIG_PATH) {
  return readJson(configPath);
}

/** The overlay/fallback `services` array from heimdall.config.json. */
function loadOverlay(configPath = CONFIG_PATH) {
  const cfg = loadConfig(configPath);
  const arr = cfg && Array.isArray(cfg.services) ? cfg.services : [];
  // Defend against a hand-edit mistake: a null / non-object / nameless entry
  // would otherwise throw on `o.name` and take out the whole registry.
  return arr.filter((o) => o && typeof o === 'object' && typeof o.name === 'string' && o.name.length > 0);
}

/** Read grimnir services.json from the first readable candidate, or null. */
function loadGrimnir(candidates = grimnirCandidates()) {
  for (const p of candidates) {
    if (!p) continue;
    const j = readJson(p);
    if (j && Array.isArray(j.components)) return j;
  }
  return null;
}

/** Derive base service entries from grimnir components (one per systemd unit). */
function deriveBaseServices(grimnir, aliases = {}) {
  const base = [];
  for (const c of (grimnir && grimnir.components) || []) {
    const host = stripHost(c.host, aliases);
    const repo = c.repo ? `Magnus-Gille/${c.repo}` : undefined;
    const units = Array.isArray(c.systemd_units) ? c.systemd_units : [];
    // A component usually has one service unit whose name equals the component
    // name; keep c.name then so the overlay keys by component name. But if a
    // component has *multiple* service units, each must keep its own unit name
    // or they collapse onto one snapshot PK (service_snapshots.service).
    const serviceUnitCount = units.filter((u) => u && u.type === 'service').length;
    for (const u of units) {
      if (!u || !u.name) continue;
      if (u.type === 'timer') {
        base.push(clean({ name: u.name, host, type: 'timer', repo, systemd_unit: u.name, deploy_path: c.deploy_path }));
      } else if (u.type === 'service') {
        const name = serviceUnitCount > 1 ? u.name : c.name;
        const health_url = c.port != null
          ? (host === HEIMDALL_HOST ? `http://localhost:${c.port}/health` : `http://${host}:${c.port}/health`)
          : undefined;
        base.push(clean({ name, host, health_url, repo, systemd_unit: u.name, deploy_path: c.deploy_path }));
      }
    }
  }
  return base;
}

/**
 * The merged, authoritative service list. Options (all optional; used by tests):
 *   configPath  — override the heimdall.config.json overlay path
 *   grimnirPath — override the grimnir services.json path (single candidate)
 *   logger      — where dropped-entry warnings go (default: console)
 */
function loadServicesWithMeta({ configPath, grimnirPath, logger = console } = {}) {
  const overlay = loadOverlay(configPath);
  const aliases = loadHostAliases(loadConfig(configPath));
  const grimnir = loadGrimnir(grimnirPath ? [grimnirPath] : undefined);

  // Fallback: no source of truth available → the overlay list, verbatim. Callers
  // use `source` to avoid pruning grimnir-derived rows while running degraded.
  if (!grimnir) {
    return {
      source: 'fallback',
      services: overlay
        .filter((o) => o.monitor !== false)
        .map((o) => clean({ ...stripMeta(o), host: stripHost(o.host, aliases) })),
    };
  }

  const base = deriveBaseServices(grimnir, aliases);
  // Match overlay↔base by a normalized key so a case/whitespace difference
  // doesn't silently drop the overlay's pinned probe details as "stale".
  const key = (n) => String(n == null ? '' : n).trim().toLowerCase();
  const overlayByName = new Map(overlay.map((o) => [key(o.name), o]));
  const out = [];
  const emitted = new Set();

  for (const b of base) {
    const o = overlayByName.get(key(b.name));
    if (o && o.monitor === false) { emitted.add(key(b.name)); continue; } // opted out
    // Overlay wins on probe/UI fields, but Grimnir owns identity/deployment
    // facts. Reassert all six authoritative fields after enrichment so stale
    // duplicated config cannot redirect drift checks to the wrong host/path.
    out.push(o ? clean({
      ...b,
      ...stripMeta(o),
      name: b.name,
      host: b.host,
      repo: b.repo,
      deploy_path: b.deploy_path,
      systemd_unit: b.systemd_unit,
      type: b.type,
    }) : b);
    emitted.add(key(b.name));
  }

  const dropped = [];
  for (const o of overlay) {
    if (emitted.has(key(o.name))) continue;
    if (o.monitor === false) continue;
    // Mark as emitted so a second overlay entry with the same normalized key
    // can't be appended twice (duplicate snapshot PK).
    emitted.add(key(o.name));
    if (o.additive) { out.push(clean({ ...stripMeta(o), host: stripHost(o.host, aliases) })); continue; }
    dropped.push(o.name); // unmatched + not additive → stale after a rename
  }
  if (dropped.length && logger && typeof logger.warn === 'function') {
    logger.warn(`[config] dropped ${dropped.length} overlay service(s) absent from grimnir services.json and not marked additive: ${dropped.join(', ')}`);
  }

  return { source: 'grimnir', services: out };
}

/** The merged service list (array). See loadServicesWithMeta for the options + source. */
function loadServices(opts = {}) {
  return loadServicesWithMeta(opts).services;
}

module.exports = {
  loadServices, loadServicesWithMeta, deriveBaseServices, loadOverlay, loadGrimnir, loadConfig, stripHost,
};
