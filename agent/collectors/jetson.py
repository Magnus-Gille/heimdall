"""
collectors/jetson.py

NVIDIA Jetson system metrics collector.

Prefers jtop (from jetson-stats) for rich GPU/thermal/power data.
Falls back to the linux collector if jtop is unavailable.

Optional dependency: pip install jetson-stats
  If unavailable the module gracefully delegates to linux.collect().

Adds (when jtop is available):
  temp_cpu_c   float   CPU temperature in °C
  extra        dict    May contain: temp_gpu_c, gpu_pct, power_mw
  platform     str     "jetson"
  os           str     "linux"

jtop circuit-breaker
--------------------
jtop's context manager can block indefinitely in __enter__ when the
jetson-stats daemon is unhealthy.  A blocked call never raises, so a plain
try/except can't catch it — it wedges the agent and the host silently goes
offline.  Two safeguards work together:

  1. Hard timeout (daemon thread + _JTOP_TIMEOUT_S):  every jtop attempt
     runs in a daemon thread; if it doesn't return within the timeout the
     thread is abandoned and collect() returns the linux fallback immediately.

  2. Inflight lock (_jtop_inflight):  once a thread wedges, later cycles
     detect the held lock and skip straight to the fallback without spawning
     another thread.  Without this, each cycle leaks one thread.

  3. Cooldown + auto-recovery:  a permanently-held lock meant the agent
     served linux-fallback-only until the process was restarted.  Now the
     breaker uses an exponential cooldown (_jtop_cooldown_s, starting at
     _JTOP_COOLDOWN_BASE_S and doubling on each consecutive wedge up to
     _JTOP_COOLDOWN_MAX_S).  When the cooldown expires, collect() abandons
     the old wedged thread (accepting ≤1 leaked daemon thread per cooldown
     period) and retries jtop.  A successful jtop call resets the cooldown
     to base and clears the wedge marker — so the breaker fully recovers
     once jtop.service is healthy again.
"""

import sys
import threading
import time

from collectors.common import base_metrics

_JTOP_TIMEOUT_S = 10.0

# Circuit-breaker cooldown constants.
_JTOP_COOLDOWN_BASE_S: float = 300.0   # 5 min initial cooldown after first wedge
_JTOP_COOLDOWN_MAX_S: float = 3600.0   # 1 hr cap — max one leaked thread/hour

# Mutable circuit-breaker state (module-level so tests can monkeypatch).
_jtop_inflight = threading.Lock()
_jtop_wedged_since: float | None = None   # monotonic time of the current wedge start
_jtop_cooldown_s: float = _JTOP_COOLDOWN_BASE_S  # current retry cooldown

# Guards the read-modify-write of the breaker state above so two concurrent
# collect() callers can't both swap/acquire the inflight lock (only core.py's
# serial loop calls this today, but the breaker is now safe under concurrency).
_jtop_state_lock = threading.Lock()

# Clock indirection so tests can control time without sleeping.
_monotonic = time.monotonic


def _begin_jtop_attempt():
    """Decide, atomically, whether to start a jtop attempt this cycle.

    Returns the acquired inflight Lock to hand to the worker, or None to fall back
    (a prior attempt is still wedged and within its cooldown).
    """
    global _jtop_inflight, _jtop_wedged_since, _jtop_cooldown_s
    with _jtop_state_lock:
        if _jtop_inflight.acquire(blocking=False):
            # Uncontested — start a fresh attempt. Clear any stale wedge marker so
            # this attempt's cooldown is measured from its own start, not a prior
            # (since-unblocked) attempt's timestamp.
            _jtop_wedged_since = None
            return _jtop_inflight
        # A prior jtop call is still in-flight (wedged daemon thread holds the lock).
        now = _monotonic()
        if (_jtop_wedged_since is not None
                and now - _jtop_wedged_since >= _jtop_cooldown_s):
            # Cooldown expired: abandon the old wedged daemon thread (it dies when
            # jtop.service is restarted), back off, and retry on a fresh lock —
            # all while holding the state lock so no concurrent caller races the swap.
            _jtop_cooldown_s = min(_jtop_cooldown_s * 2, _JTOP_COOLDOWN_MAX_S)
            _jtop_inflight = threading.Lock()
            _jtop_wedged_since = None
            _jtop_inflight.acquire()  # fresh, uncontested
            print(f"jtop cooldown expired; retrying jtop "
                  f"(next cooldown: {_jtop_cooldown_s:.0f}s)", file=sys.stderr)
            return _jtop_inflight
        return None  # still cooling down


def _mark_jtop_wedged() -> None:
    """Record the wedge start time for the current attempt (if not already set)."""
    global _jtop_wedged_since
    with _jtop_state_lock:
        if _jtop_wedged_since is None:
            _jtop_wedged_since = _monotonic()


def _reset_jtop_breaker() -> None:
    """A successful jtop call closes the breaker: clear the wedge + reset cooldown."""
    global _jtop_wedged_since, _jtop_cooldown_s
    with _jtop_state_lock:
        _jtop_wedged_since = None
        _jtop_cooldown_s = _JTOP_COOLDOWN_BASE_S


