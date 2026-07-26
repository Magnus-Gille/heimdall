"""
Heimdall Fleet Push Agent — entrypoint.

Loads config from config.env (next to this file) then environment overrides,
detects platform, and loops: collect → POST → sleep(INTERVAL).

CLI:
    python3 core.py          # continuous loop
    python3 core.py --once   # collect+post once, print status, exit non-zero on failure
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """
    Read KEY=VALUE pairs from config.env (located next to core.py), then
    override with real environment variables.  Blank lines and # comments
    are ignored; surrounding quotes on values are stripped.
    """
    cfg: dict = {}

    config_path = Path(__file__).parent / "config.env"
    if config_path.exists():
        with config_path.open() as fh:
            for raw_line in fh:
                line = raw_line.strip()
                # Skip blank lines and comments
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                # Strip surrounding single or double quotes
                if len(value) >= 2 and value[0] in ('"', "'") and value[-1] == value[0]:
                    value = value[1:-1]
                cfg[key] = value

    # Real environment variables take precedence over the file
    for key in ("HUB_URL", "FLEET_TOKEN", "INTERVAL", "HOSTNAME", "CAPABILITY_CONTRACT_JSON"):
        env_val = os.environ.get(key)
        if env_val is not None:
            cfg[key] = env_val

    return cfg


def parse_interval(raw, default: int = 30, lo: int = 5, hi: int = 3600) -> int:
    """
    Parse the push INTERVAL robustly. Tolerates inline comments
    (e.g. "30  # seconds"), rejects zero/negative/malformed values (which would
    hot-loop or crash time.sleep), and clamps to [lo, hi]. Falls back to default.
    """
    try:
        token = str(raw).split("#")[0].strip().split()[0]
        val = int(token)
    except (ValueError, IndexError):
        return default
    if val < lo:
        return lo
    if val > hi:
        return hi
    return val


def attach_capability_contract(payload: dict, raw: str | None) -> dict:
    """Attach an optional, overlay-supplied v1 capability envelope.

    This keeps the shipped agent compatible with older Heimdall deployments:
    absent configuration leaves the legacy payload byte-for-byte equivalent.
    """
    if not raw:
        return payload
    try:
        contract = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("CAPABILITY_CONTRACT_JSON must be valid JSON") from exc
    if not isinstance(contract, dict):
        raise ValueError("CAPABILITY_CONTRACT_JSON must be a JSON object")
    payload["capability_contract"] = contract
    return payload


# ---------------------------------------------------------------------------
# HTTP POST
# ---------------------------------------------------------------------------

def heartbeat_path() -> Path:
    """Return the local push-heartbeat path consumed by Brokkr's watchdog."""
    state_home = os.environ.get("XDG_STATE_HOME")
    if not state_home:
        home = os.environ.get("HOME")
        if not home:
            raise RuntimeError("cannot resolve heartbeat path: HOME is unset")
        state_home = str(Path(home) / ".local" / "state")
    return Path(state_home) / "heimdall-agent" / "last-push"


def touch_heartbeat() -> None:
    """Create or refresh the successful-push heartbeat with private permissions."""
    path = heartbeat_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    path.touch(mode=0o600, exist_ok=True)


def post_payload(payload: dict, hub_url: str, token: str = "") -> tuple[int, str]:
    """
    POST *payload* as JSON to *hub_url*.
    Adds Authorization: Bearer <token> only when token is non-empty.
    Returns (http_status_code, response_body_text).
    """
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(hub_url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        # HTTPError is a valid response — extract status + body
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return exc.code, err_body
    # URLError (network unreachable, DNS failure, etc.) propagates to caller


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Heimdall fleet push agent")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Collect and POST once, print HTTP status + body, then exit.",
    )
    args = parser.parse_args()

    cfg = load_config()
    hub_url: str = cfg.get("HUB_URL", "")
    token: str = cfg.get("FLEET_TOKEN", "")
    interval: int = parse_interval(cfg.get("INTERVAL", "30"))

    # Import here so the collectors package resolves relative to agent/
    from collectors import collect  # noqa: PLC0415

    if not hub_url:
        print("WARNING: HUB_URL is not configured — POSTs will fail.", file=sys.stderr)

    # Seed the watchdog signal before any collection or network operation. A
    # later refresh means a push succeeded; failures intentionally leave it stale.
    touch_heartbeat()

    # --once: single shot
    if args.once:
        try:
            payload = attach_capability_contract(collect(cfg), cfg.get("CAPABILITY_CONTRACT_JSON"))
        except Exception as exc:
            print(f"collect error: {exc}", file=sys.stderr)
            sys.exit(1)

        try:
            status, body = post_payload(payload, hub_url, token)
        except Exception as exc:
            print(f"POST error: {exc}", file=sys.stderr)
            sys.exit(1)

        print(f"{status} {body}")
        if not (200 <= status < 300):
            sys.exit(1)
        touch_heartbeat()
        return

    # Continuous loop
    while True:
        try:
            payload = attach_capability_contract(collect(cfg), cfg.get("CAPABILITY_CONTRACT_JSON"))
            status, body = post_payload(payload, hub_url, token)
            if not (200 <= status < 300):
                print(f"POST failed {status}: {body}", file=sys.stderr)
            else:
                touch_heartbeat()
        except Exception as exc:
            print(f"error: {exc}", file=sys.stderr)
        time.sleep(interval)


if __name__ == "__main__":
    main()
