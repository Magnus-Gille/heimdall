"""
collectors/linux.py

Linux (including Raspberry Pi) system metrics collector.

Extends base_metrics() from common.py with:
  temp_cpu_c   float   CPU temperature in °C (omitted if unreadable)
  platform     str     "pi5" | "pi-zero" | "linux"
  os           str     "linux"
"""

from collectors.common import base_metrics


# Thermal zone sysfs paths to try, in order
_THERMAL_ZONES = [
    "/sys/class/thermal/thermal_zone0/temp",
    "/sys/class/thermal/thermal_zone1/temp",
    "/sys/class/thermal/thermal_zone2/temp",
]

# Device tree model paths to try
_DT_MODEL_PATHS = [
    "/proc/device-tree/model",
    "/sys/firmware/devicetree/base/model",
]


def _read_cpu_temp() -> float | None:
    """
    Read CPU temperature from sysfs thermal zones.
    Returns degrees Celsius or None if no zone is readable.
    Values are stored in millidegrees — divide by 1000.
    """
    for path in _THERMAL_ZONES:
        try:
            with open(path) as fh:
                raw = fh.read().strip()
            return round(int(raw) / 1000.0, 1)
        except (OSError, ValueError):
            continue
    return None


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
