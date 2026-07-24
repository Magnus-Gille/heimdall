"""
collectors/thermal_zone_types.py

Configurable sysfs thermal-zone type priority for the Linux fleet-push
collector (collectors/linux.py).

Linux exposes thermal zones under `/sys/class/thermal/thermal_zone<N>/`, each
with a `type` file (a driver-declared string like `cpu-thermal` or
`x86_pkg_temp`) and a `temp` file (millidegrees Celsius). The `<N>` index is
NOT a stable identifier -- it is boot-order assignment and can change across
reboots, kernel updates, or hardware revisions (issue #5). Zone selection
MUST key on the declared `type`, never on the zone index.

This is the RUNTIME source of truth for "which zone type represents the
primary CPU/SoC temperature" on the Linux hosts the push agent runs on
(Raspberry Pi, x86, and other Linux fleet members). It mirrors the Node-side
mapping in src/config/thermal-zone-types.js (used by the control-node/nas
sysfs+SSH paths in src/thermal.js) -- the two are reviewed together but kept
as separate files because the two collectors ship independently.

Ownership: this list is owned by this file (reviewed with it); callers must
not hard-code zone types or indices of their own.
"""

# Ordered highest-to-lowest preference. The first zone whose `type` matches an
# entry here (in enumeration order in case of ties) is used as temp_cpu_c.
CPU_TEMP_ZONE_TYPES = [
    "cpu-thermal",  # Raspberry Pi (bcm2835_thermal / rpi thermal driver) -- all models
    "x86_pkg_temp",  # Intel package thermal zone (coretemp driver)
    "k10temp",  # AMD CPU thermal zone
    "soc_thermal",  # Generic SoC thermal zone (some ARM boards)
    "acpitz",  # Generic ACPI thermal zone -- last resort on x86 when no vendor zone exists
]
