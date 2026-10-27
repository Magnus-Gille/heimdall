#!/usr/bin/env python3
"""Secret-safe rollout helper for Heimdall per-producer ingest tokens.

Heimdall authenticates /api/panels and /api/fleet/push only against the
HEIMDALL_INGEST_PRODUCERS_JSON registry (see src/fleet/producer-auth.js). This
helper registers producers on the Heimdall host and installs the matching token
on a producer node without a token value ever being printed, logged, placed on
the command line, or shown to an operator or agent.

Every subcommand acts only on local files named by explicit absolute paths.
Output is an allowlisted summary (ids, scopes, counts, states). The single
exception is "register --emit-token", which writes the new token to a
non-terminal stdout so it can be piped straight into "stage" on another node.

Exit codes: 0 success; 3 refused or failed (message on stderr). "diagnose"
additionally uses 1 (registry absent) and 2 (registry invalid).
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile
import traceback
from typing import Any, NoReturn, Optional


REGISTRY_KEY = "HEIMDALL_INGEST_PRODUCERS_JSON"
LEGACY_KEY = "HEIMDALL_FLEET_TOKEN"
DEFAULT_PENDING_KEY = "HEIMDALL_PRODUCER_TOKEN_PENDING"
BACKUP_SUFFIX = ".pre-producer-tokens"
MAX_ENV_BYTES = 1024 * 1024

# Mirrors src/fleet/producer-auth.js and src/fleet/validate.js.
ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
SERVICE_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
HOSTNAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
PRODUCER_KEYS = ("id", "token", "hosts", "services")

KEY_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# Tokens this tool generates or accepts on stdin: URL-safe alphabet only, so the
# value never needs quoting or escaping in a systemd EnvironmentFile.
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{16,256}")

# ECMAScript WhiteSpace + LineTerminator, i.e. what String.prototype.trim strips.
JS_WHITESPACE = (
    "\t\n\v\f\r          "
    "        　﻿"
)
LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")


class OpsError(RuntimeError):
    """Expected operational failure whose message never includes a secret."""


def fail(message: str) -> NoReturn:
    raise OpsError(message)


# ---------------------------------------------------------------------------
# Registry validation (mirrors parseProducerRegistry in producer-auth.js)
# ---------------------------------------------------------------------------

def js_trim(value: str) -> str:
    return value.strip(JS_WHITESPACE)


def _bytes_for_compare(value: str) -> bytes:
    # Buffer.from(String(x)) replaces lone surrogates with U+FFFD.
    return LONE_SURROGATE_RE.sub("�", value).encode("utf-8")


def constant_time_equal(a: str, b: str) -> bool:
    left, right = _bytes_for_compare(a), _bytes_for_compare(b)
    if len(left) != len(right) or len(left) == 0:
        return False
    return secrets.compare_digest(left, right)


def _reject_constant(_name: str) -> NoReturn:
    raise ValueError("non-finite number")


def _scope_list(record: dict, key: str, pattern: "re.Pattern[str]") -> Optional[list]:
    if key not in record:
        return []
    values = record[key]
    if not isinstance(values, list) or not values:
        return None
    seen: list = []
    for value in values:
        if not isinstance(value, str) or not pattern.fullmatch(value) or value in seen:
            return None
        seen.append(value)
    return seen


def parse_registry(raw: Any, legacy_token: str = "") -> "tuple[Optional[list], str]":
    """Return (producers, reason). producers is None when invalid.

    The reason names only a record index and rule, never a value.
    """
    if not isinstance(raw, str) or not js_trim(raw):
        return None, "value is empty"
    try:
        parsed = json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return None, "value is not valid JSON"
    if not isinstance(parsed, list) or not parsed:
        return None, "value is not a non-empty JSON array"

    ids: set = set()
    tokens: set = set()
    producers: list = []
    for index, record in enumerate(parsed, start=1):
        label = f"record {index}"
        if not isinstance(record, dict):
            return None, f"{label} is not an object"
        if any(key not in PRODUCER_KEYS for key in record):
            return None, f"{label} has unsupported keys"
        record_id = record.get("id")
        if not isinstance(record_id, str) or not ID_RE.fullmatch(record_id):
            return None, f"{label} id is missing or malformed"
        if record_id in ids:
            return None, f"{label} id is a duplicate"
        token = record.get("token")
        if not isinstance(token, str) or not js_trim(token) or "\r" in token or "\n" in token:
            return None, f"{label} token is missing, blank, or multi-line"
        if token in tokens:
            return None, f"{label} token is not distinct"
        if constant_time_equal(token, legacy_token):
            return None, f"{label} token equals the legacy fleet token"
        hosts = _scope_list(record, "hosts", HOSTNAME_RE)
        services = _scope_list(record, "services", SERVICE_RE)
        if hosts is None:
            return None, f"{label} hosts scope is invalid"
        if services is None:
            return None, f"{label} services scope is invalid"
        if not hosts and not services:
            return None, f"{label} has no hosts or services scope"
        ids.add(record_id)
        tokens.add(token)
        producers.append(
            {"id": record_id, "token": token, "hosts": hosts, "services": services}
        )
    return producers, "ok"


def serialize_registry(producers: list) -> str:
    records = []
    for producer in producers:
        record: dict = {"id": producer["id"], "token": producer["token"]}
        if producer["hosts"]:
            record["hosts"] = producer["hosts"]
        if producer["services"]:
            record["services"] = producer["services"]
        records.append(record)
    text = json.dumps(records, separators=(",", ":"), ensure_ascii=True)
    if "'" in text or "\n" in text or "\r" in text:
        fail("registry contains a character that cannot be single-quoted safely")
    return text


# ---------------------------------------------------------------------------
# Private env file handling
# ---------------------------------------------------------------------------

def allowed_uids() -> "set[int]":
    uids = {os.geteuid()}
    sudo_uid = os.environ.get("SUDO_UID", "")
    if os.geteuid() == 0 and sudo_uid.isdigit():
        uids.add(int(sudo_uid))
    return uids


class EnvFile:
    def __init__(self, path: Path, data: bytes, mode: int, uid: int, gid: int) -> None:
        self.path = path
        self.data = data
        self.mode = mode
        self.uid = uid
        self.gid = gid
        self.text = data.decode("utf-8")
        self.lines = self.text.split("\n")


def read_env(path: Path, label: str = "environment file") -> EnvFile:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as exc:
        fail(f"cannot open {label} {path} (missing, symlink, or unreadable): {exc.strerror}")
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            fail(f"{label} is not a regular file: {path}")
        if info.st_uid not in allowed_uids():
            fail(f"{label} is not owned by the current user: {path}")
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o077:
            fail(f"{label} must not be group/world accessible: {path}")
        if info.st_size > MAX_ENV_BYTES:
            fail(f"{label} is unexpectedly large: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            data = handle.read(MAX_ENV_BYTES + 1)
    finally:
        os.close(descriptor)
    try:
        return EnvFile(path, data, mode, info.st_uid, info.st_gid)
    except UnicodeError:
        fail(f"{label} is not valid UTF-8: {path}")


def atomic_write(path: Path, data: bytes, mode: int, uid: int, gid: int) -> None:
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.producer-token-", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        try:
            os.fchown(descriptor, uid, gid)
        except PermissionError:
            fail("cannot preserve file owner/group on the rewritten file")
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def backup_path(path: Path) -> Path:
    return path.with_name(path.name + BACKUP_SUFFIX)


def ensure_backup(env: EnvFile) -> str:
    """Create the one-time pre-modification backup; return created|existing."""
    target = backup_path(env.path)
    try:
        info = target.lstat()
    except FileNotFoundError:
        info = None
    if info is not None:
        if not stat.S_ISREG(info.st_mode):
            fail(f"backup path is not a regular file: {target}")
        return "existing"
    descriptor = os.open(
        target,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        if os.geteuid() == 0:
            os.fchown(descriptor, env.uid, env.gid)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(env.data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(target)
        except FileNotFoundError:
            pass
        raise
    return "created"


class DirLock:
    """Exclusive advisory lock on the file's directory (no stray lock files)."""

    def __init__(self, path: Path) -> None:
        self.directory = path.parent
        self.descriptor = -1

    def __enter__(self) -> "DirLock":
        try:
            self.descriptor = os.open(self.directory, os.O_RDONLY)
        except OSError as exc:
            fail(f"cannot open environment directory: {exc.strerror}")
        fcntl.flock(self.descriptor, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_exc: object) -> None:
        fcntl.flock(self.descriptor, fcntl.LOCK_UN)
        os.close(self.descriptor)


