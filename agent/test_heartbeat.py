"""Regression tests for the Brokkr last-push heartbeat contract."""

import sys

import pytest

import collectors
import core


def test_touch_heartbeat_uses_xdg_path_and_private_parent(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))

    core.touch_heartbeat()

    heartbeat = tmp_path / "heimdall-agent" / "last-push"
    assert heartbeat.is_file()
    assert heartbeat.stat().st_size == 0
    assert heartbeat.parent.stat().st_mode & 0o777 == 0o700


def run_once(monkeypatch, status):
    touches = []
    monkeypatch.setattr(sys, "argv", ["core.py", "--once"])
    monkeypatch.setattr(core, "load_config", lambda: {"HUB_URL": "http://hub/push"})
    monkeypatch.setattr(collectors, "collect", lambda _cfg: {"host": "test"})
    monkeypatch.setattr(core, "post_payload", lambda *_args: (status, "response"))
    monkeypatch.setattr(core, "touch_heartbeat", lambda: touches.append("touch"))
    return touches


def test_startup_touches_before_first_push(monkeypatch):
    touches = []

    def collect_failure(_cfg):
        raise RuntimeError("collection failed")

    monkeypatch.setattr(sys, "argv", ["core.py", "--once"])
    monkeypatch.setattr(core, "load_config", lambda: {"HUB_URL": "http://hub/push"})
    monkeypatch.setattr(collectors, "collect", collect_failure)
    monkeypatch.setattr(core, "touch_heartbeat", lambda: touches.append("touch"))

    with pytest.raises(SystemExit) as exc:
        core.main()

    assert exc.value.code == 1
    assert touches == ["touch"]


def test_successful_push_refreshes_heartbeat(monkeypatch):
    touches = run_once(monkeypatch, 204)

    core.main()

    assert touches == ["touch", "touch"]


def test_failed_push_does_not_refresh_heartbeat(monkeypatch):
    touches = run_once(monkeypatch, 500)

    with pytest.raises(SystemExit):
        core.main()

    assert touches == ["touch"]