def _linux_fallback() -> dict:
    """Generic Linux metrics, relabelled as a Jetson host."""
    from collectors.linux import collect as linux_collect  # noqa: PLC0415

    payload = linux_collect()
    payload["platform"] = "jetson"
    return payload


def _collect_via_jtop() -> dict:
    """
    Use jtop to gather Jetson-specific metrics.
    Returns an augmented payload dict.
    Raises ImportError if jtop is not installed.
    """
    from jtop import jtop  # noqa: PLC0415  (optional dep)

    payload = base_metrics()
    payload["os"] = "linux"
    payload["platform"] = "jetson"

    extra: dict = {}

    with jtop() as jetson:
        # jtop.stats is a dict with keys like 'CPU1', 'CPU2', 'GPU', 'Temp CPU', etc.
        stats = jetson.stats if hasattr(jetson, "stats") else {}

        # CPU temperature — try common key names
        for key in ("Temp CPU", "temp_cpu", "CPU Temp"):
            if key in stats:
                try:
                    payload["temp_cpu_c"] = round(float(stats[key]), 1)
                    break
                except (TypeError, ValueError):
                    pass

        # GPU temperature
        for key in ("Temp GPU", "temp_gpu", "GPU Temp"):
            if key in stats:
                try:
                    extra["temp_gpu_c"] = round(float(stats[key]), 1)
                    break
                except (TypeError, ValueError):
                    pass

        # GPU utilisation (%)
        gpu_pct = None
        if hasattr(jetson, "gpu"):
            gpu_info = jetson.gpu
            if isinstance(gpu_info, dict):
                gpu_pct = gpu_info.get("status", {}).get("load")
                if gpu_pct is None:
                    gpu_pct = gpu_info.get("load")
        if gpu_pct is not None:
            try:
                extra["gpu_pct"] = round(float(gpu_pct), 1)
            except (TypeError, ValueError):
                pass

        # Power consumption (mW)
        if hasattr(jetson, "power"):
            power_info = jetson.power
            # power_info may be a dict of rails; sum them or take a "total" key
            if isinstance(power_info, dict):
                total_mw = power_info.get("tot", {})
                if isinstance(total_mw, dict):
                    mw = total_mw.get("power")
                elif isinstance(total_mw, (int, float)):
                    mw = total_mw
                else:
                    mw = None
                if mw is not None:
                    try:
                        extra["power_mw"] = round(float(mw), 1)
                    except (TypeError, ValueError):
                        pass

    if extra:
        payload["extra"] = extra

    return payload


def collect() -> dict:
    """
    Collect Jetson metrics.
    Uses jtop when available; falls back to the generic linux collector when:
      - jtop is not installed (ImportError),
      - jtop is installed but fails at runtime (daemon down, socket error, version
        mismatch — raises an exception), OR
      - jtop *hangs* (blocks past _JTOP_TIMEOUT_S without returning or raising).
    The last case is why the call runs in a bounded daemon thread rather than a
    plain try/except: a blocked jtop never raises, so without the timeout it would
    wedge the agent and make a healthy host look offline.

    Circuit-breaker: once a wedge is detected, subsequent calls return the linux
    fallback immediately (no extra threads) until the cooldown expires.  On expiry
    the breaker resets and retries jtop — so the agent recovers automatically when
    jtop.service becomes healthy again.  See module docstring for full details.
    """
    # Cheap up-front check: if jtop isn't installed, skip the thread machinery.
    try:
        import jtop  # noqa: F401, PLC0415
    except ImportError:
        return _linux_fallback()

    # Atomically decide whether to start an attempt (and on which lock). `inflight`
    # is a bound local so the worker releases the exact object it acquired, never
    # whatever _jtop_inflight points at later (it's swapped on a cooldown retry).
    inflight = _begin_jtop_attempt()
    if inflight is None:
        print("jtop collection still in-flight from a prior cycle "
              "(daemon likely wedged); using linux collector", file=sys.stderr)
        return _linux_fallback()

    result: dict = {}

    def _target() -> None:
        try:
            result["value"] = _collect_via_jtop()
        except BaseException as exc:  # noqa: BLE001 — surfaced to collect() below
            result["error"] = exc
        finally:
            inflight.release()

    worker = threading.Thread(target=_target, name="jtop-collect", daemon=True)
    worker.start()
    worker.join(_JTOP_TIMEOUT_S)

    if worker.is_alive():
        # Thread still holds the lock; the breaker cooldown governs the next retry.
        _mark_jtop_wedged()
        print(f"jtop collection exceeded {_JTOP_TIMEOUT_S:.0f}s (daemon wedged); "
              "using linux collector", file=sys.stderr)
        return _linux_fallback()

    if "error" in result:
        exc = result["error"]
        if isinstance(exc, ImportError):
            return _linux_fallback()
        print(f"jtop runtime error ({exc}); falling back to linux collector", file=sys.stderr)
        return _linux_fallback()

    _reset_jtop_breaker()  # success: close the breaker
    return result["value"]
