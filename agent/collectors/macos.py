"""
collectors/macos.py

macOS system metrics collector.

Extends base_metrics() from common.py with:
  temp_cpu_c          float   CPU temperature in °C via macmon (omitted if unavailable)
  extra.thermal_state int     machdep.xcpm.cpu_thermal_level (omitted if unavailable)
  platform            str     "mac"
  os                  str     "darwin"

Optional dependency: macmon  (`brew install macmon`)
  If macmon is not installed or fails, temp_cpu_c is simply omitted.
"""

import json
import subprocess

from collectors.common import base_metrics


def _cpu_temp_via_macmon() -> float | None:
    """
    Run `macmon --json --count 1` and extract the CPU temperature.
    Returns degrees Celsius or None if macmon is unavailable or fails.

    macmon's JSON structure (as of recent versions):
      {"cpu": {"temperature": <float>, ...}, ...}
    or
      {"cpu_temperature": <float>, ...}
    We try both layouts for resilience.
    """
    try:
        result = subprocess.run(
            ["macmon", "--json", "--count", "1"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        # macmon not installed or timed out
        return None

    if result.returncode != 0:
        return None

    # macmon may output multiple JSON lines (one per sample); take the last non-empty
    lines = [ln.strip() for ln in result.stdout.splitlines() if ln.strip()]
    if not lines:
        return None

    raw_json = lines[-1]
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError:
        return None

    # Try common key layouts
    # Layout 1: {"cpu": {"temperature": 42.5, ...}}
    cpu_block = data.get("cpu")
    if isinstance(cpu_block, dict):
        temp = cpu_block.get("temperature")
        if isinstance(temp, (int, float)):
            return round(float(temp), 1)

    # Layout 2: {"cpu_temperature": 42.5, ...}
    temp = data.get("cpu_temperature")
    if isinstance(temp, (int, float)):
        return round(float(temp), 1)

    # Layout 3: flat key scan for any *temperature* key containing "cpu"
    for key, val in data.items():
        if "cpu" in key.lower() and "temp" in key.lower():
            if isinstance(val, (int, float)):
                return round(float(val), 1)

    return None


def _thermal_state_sysctl() -> int | None:
    """
    Read machdep.xcpm.cpu_thermal_level via sysctl.
    Returns the integer level or None if unavailable (older Macs, non-XCPM).
    """
    try:
        result = subprocess.run(
            ["sysctl", "-n", "machdep.xcpm.cpu_thermal_level"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode == 0:
            return int(result.stdout.strip())
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
        pass
    return None


def collect() -> dict:
    """Collect macOS system metrics."""
    payload = base_metrics()
    payload["os"] = "darwin"
    payload["platform"] = "mac"

    # CPU temperature (optional — requires macmon)
    temp = _cpu_temp_via_macmon()
    if temp is not None:
        payload["temp_cpu_c"] = temp

    # Thermal throttle level (optional — best-effort, omit if unavailable)
    thermal_state = _thermal_state_sysctl()
    if thermal_state is not None:
        payload.setdefault("extra", {})["thermal_state"] = thermal_state

    return payload
