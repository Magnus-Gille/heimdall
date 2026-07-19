"""
Tests for collectors.jetson.collect() — specifically the hard-timeout fallback
and the jtop circuit-breaker with cooldown + auto-recovery.

Regression context: a wedged jetson-stats daemon made `with jtop() as ...` block
forever in __enter__. A blocked call never raises, so the old try/except fallback
couldn't catch it; the agent stopped posting and the host silently went offline.
collect() now runs the jtop collection in a bounded daemon thread and falls back
to the linux collector on timeout.

The circuit-breaker (#70 follow-up) adds a cooldown so a recovered jtop.service
can be retried automatically — avoiding permanent linux-fallback-only mode until
the agent process is restarted.

Run from the agent/ directory:  python3 -m pytest test_jetson_collector.py
"""

import sys
import time
import types
import threading

# collect() does `import jtop` as a cheap "is it installed?" check before spinning
# up the thread machinery. The dev/CI host has no jtop, so inject a stub module —
# _collect_via_jtop itself is monkeypatched in every test, so the stub is never used.
sys.modules.setdefault("jtop", types.ModuleType("jtop"))

from collectors import jetson  # noqa: E402


_FALLBACK_MARKER = {"platform": "jetson", "_via": "linux-fallback"}


def _isolate(monkeypatch, *, timeout=None):
    """
    Fresh inflight lock + a platform-independent fallback for each test.
    Also resets circuit-breaker state so tests don't bleed into each other.
    """
    monkeypatch.setattr(jetson, "_jtop_inflight", threading.Lock())
    monkeypatch.setattr(jetson, "_linux_fallback", lambda: dict(_FALLBACK_MARKER))
    if timeout is not None:
        monkeypatch.setattr(jetson, "_JTOP_TIMEOUT_S", timeout)
    # Reset circuit-breaker state (attributes added by the CB implementation).
    # raising=False so this file can still be parsed/collected before implementation.
    monkeypatch.setattr(jetson, "_jtop_wedged_since", None, raising=False)
    base = getattr(jetson, "_JTOP_COOLDOWN_BASE_S", 300)
    monkeypatch.setattr(jetson, "_jtop_cooldown_s", float(base), raising=False)
    # Reset clock indirection so tests that don't touch it get real monotonic time.
    monkeypatch.setattr(jetson, "_monotonic", time.monotonic, raising=False)


def test_hang_falls_back_within_timeout(monkeypatch):
    """A jtop call that blocks past the timeout must not wedge collect()."""
    _isolate(monkeypatch, timeout=0.3)
    entered = threading.Event()

    def _hang():
        entered.set()
        threading.Event().wait()  # block forever — simulate a wedged jtop daemon

    monkeypatch.setattr(jetson, "_collect_via_jtop", _hang)

    t0 = time.monotonic()
    out = jetson.collect()
    elapsed = time.monotonic() - t0

    assert entered.is_set(), "jtop collection should have been attempted"
    assert elapsed < 5, f"collect() blocked for {elapsed:.1f}s instead of timing out"
    assert out["_via"] == "linux-fallback"


def test_runtime_error_falls_back(monkeypatch):
    """An exception inside jtop still routes to the linux fallback."""
    _isolate(monkeypatch)

    def _boom():
        raise RuntimeError("jtop daemon down")

    monkeypatch.setattr(jetson, "_collect_via_jtop", _boom)
    assert jetson.collect()["_via"] == "linux-fallback"


def test_success_passes_through(monkeypatch):
    """A healthy jtop result is returned unchanged (no fallback)."""
    _isolate(monkeypatch)
    good = {"platform": "jetson", "temp_cpu_c": 42.0, "_via": "jtop"}
    monkeypatch.setattr(jetson, "_collect_via_jtop", lambda: dict(good))

    out = jetson.collect()
    assert out["_via"] == "jtop"
    assert out["temp_cpu_c"] == 42.0


def test_inflight_guard_avoids_piling_up_threads(monkeypatch):
    """Once a jtop call is wedged, later cycles take the fast fallback path."""
    _isolate(monkeypatch, timeout=0.3)

    def _hang():
        threading.Event().wait()  # block forever — simulate a wedged jtop daemon

    monkeypatch.setattr(jetson, "_collect_via_jtop", _hang)

    first = jetson.collect()  # times out, leaves the worker (and lock) wedged
    assert first["_via"] == "linux-fallback"

    t0 = time.monotonic()
    second = jetson.collect()  # must NOT wait the timeout again
    elapsed = time.monotonic() - t0

    assert second["_via"] == "linux-fallback"
    assert elapsed < 0.2, f"second call waited {elapsed:.2f}s; in-flight guard didn't engage"


# ---------------------------------------------------------------------------
# Circuit-breaker cooldown + auto-recovery tests
# ---------------------------------------------------------------------------