def commit(env: EnvFile, new_lines: "list[str]") -> str:
    backup = ensure_backup(env)
    atomic_write(env.path, "\n".join(new_lines).encode("utf-8"), env.mode, env.uid, env.gid)
    return backup


# ---------------------------------------------------------------------------
# Assignment parsing / editing
# ---------------------------------------------------------------------------

def check_key(key: str) -> str:
    if not KEY_NAME_RE.fullmatch(key):
        fail("environment key names must match [A-Za-z_][A-Za-z0-9_]*")
    return key


class Assignment:
    def __init__(self, index: int, lead: str, key: str, rest: str) -> None:
        self.index = index
        self.lead = lead
        self.key = key
        stripped = rest.strip()
        self.quote = ""
        self.value = stripped
        self.valid = True
        if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in "'\"":
            self.quote = stripped[0]
            inner = stripped[1:-1]
            if self.quote == '"':
                if re.search(r"\\[^\"\\]", inner):
                    self.valid = False
                inner = re.sub(r"\\([\"\\])", r"\1", inner)
            elif "'" in inner:
                self.valid = False
            self.value = inner


def assignments(lines: "list[str]", key: str) -> "list[Assignment]":
    pattern = re.compile(
        rf"^([ \t]*(?:export[ \t]+)?){re.escape(key)}[ \t]*=(.*)$"
    )
    found = []
    for index, line in enumerate(lines):
        match = pattern.match(line)
        if match:
            if line.endswith("\r"):
                fail(f"{key} assignment uses CRLF line endings; refusing to edit")
            found.append(Assignment(index, match.group(1), key, match.group(2)))
    return found


