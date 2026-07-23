#!/usr/bin/env python3
"""Secret-safe diagnostics and rotation for Heimdall alert ingest.

The command intentionally reports only allowlisted presence/state fields. Token
values stay in memory and in the two operator-supplied private environment files.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


TOKEN_KEY = "HEIMDALL_ALERT_TOKEN"
URL_KEY = "HEIMDALL_INGEST_URL"
SERVICE_RE = re.compile(r"^[A-Za-z0-9_.@-]+$")
SAFE_ABSOLUTE_PATH_RE = re.compile(r"^/[A-Za-z0-9_./-]+$")
AUTH_LOG_RE = re.compile(
    r"(Heimdall ingest returned (?:401|403)|"
    r"HEIMDALL_ALERT_TOKEN is empty|alert echo is DISABLED)",
    re.IGNORECASE,
)
MAX_ENV_BYTES = 1024 * 1024


class OpsError(RuntimeError):
    """Expected operational failure whose message never includes a secret."""


class RotationInterrupted(OpsError):
    """Catchable interruption used to drive the normal rollback path."""


def fail(message: str) -> NoReturn:
    raise OpsError(message)


def file_text(
    path: Path, *, require_private: bool
) -> tuple[str, int, int, int]:
    try:
        info = path.lstat()
    except OSError as exc:
        fail(f"cannot stat private environment file {path}: {exc.strerror}")
    if not stat.S_ISREG(info.st_mode):
        fail(f"private environment path is not a regular file: {path}")
    mode = stat.S_IMODE(info.st_mode)
    if require_private and mode & 0o077:
        fail(f"private environment file must not be group/world accessible: {path}")
    if info.st_size > MAX_ENV_BYTES:
        fail(f"private environment file is unexpectedly large: {path}")
    try:
        return path.read_text(encoding="utf-8"), mode, info.st_uid, info.st_gid
    except (OSError, UnicodeError) as exc:
        fail(f"cannot read private environment file {path}: {type(exc).__name__}")


def private_env_text(path: Path) -> tuple[str, int, int, int]:
    return file_text(path, require_private=True)


def drop_in_text(path: Path) -> tuple[str, int, int, int]:
    return file_text(path, require_private=False)


def assignment_values(text: str, key: str) -> list[str]:
    pattern = re.compile(rf"^[ \t]*{re.escape(key)}[ \t]*=(.*)$")
    values: list[str] = []
    for line in text.splitlines():
        match = pattern.match(line)
        if match:
            values.append(match.group(1).strip())
    return values


def required_value(text: str, key: str, label: str) -> str:
    values = assignment_values(text, key)
    if len(values) != 1 or not values[0]:
        fail(f"{label} must contain exactly one non-empty {key} assignment")
    return values[0]


def replace_assignment(text: str, key: str, value: str, label: str) -> str:
    pattern = re.compile(rf"^([ \t]*{re.escape(key)}[ \t]*=).*$", re.MULTILINE)
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        fail(f"{label} must contain exactly one {key} assignment")
    return pattern.sub(lambda match: f"{match.group(1)}{value}", text, count=1)


def replace_or_add_assignment(text: str, key: str, value: str, label: str) -> str:
    matches = assignment_values(text, key)
    if len(matches) > 1:
        fail(f"{label} must contain at most one {key} assignment")
    if matches:
        return replace_assignment(text, key, value, label)
    separator = "" if not text or text.endswith("\n") else "\n"
    return f"{text}{separator}{key}={value}\n"


def inline_drop_in_tokens(text: str) -> list[str]:
    tokens = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or not line.startswith("Environment="):
            continue
        value = line[len("Environment="):].strip()
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]
        if value.startswith(f"{TOKEN_KEY}="):
            tokens.append(value[len(TOKEN_KEY) + 1:])
    return tokens


def drop_in_env_files(text: str) -> list[str]:
    values = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or not line.startswith("EnvironmentFile="):
            continue
        values.append(line[len("EnvironmentFile="):].strip().lstrip("-"))
    return values


def secret_free_drop_in(env_path: Path) -> str:
    path = str(env_path)
    if not SAFE_ABSOLUTE_PATH_RE.fullmatch(path):
        fail("Heimdall environment path is not safe for a systemd EnvironmentFile")
    return f"[Service]\nEnvironmentFile={path}\n"


def atomic_write(path: Path, text: str, mode: int, uid: int, gid: int) -> None:
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.alert-token-",
        dir=path.parent,
    )
    try:
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, uid, gid)
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as handle:
            descriptor = -1
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def command_path(env_name: str, default: str) -> str:
    return os.environ.get(env_name, default)


def systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [command_path("HEIMDALL_ALERT_SYSTEMCTL_BIN", "systemctl"), *args],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if check and result.returncode != 0:
        fail(f"systemctl action failed: {' '.join(args[:2])}")
    return result


def validate_service_name(name: str) -> str:
    if not SERVICE_RE.fullmatch(name):
        fail(f"invalid systemd service name: {name}")
    return name


def install_interruption_handlers() -> dict[signal.Signals, object]:
    previous = {}

    def interrupt(signum: int, _frame: object) -> NoReturn:
        raise RotationInterrupted(f"interrupted by signal {signal.Signals(signum).name}")

    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signum = getattr(signal, name)
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, interrupt)
    return previous


def set_handlers(handlers: dict[signal.Signals, object]) -> None:
    for signum, handler in handlers.items():
        signal.signal(signum, handler)


def ignore_interruption_signals(
    handlers: dict[signal.Signals, object],
) -> dict[signal.Signals, object]:
    ignored = {}
    for signum in handlers:
        ignored[signum] = signal.getsignal(signum)
        signal.signal(signum, signal.SIG_IGN)
    return ignored


def wait_active(service: str, timeout_seconds: float = 15.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if systemctl("is-active", "--quiet", service, check=False).returncode == 0:
            return
        time.sleep(0.25)
    fail(f"service did not become active: {service}")


def service_state(service: str) -> str:
    result = systemctl(
        "show",
        service,
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
        check=False,
    )
    if result.returncode != 0:
        return "unavailable"
    fields = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"ActiveState", "SubState", "MainPID"}:
            fields[key] = value.strip()
    active = fields.get("ActiveState", "unknown")
    sub = fields.get("SubState", "unknown")
    pid_value = fields.get("MainPID", "")
    pid = pid_value if pid_value.isdigit() else "unknown"
    return f"{active}/{sub} pid={pid}"


def recent_auth_failure_count(services: list[str]) -> int:
    args = [
        command_path("HEIMDALL_ALERT_JOURNALCTL_BIN", "journalctl"),
        "--since=-10 minutes",
        "--lines=100",
        "--no-pager",
        "--output=cat",
    ]
    for service in services:
        args.extend(["--unit", service])
    try:
        result = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return -1
    if result.returncode != 0:
        return -1
    return sum(1 for line in result.stdout.splitlines() if AUTH_LOG_RE.search(line))


def http_status(url: str, token: str, body: dict[str, str]) -> int:
    probe_bin = os.environ.get("HEIMDALL_ALERT_HTTP_PROBE_BIN")
    if probe_bin:
        result = subprocess.run(
            [probe_bin],
            input=json.dumps({"url": url, "token": token, "body": body}),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        try:
            return int(result.stdout.strip())
        except ValueError:
            fail("HTTP probe helper returned an invalid status")

    payload = json.dumps(body).encode("utf-8")
    request = Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=5) as response:
            response.read(4096)
            return response.status
    except HTTPError as exc:
        exc.read(4096)
        return exc.code
    except (OSError, URLError) as exc:
        fail(f"alert-ingest probe failed: {type(exc).__name__}")


def health_status(url: str) -> int:
    probe_bin = os.environ.get("HEIMDALL_ALERT_HTTP_PROBE_BIN")
    if probe_bin:
        result = subprocess.run(
            [probe_bin],
            input=json.dumps({"url": url, "kind": "health"}),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        try:
            return int(result.stdout.strip())
        except ValueError:
            return 0

    request = Request(url, method="GET")
    try:
        with urlopen(request, timeout=2) as response:
            response.read(4096)
            return response.status
    except HTTPError as exc:
        exc.read(4096)
        return exc.code
    except (OSError, URLError):
        return 0


def derive_health_url(ingest_url: str) -> str:
    parsed = urlsplit(ingest_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        fail("ingest URL must be an absolute HTTP(S) URL")
    path = parsed.path
    if path.endswith("/api/alerts"):
        path = f"{path[:-len('/api/alerts')]}/api/health"
    else:
        path = "/api/health"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def wait_http_ready(url: str, timeout_seconds: float = 15.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status = health_status(url)
        if 200 <= status < 300:
            return
        time.sleep(0.25)
    fail("Heimdall HTTP health did not become ready")


def probe_body(state: str, dedup_key: str) -> dict[str, str]:
    body = {
        "state": state,
        "dedup_key": dedup_key,
        "source": "heimdall-maintenance",
        "category": "security",
    }
    if state == "firing":
        body.update({
            "severity": "info",
            "title": "Alert-ingest credential rotation probe",
            "body": "Harmless authentication probe; resolved by the rotation helper.",
        })
    return body


def diagnose(args: argparse.Namespace) -> int:
    heimdall_text, _, _, _ = private_env_text(args.heimdall_env)
    consumer_text, _, _, _ = private_env_text(args.consumer_env)
    drop_in = ""
    if args.heimdall_drop_in:
        drop_in, _, _, _ = drop_in_text(args.heimdall_drop_in)
    heimdall_tokens = assignment_values(heimdall_text, TOKEN_KEY)
    consumer_tokens = assignment_values(consumer_text, TOKEN_KEY)
    consumer_urls = assignment_values(consumer_text, URL_KEY)
    inline_tokens = inline_drop_in_tokens(drop_in)
    drop_in_files = drop_in_env_files(drop_in)
    heimdall_token = heimdall_tokens[0] if len(heimdall_tokens) == 1 else ""
    consumer_token = consumer_tokens[0] if len(consumer_tokens) == 1 else ""
    effective_heimdall = (
        inline_tokens[0] if len(inline_tokens) == 1 else heimdall_token
    )

    print(f"heimdall_token={'present' if heimdall_token else 'missing'}")
    print(f"consumer_token={'present' if consumer_token else 'missing'}")
    print(f"consumer_url={'present' if len(consumer_urls) == 1 and consumer_urls[0] else 'missing'}")
    print(f"inline_token={'present' if len(inline_tokens) == 1 and inline_tokens[0] else 'absent'}")
    print(f"dropin_env_file={'present' if str(args.heimdall_env) in drop_in_files else 'missing'}")
    print(f"tokens_match={'yes' if effective_heimdall and effective_heimdall == consumer_token else 'no'}")
    print(f"heimdall_service={service_state(args.heimdall_service)}")
    print(f"consumer_service={service_state(args.consumer_service)}")
    failures = recent_auth_failure_count([args.heimdall_service, args.consumer_service])
    print(f"recent_auth_failures={'unavailable' if failures < 0 else failures}")

    healthy = (
        bool(effective_heimdall)
        and effective_heimdall == consumer_token
        and len(consumer_urls) == 1
        and bool(consumer_urls[0])
        and (
            not args.heimdall_drop_in
            or (
                not inline_tokens
                and str(args.heimdall_env) in drop_in_files
            )
        )
    )
    return 0 if healthy else 1


def rotate(args: argparse.Namespace) -> int:
    validate_service_name(args.heimdall_service)
    validate_service_name(args.consumer_service)
    lock_path = args.heimdall_env.with_name(f".{args.heimdall_env.name}.alert-token.lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        heimdall_original, heimdall_mode, heimdall_uid, heimdall_gid = private_env_text(
            args.heimdall_env
        )
        consumer_original, consumer_mode, consumer_uid, consumer_gid = private_env_text(
            args.consumer_env
        )
        drop_in_original = ""
        drop_in_mode = drop_in_uid = drop_in_gid = 0
        if args.heimdall_drop_in:
            (
                drop_in_original,
                drop_in_mode,
                drop_in_uid,
                drop_in_gid,
            ) = drop_in_text(args.heimdall_drop_in)
        heimdall_tokens = assignment_values(heimdall_original, TOKEN_KEY)
        if len(heimdall_tokens) > 1:
            fail("Heimdall environment must contain at most one alert-token assignment")
        old_consumer = required_value(consumer_original, TOKEN_KEY, "consumer environment")
        required_value(consumer_original, URL_KEY, "consumer environment")
        inline_tokens = inline_drop_in_tokens(drop_in_original)
        if len(inline_tokens) > 1:
            fail("Heimdall drop-in must contain at most one inline alert token")
        effective_old = inline_tokens[0] if inline_tokens else (
            heimdall_tokens[0] if heimdall_tokens else ""
        )
        if effective_old and effective_old != old_consumer:
            fail("existing Heimdall and consumer alert tokens do not match")
        if args.heimdall_drop_in and not inline_tokens and not heimdall_tokens:
            fail("no existing Heimdall alert token found in env file or drop-in")

        replacement = secrets.token_hex(32)
        health_url = args.health_url or derive_health_url(args.ingest_url)
        # Validate an explicit health URL using the same absolute-HTTP rule.
        if args.health_url:
            parsed_health = urlsplit(health_url)
            if parsed_health.scheme not in {"http", "https"} or not parsed_health.netloc:
                fail("health URL must be an absolute HTTP(S) URL")
        heimdall_updated = replace_or_add_assignment(
            heimdall_original, TOKEN_KEY, replacement, "Heimdall environment"
        )
        consumer_updated = replace_assignment(
            consumer_original, TOKEN_KEY, replacement, "consumer environment"
        )
        drop_in_updated = (
            secret_free_drop_in(args.heimdall_env)
            if args.heimdall_drop_in
            else ""
        )
        consumer_stopped = False
        files_changed = False
        probe_fired = False
        dedup_key = f"security-alert-token-rotation-probe-{int(time.time())}"
        previous_handlers = install_interruption_handlers()

        try:
            consumer_stopped = True
            systemctl("stop", args.consumer_service)
            files_changed = True
            atomic_write(
                args.heimdall_env,
                heimdall_updated,
                heimdall_mode,
                heimdall_uid,
                heimdall_gid,
            )
            atomic_write(
                args.consumer_env,
                consumer_updated,
                consumer_mode,
                consumer_uid,
                consumer_gid,
            )
            if args.heimdall_drop_in:
                atomic_write(
                    args.heimdall_drop_in,
                    drop_in_updated,
                    drop_in_mode,
                    drop_in_uid,
                    drop_in_gid,
                )
                written_drop_in, _, _, _ = drop_in_text(args.heimdall_drop_in)
                if inline_drop_in_tokens(written_drop_in):
                    fail("inline alert token remained in the Heimdall drop-in")
                if str(args.heimdall_env) not in drop_in_env_files(written_drop_in):
                    fail("Heimdall drop-in does not reference the private environment file")
                systemctl("daemon-reload")

            systemctl("restart", args.heimdall_service)
            wait_active(args.heimdall_service)
            wait_http_ready(health_url)
            print("heimdall_ready=yes")
            consumer_stopped = False
            systemctl("restart", args.consumer_service)
            wait_active(args.consumer_service)

            replacement_status = http_status(
                args.ingest_url, replacement, probe_body("firing", dedup_key)
            )
            if replacement_status < 200 or replacement_status >= 300:
                fail("replacement credential was rejected by alert ingest")
            probe_fired = True
            print("replacement_auth=accepted")

            old_status = http_status(
                args.ingest_url, old_consumer, probe_body("firing", dedup_key)
            )
            if old_status not in (401, 403):
                fail("previous credential was not rejected by alert ingest")
            print("previous_auth=rejected")

            resolve_status = http_status(
                args.ingest_url, replacement, probe_body("resolved", dedup_key)
            )
            if resolve_status < 200 or resolve_status >= 300:
                fail("credential probe alert could not be resolved")
            probe_fired = False
            print("probe_alert=resolved")

            failures = recent_auth_failure_count(
                [args.heimdall_service, args.consumer_service]
            )
            print(f"recent_auth_failures={'unavailable' if failures < 0 else failures}")
            print("rotation=complete")
            return 0
        except BaseException as exc:
            rollback_handlers = ignore_interruption_signals(previous_handlers)
            if probe_fired:
                try:
                    http_status(
                        args.ingest_url, replacement, probe_body("resolved", dedup_key)
                    )
                except Exception:
                    pass
            try:
                if files_changed:
                    if not consumer_stopped:
                        systemctl("stop", args.consumer_service)
                    atomic_write(
                        args.heimdall_env,
                        heimdall_original,
                        heimdall_mode,
                        heimdall_uid,
                        heimdall_gid,
                    )
                    atomic_write(
                        args.consumer_env,
                        consumer_original,
                        consumer_mode,
                        consumer_uid,
                        consumer_gid,
                    )
                    if args.heimdall_drop_in:
                        atomic_write(
                            args.heimdall_drop_in,
                            drop_in_original,
                            drop_in_mode,
                            drop_in_uid,
                            drop_in_gid,
                        )
                        systemctl("daemon-reload")
                    systemctl("restart", args.heimdall_service)
                    wait_active(args.heimdall_service)
                    wait_http_ready(health_url)
                    systemctl("restart", args.consumer_service)
                    wait_active(args.consumer_service)
                elif consumer_stopped:
                    systemctl("restart", args.consumer_service)
                    wait_active(args.consumer_service)
            except Exception:
                print("rotation_failed=rollback_incomplete", file=sys.stderr)
                set_handlers(rollback_handlers)
                raise
            print("rotation_failed=rolled_back", file=sys.stderr)
            if isinstance(exc, OpsError):
                print(f"reason={exc}", file=sys.stderr)
            else:
                print(f"reason={type(exc).__name__}", file=sys.stderr)
            set_handlers(rollback_handlers)
            return 1
        finally:
            set_handlers(previous_handlers)
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Secret-safe Heimdall alert-token diagnostics and rotation"
    )
    subcommands = root.add_subparsers(dest="command", required=True)
    for name in ("diagnose", "rotate"):
        command = subcommands.add_parser(name)
        command.add_argument("--heimdall-env", required=True, type=Path)
        command.add_argument("--consumer-env", required=True, type=Path)
        command.add_argument("--heimdall-drop-in", type=Path)
        command.add_argument("--heimdall-service", default="heimdall.service")
        command.add_argument("--consumer-service", default="ratatoskr.service")
        if name == "rotate":
            command.add_argument("--ingest-url", required=True)
            command.add_argument("--health-url")
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "diagnose":
            return diagnose(args)
        return rotate(args)
    except OpsError as exc:
        print(f"error={exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("error=interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
