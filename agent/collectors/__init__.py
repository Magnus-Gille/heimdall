"""
collectors/__init__.py

Detects the current platform and dispatches to the appropriate collector
module, then stamps the payload with a UTC timestamp, hostname, and the
running agent version (git short SHA or VERSION file written by the deploy
script).
"""

import os
import platform
import socket
import subprocess
from datetime import datetime, timezone

# Path to the VERSION file written by deploy-agent.sh.  Module-level so tests
# can monkeypatch it without touching the real filesystem.
_AGENT_VERSION_FILE: str = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "VERSION"
)


def _agent_version() -> str:
    """
    Return a short identifier for the running agent code.  Never raises.

    Source priority:
      1. agent/VERSION file — written by deploy-agent.sh with the git short SHA.
      2. git rev-parse --short HEAD — works in a live checkout (dev / CI).
      3. "unknown" — when neither is available.
    """
    # (a) VERSION file — tolerate a corrupted/non-text file (UnicodeError) too, so
    # this best-effort helper never raises and breaks payload collection.
    try:
        with open(_AGENT_VERSION_FILE) as fh:
            v = fh.read().strip()
            if v:
                return v
    except (OSError, UnicodeError):
        pass

    # (b) git
    try:
        agent_dir = os.path.dirname(os.path.abspath(_AGENT_VERSION_FILE))
        proc = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=agent_dir,
        )
        if proc.returncode == 0:
            v = proc.stdout.strip()
            if v:
                return v
    except Exception:  # noqa: BLE001
        pass

    # (c) unknown
    return "unknown"


def collect(cfg: dict | None = None) -> dict:
    """
    Collect system metrics for this host.

    Platform dispatch:
      Darwin                          → macos collector
      /etc/nv_tegra_release present   → jetson collector (NVIDIA Jetson)
      anything else                   → linux collector

    Always adds:
      ts        ISO-8601 UTC string with trailing Z
      hostname  from HOSTNAME env var (or cfg["HOSTNAME"]) or socket.gethostname()
    """
    if cfg is None:
        cfg = {}

    # --- Platform detection ---
    system = platform.system()
    if system == "Darwin":
        from collectors.macos import collect as _collect  # noqa: PLC0415
    elif os.path.exists("/etc/nv_tegra_release"):
        from collectors.jetson import collect as _collect  # noqa: PLC0415
    else:
        from collectors.linux import collect as _collect  # noqa: PLC0415

    payload = _collect()

    # --- Timestamp (UTC, ISO-8601 with trailing Z) ---
    payload["ts"] = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # --- Hostname: cfg > HOSTNAME env var > socket ---
    hostname = (
        cfg.get("HOSTNAME")
        or os.environ.get("HOSTNAME")
        or socket.gethostname()
    )
    payload["hostname"] = hostname

    # --- Agent version (git SHA or VERSION file written by deploy-agent.sh) ---
    payload["agent_version"] = _agent_version()

    return payload