def single_assignment(lines: "list[str]", key: str, label: str, required: bool) -> Optional[Assignment]:
    found = assignments(lines, key)
    if len(found) > 1:
        fail(f"{label} contains more than one {key} assignment; refusing to guess")
    if not found:
        if required:
            fail(f"{label} has no {key} assignment")
        return None
    return found[0]


def assignment_line(assignment: Assignment, value: str) -> str:
    quote = assignment.quote if assignment.valid else ""
    return f"{assignment.lead}{assignment.key}={quote}{value}{quote}"


def append_line(lines: "list[str]", line: str) -> "list[str]":
    """Append a line, keeping the file's trailing-newline convention."""
    result = list(lines)
    if result and result[-1] == "":
        result.insert(len(result) - 1, line)
    elif not result:
        result = [line, ""]
    else:
        result.extend([line, ""])
    return result


def set_token(lines: "list[str]", key: str, token: str, label: str) -> "list[str]":
    existing = single_assignment(lines, key, label, required=False)
    if existing:
        result = list(lines)
        result[existing.index] = assignment_line(existing, token)
        return result
    return append_line(lines, f"{key}={token}")


def set_registry(lines: "list[str]", existing: Optional[Assignment], text: str) -> "list[str]":
    if existing:
        result = list(lines)
        result[existing.index] = f"{existing.lead}{REGISTRY_KEY}='{text}'"
        return result
    return append_line(lines, f"{REGISTRY_KEY}='{text}'")


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def legacy_token(env: EnvFile, label: str) -> str:
    assignment = single_assignment(env.lines, LEGACY_KEY, label, required=False)
    return assignment.value if assignment else ""