def test_cooldown_retry(monkeypatch):
    """
    After cooldown expires, collect() retries jtop rather than staying stuck
    in permanent linux-fallback mode.

    Timeline (fake monotonic clock):
      t=0:   cycle 1 — jtop wedges  → fallback, wedged_since=0, call_count=1
      t=100: cycle 2 — within cooldown (100 < 300) → fallback, no new spawn
      t=400: cycle 3 — past cooldown → RETRY, call_count=2, fallback (still hangs)
    """
    _isolate(monkeypatch, timeout=0.3)

    fake_now = [0.0]
    monkeypatch.setattr(jetson, "_monotonic", lambda: fake_now[0])

    call_count = [0]
    block_forever = threading.Event()

    def _hang_and_count():
        call_count[0] += 1
        block_forever.wait()  # block forever on every call

    monkeypatch.setattr(jetson, "_collect_via_jtop", _hang_and_count)

    # Cycle 1: wedge jtop, start cooldown clock.
    out = jetson.collect()
    assert out["_via"] == "linux-fallback"
    assert call_count[0] == 1
    assert jetson._jtop_wedged_since == 0.0, "wedge marker should be set after first wedge"

    # Cycle 2: still within cooldown — no new spawn.
    fake_now[0] = 100.0  # elapsed = 100 < 300 (base cooldown)
    out = jetson.collect()
    assert out["_via"] == "linux-fallback"
    assert call_count[0] == 1, "should NOT have spawned a new thread within cooldown"

    # Cycle 3: cooldown expired — retry jtop.
    fake_now[0] = 400.0  # elapsed = 400 >= 300 (base cooldown)
    out = jetson.collect()
    assert out["_via"] == "linux-fallback"  # still falls back (hangs again)
    assert call_count[0] == 2, "should have retried _collect_via_jtop after cooldown"


def test_cooldown_backoff_doubles(monkeypatch):
    """
    Each consecutive wedge + cooldown-expiry doubles _jtop_cooldown_s up to max.
    """
    _isolate(monkeypatch, timeout=0.3)

    fake_now = [0.0]
    monkeypatch.setattr(jetson, "_monotonic", lambda: fake_now[0])

    def _hang():
        threading.Event().wait()

    monkeypatch.setattr(jetson, "_collect_via_jtop", _hang)

    base = jetson._JTOP_COOLDOWN_BASE_S
    max_s = jetson._JTOP_COOLDOWN_MAX_S

    # Cycle 1: first wedge — cooldown unchanged (doubling happens at RETRY time).
    jetson.collect()
    assert jetson._jtop_cooldown_s == float(base), "cooldown should equal base after first wedge"

    # Cycle 2: cooldown expired → RETRY → wedges again → cooldown doubles.
    fake_now[0] = float(base) + 1.0
    jetson.collect()
    assert jetson._jtop_cooldown_s == min(base * 2, max_s), \
        "cooldown should double after second wedge"

    # Cycle 3: still within the doubled cooldown — cooldown must NOT change.
    cooldown_after_double = jetson._jtop_cooldown_s
    fake_now[0] = float(base) + 2.0  # << doubled cooldown (base+2 << 2*base+1)
    jetson.collect()
    assert jetson._jtop_cooldown_s == cooldown_after_double, \
        "cooldown should not double again within the current cooldown window"


def test_recovery_resets_breaker(monkeypatch):
    """
    After a wedge + cooldown expiry, a successful jtop call resets the circuit
    breaker to its base state (_jtop_cooldown_s=base, _jtop_wedged_since=None).
    """
    _isolate(monkeypatch, timeout=0.3)

    fake_now = [0.0]
    monkeypatch.setattr(jetson, "_monotonic", lambda: fake_now[0])

    call_count = [0]
    block_event = threading.Event()
    good_result = {"platform": "jetson", "_via": "jtop", "temp_cpu_c": 55.0}

    def _hang_first_then_succeed():
        call_count[0] += 1
        if call_count[0] == 1:
            block_event.wait()  # first call: block forever (wedge)
        return dict(good_result)  # subsequent calls: succeed

    monkeypatch.setattr(jetson, "_collect_via_jtop", _hang_first_then_succeed)

    base = jetson._JTOP_COOLDOWN_BASE_S

    # Cycle 1: wedge.
    out = jetson.collect()
    assert out["_via"] == "linux-fallback"

    # Cycle 2: cooldown expires, retry — this time jtop SUCCEEDS.
    fake_now[0] = float(base) + 1.0
    out = jetson.collect()
    assert out["_via"] == "jtop", "expected jtop result on successful retry"
    assert out["temp_cpu_c"] == 55.0

    # Breaker fully reset.
    assert jetson._jtop_cooldown_s == float(base), \
        "cooldown should reset to base after successful jtop"
    assert jetson._jtop_wedged_since is None, \
        "wedge marker should be cleared after successful jtop"
