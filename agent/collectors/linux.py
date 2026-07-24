"""
collectors/linux.py

Linux (including Raspberry Pi) system metrics collector.

Extends base_metrics() from common.py with:
  temp_cpu_c   float   CPU temperature in °C (omitted if unresolvable)
  platform     str     "pi5" | "pi-zero" | "linux"
  os           str     "linux"

CPU temperature is discovered from sysfs thermal zones (issue #5) rather than
assumed to live at a fixed `thermal_zoneN` index -- that index is boot-order
assignment, not a stable identifier, and can change across reboots, kernel
updates, or hardware revisions. Each zone's declared `type` file IS stable,
so selection keys on that via the configurable priority list in
collectors/thermal_zone_types.py. See _list_thermal_zones/_select_cpu_temp
below; temp_cpu_c is simply omitted from the payload (never reported as 0)
when nothing resolves.
"""

import os
import re

from collectors.common import base_metrics
from collectors.thermal_zone_types import CPU_TEMP_ZONE_TYPES

# Root of the sysfs thermal-zone tree. A parameter (not a hard-coded literal
# inside the functions below) so tests can point it at a fixture directory --
# this also makes the module importable/testable on non-Linux dev machines.
DEFAULT_THERMAL_SYSFS_ROOT = "/sys/class/thermal"

_ZONE_DIR_RE = re.compile(r"thermal_zone\d+")

# Device tree model paths to try
_DT_MODEL_PATHS = [
    "/proc/device-tree/model",
    "/sys/firmware/devicetree/base/model",
]


def _list_thermal_zones(root: str = DEFAULT_THERMAL_SYSFS_ROOT) -> list[dict]:
    """
    Enumerate thermal zones under `root` by globbing `thermal_zone*` entries.

    Returns a list of {"type": str|None, "temp_c": float|None} dicts, one per
    zone found. A missing root (no thermal sysfs tree at all -- e.g. a
    container or non-Linux host), an unreadable zone file (EACCES/EIO), or a
    malformed `temp` value never raises: the affected zone's field simply
    stays None so one bad zone doesn't prevent discovering the others. Zone
    index is deliberately NOT part of the returned dict -- selection must
    never depend on it.
    """
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return []

    zones = []
    for entry in entries:
        if not _ZONE_DIR_RE.fullmatch(entry):
            continue
        zone_dir = os.path.join(root, entry)

        zone_type = None
        try:
            with open(os.path.join(zone_dir, "type")) as fh:
                zone_type = fh.read().strip() or None
        except OSError:
            pass

        temp_c = None
        try:
            with open(os.path.join(zone_dir, "temp")) as fh:
                raw = fh.read().strip()
            temp_c = round(int(raw) / 1000.0, 1)
        except (OSError, ValueError):
            pass

        zones.append({"type": zone_type, "temp_c": temp_c})

    return zones


def _select_cpu_temp(zones: list[dict], priority_types=CPU_TEMP_ZONE_TYPES) -> float | None:
    """
    Select the CPU/SoC temperature from enumerated `zones` by declared type.

    For each priority type, in order: if some zone declares that type, its
    reading is used -- either the parsed value, or None if that specific
    zone's `type`/`temp` file was unreadable or malformed. Selection does
    NOT fall through to a different sensor in that case: a different zone
    reading is not a substitute for the chosen sensor, and silently
    swapping it in would mislabel it as CPU temperature. Only when no zone
    at all declares a given type does the next priority type get tried.

    Returns None ("unknown") when nothing resolves -- never 0, so a missing
    or broken reading can never be rendered as a healthy temperature.
    """
    for want_type in priority_types:
        zone = next((z for z in zones if z["type"] == want_type), None)
        if zone is None:
            continue
        return zone["temp_c"]
    return None


def _read_cpu_temp(root: str = DEFAULT_THERMAL_SYSFS_ROOT) -> float | None:
    """
    Read CPU temperature from sysfs thermal zones, keyed on each zone's
    declared type (see module docstring). Returns degrees Celsius, or None
    if the sysfs tree is missing, no zone matches a configured type, or the
    matched zone is unreadable/malformed.
    """
    return _select_cpu_temp(_list_thermal_zones(root))


def _detect_pi_platform() -> str | None:
    """
    Detect Raspberry Pi variant from the device-tree model string.
    Returns "pi5", "pi-zero", or None if not a Pi.
    """
    for path in _DT_MODEL_PATHS:
        try:
            with open(path, "rb") as fh:
                # Model string may be null-terminated
                model = fh.read().rstrip(b"\x00").decode("utf-8", errors="replace").lower()
            if "raspberry pi" in model:
                if "zero" in model:
                    return "pi-zero"
                if "5" in model:
                    return "pi5"
                # Generic Pi — return a reasonable label
                return "pi"
        except OSError:
            continue
    return None


def collect() -> dict:
    """Collect Linux system metrics."""
    payload = base_metrics()
    payload["os"] = "linux"

    # Platform label (Pi variant or plain linux)
    pi_label = _detect_pi_platform()
    payload["platform"] = pi_label if pi_label else "linux"

    # CPU temperature (best-effort)
    temp = _read_cpu_temp()
    if temp is not None:
        payload["temp_cpu_c"] = temp

    return payload
