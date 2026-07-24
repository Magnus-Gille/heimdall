'use strict';

/**
 * thermal.js — Linux sysfs thermal-zone discovery (issue #5).
 *
 * `/sys/class/thermal/thermal_zone<N>/` is enumerated by the kernel at boot in
 * whatever order the relevant drivers probe, so `<N>` is NOT a stable
 * identifier — it can differ across reboots, kernel updates, or hardware
 * revisions of the "same" board. Each zone does carry a stable, driver-declared
 * `type` string (e.g. `cpu-thermal` on a Raspberry Pi, `x86_pkg_temp` on
 * Intel). Selection MUST key on `type`, never on the zone index.
 *
 * This module enumerates zones from an (injectable, for tests) sysfs root and
 * selects the CPU/SoC temperature by matching declared type against the
 * configurable priority list in `src/config/thermal-zone-types.js`.
 *
 * Failure modes are represented explicitly rather than coerced to a reading:
 *   - missing sysfs tree (no `/sys/class/thermal` at all)              -> unknown, reason 'sysfs-missing'
 *   - zone directory unreadable (EACCES/EIO on readdir)                -> unknown, reason 'sysfs-unreadable'
 *   - no zone matches any configured type                              -> unknown, reason 'no-matching-zone'
 *   - the matched zone's `type` or `temp` file is unreadable (EACCES/EIO) -> unknown, reason 'zone-unreadable'
 *   - the matched zone's `temp` file has non-numeric content            -> unknown, reason 'zone-malformed'
 * In every case `value` is `null` — never `0` — so "unknown" can never be
 * rendered as a healthy reading (the rule adopted in issue #6).
 */

const fs = require('fs');
const path = require('path');
const { CPU_TEMP_ZONE_TYPES } = require('./config/thermal-zone-types');

const DEFAULT_SYSFS_THERMAL_ROOT = '/sys/class/thermal';
const ZONE_DIR_RE = /^thermal_zone\d+$/;

/**
 * Parse a sysfs `temp` file's raw content (millidegrees Celsius, as a bare
 * integer — optionally negative). Returns degrees Celsius rounded to 1
 * decimal, or `null` if the content is not a plain integer (malformed).
 */
function parseTempMillideg(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Math.round((Number(trimmed) / 1000) * 10) / 10;
}

/**
 * Enumerate thermal zones under `root` (default `/sys/class/thermal`).
 *
 * Returns `{ missing: true }` if the root itself does not exist or cannot be
 * listed (ENOENT/EACCES/ENOTDIR on readdir) — a host with no thermal sysfs
 * tree at all (e.g. a container, or a non-Linux dev box).
 *
 * Otherwise returns `{ missing: false, zones }` where each zone is
 * `{ index, type, tempC, error }`:
 *   - `type` is the trimmed contents of `type`, or `null` if unreadable.
 *   - `tempC` is the parsed temperature, or `null` if the file is unreadable
 *     or its content is malformed.
 *   - `error` is `null`, `'type-unreadable'`, `'temp-unreadable'`, or
 *     `'temp-malformed'` (first applicable) — purely diagnostic; callers
 *     should branch on `type`/`tempC` being `null`, not on this string.
 * A single bad zone never throws — it is reported in-place so a dynamically
 * reordered or partially-broken zone list still yields the other zones.
 */
function listThermalZones(root = DEFAULT_SYSFS_THERMAL_ROOT) {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { missing: true, zones: [] };
  }

  const zones = [];
  for (const entry of entries) {
    if (!ZONE_DIR_RE.test(entry)) continue;
    const index = Number(entry.slice('thermal_zone'.length));
    const zoneDir = path.join(root, entry);

    let type = null;
    let error = null;
    try {
      type = fs.readFileSync(path.join(zoneDir, 'type'), 'utf8').trim();
    } catch {
      error = 'type-unreadable';
    }

    let tempC = null;
    try {
      const raw = fs.readFileSync(path.join(zoneDir, 'temp'), 'utf8');
      tempC = parseTempMillideg(raw);
      if (tempC === null) error = error || 'temp-malformed';
    } catch {
      error = error || 'temp-unreadable';
    }

    zones.push({ index, type, tempC, error });
  }

  return { missing: false, zones };
}

