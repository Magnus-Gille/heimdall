"""Regression tests for the fleet-agent service sandbox and deploy safety."""

import os
import subprocess
from pathlib import Path

import pytest


AGENT_DIR = Path(__file__).parent
DEPLOY_SCRIPT = AGENT_DIR / "deploy" / "deploy-agent.sh"
SERVICE_UNIT = AGENT_DIR / "deploy" / "heimdall-agent.service"


SSH_MOCK = r"""#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"
if [[ "$payload" == *"required_key_present"* ]]; then
  echo preflight >> "$MOCK_LOG"
  HOME="$MOCK_REMOTE_HOME" /bin/bash <<< "$payload"
elif [[ "$payload" == *"systemctl --user restart heimdall-agent"* ]]; then
  echo install-restart >> "$MOCK_LOG"
  printf '%s\n' "$payload" > "$MOCK_INSTALL_PAYLOAD"
elif [[ "$*" == *"/VERSION"* ]]; then
  echo version >> "$MOCK_LOG"
elif [[ "$*" == *"is-active"* ]]; then
  echo status >> "$MOCK_LOG"
  echo active
else
  echo "unexpected ssh invocation: $*" >&2
  exit 90
fi
"""


RSYNC_MOCK = r"""#!/usr/bin/env bash
set -euo pipefail
echo rsync >> "$MOCK_LOG"
printf '%s\n' "$@" > "$MOCK_RSYNC_ARGS"
"""


def deploy_env(tmp_path, config_text=None):
    mock_bin = tmp_path / "bin"
    remote_home = tmp_path / "remote-home"
    config = remote_home / "repos" / "heimdall" / "agent" / "config.env"
    mock_bin.mkdir()
    config.parent.mkdir(parents=True)
    if config_text is not None:
        config.write_text(config_text)
        config.chmod(0o600)

    ssh = mock_bin / "ssh"
    rsync = mock_bin / "rsync"
    ssh.write_text(SSH_MOCK)
    rsync.write_text(RSYNC_MOCK)
    ssh.chmod(0o755)
    rsync.chmod(0o755)

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{mock_bin}:{env['PATH']}",
            "MOCK_LOG": str(tmp_path / "events.log"),
            "MOCK_REMOTE_HOME": str(remote_home),
            "MOCK_INSTALL_PAYLOAD": str(tmp_path / "install-payload"),
            "MOCK_RSYNC_ARGS": str(tmp_path / "rsync-args"),
        }
    )
    return env, config


def run_deploy(env):
    return subprocess.run(
        ["bash", str(DEPLOY_SCRIPT), "mock-host"],
        cwd=AGENT_DIR.parent,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def events(env):
    path = Path(env["MOCK_LOG"])
    return path.read_text().splitlines() if path.exists() else []


def test_service_sandbox_allows_only_agent_and_heartbeat_state_writes():
    unit = SERVICE_UNIT.read_text()

    assert "ProtectHome=read-only" in unit
    assert (
        "ReadWritePaths=%h/repos/heimdall/agent "
        "%h/.local/state/heimdall-agent"
    ) in unit
    assert "%h/.local/state" not in unit.replace(
        "%h/.local/state/heimdall-agent", ""
    )


@pytest.mark.parametrize(
    "config_text",
    [
        None,
        "",
        "HUB_URL=http://hub/push\n",
        "FLEET_TOKEN=token\n",
        "HUB_URL=\nFLEET_TOKEN=token\n",
        'HUB_URL=http://hub/push\nFLEET_TOKEN=""\n',
        "HUB_URL=http://hub/push\nFLEET_TOKEN=''\n",
        "FLEET_TOKEN=token\nHUB_URL=http://hub/push\nFLEET_TOKEN=\n",
    ],
)
def test_preflight_rejects_missing_or_empty_config_before_any_mutation(
    tmp_path, config_text
):
    env, _config = deploy_env(tmp_path, config_text)

    result = run_deploy(env)

    assert result.returncode != 0
    assert events(env) == ["preflight"]
    assert "refusing to update or restart" in result.stderr


def test_preflight_rejects_unprotected_config_permissions(tmp_path):
    env, config = deploy_env(
        tmp_path, "HUB_URL=http://hub/push\nFLEET_TOKEN=token\n"
    )
    config.chmod(0o644)

    result = run_deploy(env)

    assert result.returncode != 0
    assert events(env) == ["preflight"]
    assert "must have mode 600" in result.stderr


def test_deploy_preserves_config_updates_unit_and_orders_every_step(tmp_path):
    secret = "do-not-print-this-token"
    original = f"HUB_URL=http://hub/push\nFLEET_TOKEN={secret}\nHOSTNAME=test\n"
    env, config = deploy_env(tmp_path, original)

    result = run_deploy(env)

    assert result.returncode == 0, result.stderr
    assert events(env) == [
        "preflight",
        "rsync",
        "version",
        "install-restart",
        "status",
    ]
    assert config.read_text() == original
    assert secret not in result.stdout
    assert secret not in result.stderr

    rsync_args = Path(env["MOCK_RSYNC_ARGS"]).read_text().splitlines()
    assert "--delete" in rsync_args
    assert "config.env" in rsync_args
    assert rsync_args[rsync_args.index("config.env") - 1] == "--exclude"
    assert "--delete-excluded" not in rsync_args

    install_payload = Path(env["MOCK_INSTALL_PAYLOAD"]).read_text()
    state_dir_at = install_payload.index("install -d -m 0700")
    install_at = install_payload.index("install -m 0644")
    reload_at = install_payload.index("systemctl --user daemon-reload")
    restart_at = install_payload.index("systemctl --user restart heimdall-agent")
    assert state_dir_at < install_at < reload_at < restart_at
    assert 'if [ ! -f "${SERVICE_DIR}/heimdall-agent.service" ]' not in install_payload


def test_valid_quoted_config_values_pass_preflight(tmp_path):
    env, _config = deploy_env(
        tmp_path,
        ' HUB_URL = "http://hub/push"\nFLEET_TOKEN = \'token\'\n',
    )

    result = run_deploy(env)

    assert result.returncode == 0, result.stderr
