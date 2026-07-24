'use strict';

/**
 * thermal-zone-types.js — Configurable sysfs thermal-zone type priority.
 *
 * Linux exposes thermal zones under `/sys/class/thermal/thermal_zone<N>/`, each
 * with a `type` file (a driver-declared string like `cpu-thermal` or
 * `x86_pkg_temp`) and a `temp` file (millidegrees Celsius). The `<N>` index is
 * NOT a stable identifier — it is assignment order at boot, and can change
 * across reboots or kernel/driver updates (issue #5). Zone selection MUST key
 * on the declared `type`, never on the zone index.
 *
 * This file is the RUNTIME source of truth for "which zone type represents the
 * primary CPU/SoC temperature" on the hosts Heimdall reads sysfs on directly
 * (control-node and nas — see src/thermal.js). It is intentionally a plain
 * priority list rather than a single constant so a host with several zones
 * (e.g. an x86 box exposing both `x86_pkg_temp` and an `acpitz` fallback)
 * still picks a sensible one, and so a newly observed platform can be
 * supported by adding an entry here instead of editing collection logic.
 *
 * Ownership: this list is owned by this file (reviewed with it); callers must
 * not hard-code zone types or indices of their own.
 */

// Ordered highest-to-lowest preference. The first zone whose `type` matches an
// entry here (in enumeration order in case of ties) is used as temp_cpu_c.
const CPU_TEMP_ZONE_TYPES = [
  'cpu-thermal', // Raspberry Pi (bcm2835_thermal / rpi thermal driver) — all models
  'x86_pkg_temp', // Intel package thermal zone (coretemp driver)
  'k10temp', // AMD CPU thermal zone
  'soc_thermal', // Generic SoC thermal zone (some ARM boards)
  'acpitz', // Generic ACPI thermal zone — last resort on x86 when no vendor zone exists
];

module.exports = {
  CPU_TEMP_ZONE_TYPES,
};