def is_tty(stream: Any) -> bool:
    try:
        return bool(stream.isatty())
    except (AttributeError, ValueError):
        return False


def diagnose(args: argparse.Namespace) -> int:
    env = read_env(args.server_env, "server environment file")
    legacy_found = assignments(env.lines, LEGACY_KEY)
    legacy = legacy_found[0].value if len(legacy_found) == 1 else ""
    legacy_present = any(item.value for item in legacy_found)
    print(f"legacy_fleet_token={'present' if legacy_present else 'absent'}")

    found = assignments(env.lines, REGISTRY_KEY)
    if not found:
        print("registry=absent")
        return 1
    print("registry=present")
    if len(found) > 1:
        print("registry_valid=no")
        print("reason=more than one registry assignment")
        return 2
    if not found[0].valid:
        print("registry_valid=no")
        print("reason=value has unsupported quoting")
        return 2
    producers, reason = parse_registry(found[0].value, legacy)
    if producers is None:
        print("registry_valid=no")
        print(f"reason={reason}")
        return 2
    print("registry_valid=yes")
    print(f"producers={len(producers)}")
    for producer in producers:
        print(
            f"producer id={producer['id']} "
            f"hosts={','.join(producer['hosts']) or '-'} "
            f"services={','.join(producer['services']) or '-'}"
        )
    return 0


def register(args: argparse.Namespace) -> int:
    if args.emit_token and is_tty(sys.stdout):
        fail("refusing --emit-token: stdout is a terminal; pipe it into the stage command")
    note = (lambda message: print(message, file=sys.stderr)) if args.emit_token else print
    hosts = list(args.host or [])
    services = list(args.service or [])
    if not hosts and not services:
        fail("register needs at least one --host or --service scope")
    with DirLock(args.server_env):
        env = read_env(args.server_env, "server environment file")
        legacy = legacy_token(env, "server environment")
        existing = single_assignment(env.lines, REGISTRY_KEY, "server environment", False)
        producers: list = []
        if existing:
            if not existing.valid:
                fail("existing registry value has unsupported quoting")
            producers, reason = parse_registry(existing.value, legacy)
            if producers is None:
                fail(f"existing registry is invalid ({reason}); run diagnose first")

        token = secrets.token_urlsafe(32)
        record = {"id": args.id, "token": token, "hosts": hosts, "services": services}
        position = next((i for i, p in enumerate(producers) if p["id"] == args.id), None)
        if position is None:
            if args.replace:
                fail("--replace given but no record with that id exists")
            action = "added"
            producers.append(record)
        else:
            if not args.replace:
                fail("a record with that id already exists; use --replace to rotate it")
            action = "replaced"
            producers[position] = record

        text = serialize_registry(producers)
        validated, reason = parse_registry(text, legacy)
        if validated is None:
            fail(f"resulting registry would be invalid ({reason})")
        if validated != producers:
            fail("resulting registry did not round-trip; refusing to write")

        backup = commit(env, set_registry(env.lines, existing, text))
        note(f"registered id={args.id} action={action} producers={len(validated)}")
        note(f"hosts={','.join(hosts) or '-'} services={','.join(services) or '-'}")
        note(f"backup={backup} token={'emitted-to-stdout' if args.emit_token else 'stored-not-shown'}")
        if args.emit_token:
            try:
                sys.stdout.write(token + "\n")
                sys.stdout.flush()
            except OSError as exc:
                # The token was not delivered: put the registry back.
                atomic_write(env.path, env.data, env.mode, env.uid, env.gid)
                fail(f"could not write the token to stdout ({exc.strerror}); registry restored")
    return 0