/**
 * Select the CPU/SoC temperature from already-enumerated `zones` (as returned
 * by `listThermalZones`/`parseZoneEnumerateOutput`) using `priorityTypes`
 * (highest preference first; defaults to the configured
 * `CPU_TEMP_ZONE_TYPES`).
 *
 * For each priority type, in order: if a zone with that `type` exists, use
 * it — either returning its reading (`status: 'ok'`) or, if that specific
 * zone is unreadable/malformed, returning unknown WITHOUT falling through to
 * a lower-priority type (a different sensor is not a substitute for the
 * chosen one; silently swapping it in would mislabel it as CPU temp). Only
 * when no zone at all declares a given type does selection move on to the
 * next priority type.
 *
 * Returns `{ value, status, reason, zoneType, zoneIndex }`. `value` is
 * `null` whenever `status !== 'ok'`.
 */
function selectCpuTempC(zones, priorityTypes = CPU_TEMP_ZONE_TYPES) {
  for (const wantType of priorityTypes) {
    const zone = zones.find((z) => z.type === wantType);
    if (!zone) continue; // no zone declares this type — try the next preference

    if (zone.tempC !== null) {
      return { value: zone.tempC, status: 'ok', reason: null, zoneType: zone.type, zoneIndex: zone.index ?? null };
    }
    return {
      value: null,
      status: 'unknown',
      reason: zone.error === 'temp-malformed' ? 'zone-malformed' : 'zone-unreadable',
      zoneType: zone.type,
      zoneIndex: zone.index ?? null,
    };
  }

  return {
    value: null,
    status: 'unknown',
    reason: zones.length === 0 ? 'no-zones' : 'no-matching-zone',
    zoneType: null,
    zoneIndex: null,
  };
}

/**
 * Convenience: discover + select in one call for a local sysfs root.
 */
function readCpuTempC(root = DEFAULT_SYSFS_THERMAL_ROOT, priorityTypes = CPU_TEMP_ZONE_TYPES) {
  const { missing, zones } = listThermalZones(root);
  if (missing) {
    return { value: null, status: 'unknown', reason: 'sysfs-missing', zoneType: null, zoneIndex: null };
  }
  return selectCpuTempC(zones, priorityTypes);
}

// ─── Remote (SSH) enumeration ─────────────────────────────────────────────
//
// `control-node` reads sysfs directly (above). `nas` is probed over SSH, so
// enumeration has to happen as a shell snippet on the remote host; the output
// is parsed here into the same zone shape so `selectCpuTempC` is shared by
// both paths. One line per zone: `<type>\t<raw temp>` (either side may be
// empty when unreadable). No output at all (missing tree, or a tree with no
// thermal_zone* entries) is a legitimate, non-error "no zones" result — the
// loop below never fails the surrounding script.

function buildZoneEnumerateShellSnippet(root = DEFAULT_SYSFS_THERMAL_ROOT) {
  return `for z in ${root}/thermal_zone*/; do [ -d "$z" ] || continue; printf "%s\\t%s\\n" "$(cat "\${z}type" 2>/dev/null)" "$(cat "\${z}temp" 2>/dev/null)"; done`;
}

function parseZoneEnumerateOutput(text) {
  const zones = [];
  const lines = String(text ?? '').split('\n');
  let index = 0;
  for (const line of lines) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    const rawType = tab === -1 ? line : line.slice(0, tab);
    const rawTemp = tab === -1 ? '' : line.slice(tab + 1);
    const type = rawType.trim() === '' ? null : rawType.trim();
    const tempC = parseTempMillideg(rawTemp);
    zones.push({
      index,
      type,
      tempC,
      error: type === null ? 'type-unreadable' : (tempC === null ? 'temp-unreadable-or-malformed' : null),
    });
    index += 1;
  }
  return zones;
}

module.exports = {
  DEFAULT_SYSFS_THERMAL_ROOT,
  parseTempMillideg,
  listThermalZones,
  selectCpuTempC,
  readCpuTempC,
  buildZoneEnumerateShellSnippet,
  parseZoneEnumerateOutput,
};
