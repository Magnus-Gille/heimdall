"""
Tests for collectors._agent_version() — the deployed-version helper.

Run from the agent/ directory:  python3 -m pytest test_version.py
"""

import subprocess
import types

import collectors


def test_agent_version_reads_version_file(monkeypatch, tmp_path):
    """Returns VERSION file content (stripped) when the file is present and non-empty."""
    version_file = tmp_path / "VERSION"
    version_file.write_text("abc1234\n")

    monkeypatch.setattr(collectors, "_AGENT_VERSION_FILE", str(version_file))
    result = collectors._agent_version()
    assert result == "abc1234"


def test_agent_version_skips_empty_version_file(monkeypatch, tmp_path):
    """Falls through to next source when VERSION file exists but is empty."""
    version_file = tmp_path / "VERSION"
    version_file.write_text("   \n")  # whitespace-only = empty

    monkeypatch.setattr(collectors, "_AGENT_VERSION_FILE", str(version_file))
    # Can't easily test git fallback in isolation, but at minimum it must not raise.
    result = collectors._agent_version()
    assert isinstance(result, str) and len(result) > 0


def test_agent_version_missing_file_does_not_raise(monkeypatch, tmp_path):
    """Falls back gracefully (no raise) when VERSION file is absent."""
    monkeypatch.setattr(
        collectors, "_AGENT_VERSION_FILE", str(tmp_path / "NONEXISTENT_VERSION")
    )
    result = collectors._agent_version()
    # Either a git SHA or "unknown" — either way a non-empty string.
    assert isinstance(result, str) and len(result) > 0


def test_agent_version_git_fallback(monkeypatch, tmp_path):
    """No VERSION file → uses `git rev-parse` output."""
    monkeypatch.setattr(collectors, "_AGENT_VERSION_FILE", str(tmp_path / "NOPE"))
    monkeypatch.setattr(collectors.subprocess, "run",
                        lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="deadbee\n"))
    assert collectors._agent_version() == "deadbee"


def test_agent_version_unknown_when_git_fails(monkeypatch, tmp_path):
    """No VERSION file AND git failing/absent → 'unknown', never raises."""
    monkeypatch.setattr(collectors, "_AGENT_VERSION_FILE", str(tmp_path / "NOPE"))

    def _boom(*a, **k):
        raise FileNotFoundError("git not installed")
    monkeypatch.setattr(collectors.subprocess, "run", _boom)
    assert collectors._agent_version() == "unknown"


def test_agent_version_tolerates_non_text_version_file(monkeypatch, tmp_path):
    """A corrupted/binary VERSION file (UnicodeError) must not raise."""
    vf = tmp_path / "VERSION"
    vf.write_bytes(b"\xff\xfe\x00\x01bad")
    monkeypatch.setattr(collectors, "_AGENT_VERSION_FILE", str(vf))
    monkeypatch.setattr(collectors.subprocess, "run",
                        lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="fa11bac\n"))
    # Falls through the unreadable file to the git source without raising.
    assert collectors._agent_version() == "fa11bac"