def read_stdin_token() -> str:
    if is_tty(sys.stdin):
        fail("refusing to read a token from a terminal; pipe it from register --emit-token")
    data = sys.stdin.buffer.read(4097)
    if len(data) > 4096:
        fail("stdin is too large to be a single token line")
    if data.endswith(b"\n"):
        data = data[:-1]
    try:
        token = data.decode("ascii")
    except UnicodeDecodeError:
        fail("stdin is not a single ASCII token line")
    if not token:
        fail("stdin is empty")
    if not TOKEN_RE.fullmatch(token):
        fail("stdin must be exactly one token line of 16-256 URL-safe characters")
    return token


def stage(args: argparse.Namespace) -> int:
    check_key(args.pending_key)
    token = read_stdin_token()
    with DirLock(args.producer_env):
        env = read_env(args.producer_env, "producer environment file")
        new_lines = set_token(env.lines, args.pending_key, token, "producer environment")
        backup = commit(env, new_lines)
    print(f"staged pending_key={args.pending_key} backup={backup}")
    return 0


def cutover(args: argparse.Namespace) -> int:
    check_key(args.active_key)
    check_key(args.pending_key)
    if args.active_key == args.pending_key:
        fail("active and pending keys must differ")
    with DirLock(args.producer_env):
        env = read_env(args.producer_env, "producer environment file")
        pending = single_assignment(env.lines, args.pending_key, "producer environment", True)
        active = single_assignment(env.lines, args.active_key, "producer environment", True)
        if not pending.valid or not TOKEN_RE.fullmatch(pending.value):
            fail("pending value is empty or is not a valid token; stage it first")
        if active.valid and active.value == pending.value:
            fail("pending token already equals the active token")
        new_lines = list(env.lines)
        new_lines[active.index] = assignment_line(active, pending.value)
        del new_lines[pending.index]
        backup = commit(env, new_lines)
    print(f"cutover active_key={args.active_key} pending_key={args.pending_key} removed=yes backup={backup}")
    return 0


def rollback(args: argparse.Namespace) -> int:
    with DirLock(args.env):
        env = read_env(args.env, "environment file")
        backup = read_env(backup_path(args.env), "pre-producer-tokens backup")
        if backup.data == env.data:
            print("rollback=unchanged (file already matches the backup)")
            return 0
        atomic_write(env.path, backup.data, env.mode, env.uid, env.gid)
    print("rollback=restored backup_kept=yes")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Secret-safe Heimdall per-producer token rollout helper"
    )
    commands = root.add_subparsers(dest="command", required=True)

    cmd = commands.add_parser("diagnose", help="summarise the producer registry")
    cmd.add_argument("--server-env", required=True, type=Path)

    cmd = commands.add_parser("register", help="add or replace a producer record")
    cmd.add_argument("--server-env", required=True, type=Path)
    cmd.add_argument("--id", required=True)
    cmd.add_argument("--host", action="append")
    cmd.add_argument("--service", action="append")
    cmd.add_argument("--replace", action="store_true")
    cmd.add_argument("--emit-token", action="store_true")

    cmd = commands.add_parser("stage", help="store a token from stdin as the pending value")
    cmd.add_argument("--producer-env", required=True, type=Path)
    cmd.add_argument("--pending-key", default=DEFAULT_PENDING_KEY)

    cmd = commands.add_parser("cutover", help="promote the pending token to the active key")
    cmd.add_argument("--producer-env", required=True, type=Path)
    cmd.add_argument("--active-key", required=True)
    cmd.add_argument("--pending-key", default=DEFAULT_PENDING_KEY)

    cmd = commands.add_parser("rollback", help="restore the pre-producer-tokens backup")
    cmd.add_argument("--env", required=True, type=Path)
    return root


def main(argv: "Optional[list[str]]" = None) -> int:
    args = parser().parse_args(argv)
    handlers = {
        "diagnose": diagnose,
        "register": register,
        "stage": stage,
        "cutover": cutover,
        "rollback": rollback,
    }
    try:
        return handlers[args.command](args)
    except OpsError as exc:
        print(f"error={exc}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        print("error=interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 - report type and location only
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        print(
            f"error=unexpected {type(exc).__name__} at {Path(frame.filename).name}:{frame.lineno}",
            file=sys.stderr,
        )
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
