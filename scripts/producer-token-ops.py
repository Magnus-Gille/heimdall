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

Exit codes: 0 success; 3 refused or failed with the files unchanged (or, for
register, restored); 4 uncertain outcome (a change may have been applied but
could not be confirmed or undone; inspect with "diagnose"). "diagnose"
additionally uses 1 (registry absent) and 2 (registry invalid).
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import traceback
from typing import Any, NoReturn, Optional


REGISTRY_KEY = "HEIMDALL_INGEST_PRODUCERS_JSON"
LEGACY_KEY = "HEIMDALL_FLEET_TOKEN"
DEFAULT_PENDING_KEY = "HEIMDALL_PRODUCER_TOKEN_PENDING"
BACKUP_SUFFIX = ".pre-producer-tokens"
MAX_ENV_BYTES = 1024 * 1024
REDACTED = "<redacted>"

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


class UncertainError(OpsError):
    """A change may have been applied but could not be confirmed or undone."""


class PostReplaceError(UncertainError):
    """The rename succeeded but the directory fsync afterwards failed."""


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
    if any(char in text for char in ("'", "\\", "\n", "\r")):
        fail("registry contains a character that cannot be single-quoted safely")
    return text


def credential_values(producers: list, legacy_token: str) -> "set[str]":
    values = {producer["token"] for producer in producers}
    if legacy_token:
        values.add(legacy_token)
    return values


def echoes_credential(producers: list, legacy_token: str) -> bool:
    """True when an id, host or service equals any registry or legacy token."""
    secrets_seen = credential_values(producers, legacy_token)
    for producer in producers:
        for value in [producer["id"], *producer["hosts"], *producer["services"]]:
            if value in secrets_seen:
                return True
    return False


# ---------------------------------------------------------------------------
# Supported EnvironmentFile subset
# ---------------------------------------------------------------------------
# systemd parses EnvironmentFile differently from a shell (no "export", quoted
# values can span lines, backslash escapes and line continuations). Rather than
# emulate it, the helper accepts a conservative subset and refuses the rest:
#   * no carriage returns anywhere, and no line ending in a backslash;
#   * every quote opened in a value is closed on the same line;
#   * for any key the helper reads or writes: no "export" prefix, no
#     backslash in the value, and quotes only as one wrapping pair.

def unterminated_quote(value: str) -> bool:
    state = ""
    index = 0
    while index < len(value):
        char = value[index]
        if state == "'":
            if char == "'":
                state = ""
        elif state == '"':
            if char == "\\":
                index += 1
            elif char == '"':
                state = ""
        elif char == "\\":
            index += 1
        elif char in "'\"":
            state = char
        index += 1
    return bool(state)


def check_subset(lines: "list[str]", label: str) -> None:
    for number, line in enumerate(lines, start=1):
        if "\r" in line:
            fail(f"{label} has carriage returns (CRLF); unsupported, refusing (line {number})")
        if line.endswith("\\"):
            fail(f"{label} has a line ending in a backslash; unsupported, refusing (line {number})")
        stripped = line.lstrip(" \t")
        if not stripped or stripped[0] in "#;":
            continue
        if "=" in stripped and unterminated_quote(stripped.partition("=")[2]):
            fail(f"{label} has a quoted value not closed on its line; unsupported, refusing (line {number})")


# ---------------------------------------------------------------------------
# Pinned-directory transaction and private env file handling
# ---------------------------------------------------------------------------

def allowed_uids() -> "set[int]":
    uids = {os.geteuid()}
    sudo_uid = os.environ.get("SUDO_UID", "")
    if os.geteuid() == 0 and sudo_uid.isdigit():
        uids.add(int(sudo_uid))
    return uids


class Txn:
    """Holds the parent directory open (no symlink following) for a whole operation."""

    def __init__(self, path: Path, check_dir: bool, lock: bool) -> None:
        if not path.is_absolute() or not path.name:
            fail("environment file path must be absolute and name a file")
        self.dir_path = path.parent
        self.name = path.name
        self.check_dir = check_dir
        self.lock = lock
        self.fd = -1

    def shown(self, name: str) -> str:
        return str(self.dir_path / name)

    def __enter__(self) -> "Txn":
        try:
            self.fd = os.open(self.dir_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError as exc:
            fail(f"cannot open environment directory (missing, symlink, or unreadable): {exc.strerror}")
        try:
            info = os.fstat(self.fd)
            if self.check_dir:
                if info.st_uid != 0 and info.st_uid not in allowed_uids():
                    fail("environment directory is not owned by root or the current user")
                if stat.S_IMODE(info.st_mode) & 0o022:
                    fail("environment directory must not be group/world writable")
            if self.lock:
                fcntl.flock(self.fd, fcntl.LOCK_EX)
        except BaseException:
            os.close(self.fd)
            self.fd = -1
            raise
        return self

    def __exit__(self, *_exc: object) -> None:
        if self.fd >= 0:
            if self.lock:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = -1


def identity(info: os.stat_result) -> "tuple[int, int, int, int]":
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


class EnvFile:
    def __init__(self, name: str, data: bytes, info: os.stat_result) -> None:
        self.name = name
        self.data = data
        self.mode = stat.S_IMODE(info.st_mode)
        self.uid = info.st_uid
        self.gid = info.st_gid
        self.ident = identity(info)
        self.text = data.decode("utf-8")
        self.lines = self.text.split("\n")


def read_env(txn: Txn, name: str, label: str, strict: bool = True) -> EnvFile:
    shown = txn.shown(name)
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=txn.fd)
    except OSError as exc:
        fail(f"cannot open {label} {shown} (missing, symlink, or unreadable): {exc.strerror}")
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            fail(f"{label} is not a regular file: {shown}")
        if info.st_uid not in allowed_uids():
            fail(f"{label} is not owned by the current user: {shown}")
        if stat.S_IMODE(info.st_mode) & 0o077:
            fail(f"{label} must not be group/world accessible: {shown}")
        if info.st_size > MAX_ENV_BYTES:
            fail(f"{label} is unexpectedly large: {shown}")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            data = handle.read(MAX_ENV_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(data) > MAX_ENV_BYTES:
        fail(f"{label} is unexpectedly large: {shown}")
    try:
        env = EnvFile(name, data, info)
    except UnicodeError:
        fail(f"{label} is not valid UTF-8: {shown}")
    if strict:
        check_subset(env.lines, label)
    return env


def write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        view = view[written:]


def atomic_replace(
    txn: Txn,
    data: bytes,
    mode: int,
    uid: int,
    gid: int,
    expect: "Optional[tuple[int, int, int, int]]",
) -> None:
    """Replace the live file atomically, relative to the pinned directory.

    With expect set, refuse if the live file's dev/ino/size/mtime changed since
    it was read. A failure after the rename (directory fsync) raises
    PostReplaceError: the new content is in place but not confirmed durable.
    """
    temp = f".{txn.name}.producer-token-{secrets.token_hex(6)}"
    descriptor = os.open(
        temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=txn.fd
    )
    try:
        try:
            os.fchmod(descriptor, mode)
            try:
                os.fchown(descriptor, uid, gid)
            except PermissionError:
                fail("cannot preserve file owner/group on the rewritten file")
            write_all(descriptor, data)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if expect is not None:
            try:
                current = identity(os.stat(txn.name, dir_fd=txn.fd, follow_symlinks=False))
            except OSError as exc:
                fail(f"environment file disappeared during the operation: {exc.strerror}")
            if current != expect:
                fail("environment file changed during the operation; refusing to overwrite it")
        os.replace(temp, txn.name, src_dir_fd=txn.fd, dst_dir_fd=txn.fd)
    except BaseException:
        try:
            os.unlink(temp, dir_fd=txn.fd)
        except FileNotFoundError:
            pass
        raise
    try:
        os.fsync(txn.fd)
    except OSError as exc:
        raise PostReplaceError(
            f"the file was replaced but the directory sync failed ({exc.strerror}); "
            "the outcome is uncertain, inspect with diagnose"
        ) from None


def backup_name(name: str) -> str:
    return name + BACKUP_SUFFIX


def ensure_backup(txn: Txn, env: EnvFile) -> str:
    """Return created|existing; an existing backup is validated first.

    The backup is written to a private temp file, fsynced, then published with
    link() so it is complete the moment it becomes visible and never
    overwrites an existing one.
    """
    target = backup_name(txn.name)
    try:
        os.stat(target, dir_fd=txn.fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        read_env(txn, target, "pre-producer-tokens backup", strict=True)
        return "existing"
    temp = f".{target}.tmp-{secrets.token_hex(6)}"
    descriptor = os.open(
        temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=txn.fd
    )
    try:
        try:
            os.fchmod(descriptor, 0o600)
            if os.geteuid() == 0:
                os.fchown(descriptor, env.uid, env.gid)
            write_all(descriptor, env.data)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.link(temp, target, src_dir_fd=txn.fd, dst_dir_fd=txn.fd)
            created = True
        except FileExistsError:
            created = False
    finally:
        try:
            os.unlink(temp, dir_fd=txn.fd)
        except FileNotFoundError:
            pass
    if not created:
        read_env(txn, target, "pre-producer-tokens backup", strict=True)
        return "existing"
    os.fsync(txn.fd)
    return "created"


def commit(txn: Txn, env: EnvFile, new_lines: "list[str]") -> str:
    backup = ensure_backup(txn, env)
    atomic_replace(
        txn, "\n".join(new_lines).encode("utf-8"), env.mode, env.uid, env.gid, env.ident
    )
    return backup


# ---------------------------------------------------------------------------
# Assignment parsing / editing (plain KEY=value output, never "export")
# ---------------------------------------------------------------------------

def check_key(key: str) -> str:
    if not KEY_NAME_RE.fullmatch(key):
        fail("environment key names must match [A-Za-z_][A-Za-z0-9_]*")
    return key


class Assignment:
    def __init__(self, index: int, key: str, rest: str) -> None:
        self.index = index
        self.key = key
        stripped = rest.strip()
        if "\\" in stripped:
            fail(f"{key} value contains a backslash; unsupported, refusing")
        wrapper = ""
        if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in "'\"":
            wrapper = stripped[0]
            stripped = stripped[1:-1]
        # The other kind of quote is literal inside a wrapping pair; the
        # wrapper itself may not recur, and unquoted values may hold no quote.
        if (wrapper and wrapper in stripped) or (not wrapper and ("'" in stripped or '"' in stripped)):
            fail(f"{key} value has unsupported quoting; refusing")
        self.value = stripped


def assignments(lines: "list[str]", key: str) -> "list[Assignment]":
    pattern = re.compile(rf"^[ \t]*(export[ \t]+)?{re.escape(key)}[ \t]*=(.*)$")
    found = []
    for index, line in enumerate(lines):
        match = pattern.match(line)
        if match:
            if match.group(1):
                fail(f"{key} is assigned with an export prefix, which systemd does not accept; refusing")
            found.append(Assignment(index, key, match.group(2)))
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


def set_line(lines: "list[str]", existing: Optional[Assignment], line: str) -> "list[str]":
    if existing:
        result = list(lines)
        result[existing.index] = line
        return result
    return append_line(lines, line)


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


def write_status(stream: Any, lines: "list[str]") -> None:
    stream.write("\n".join(lines) + "\n")
    stream.flush()


def diagnose(args: argparse.Namespace) -> int:
    with Txn(args.server_env, check_dir=False, lock=False) as txn:
        env = read_env(txn, txn.name, "server environment file")
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
    producers, reason = parse_registry(found[0].value, legacy)
    if producers is None:
        print("registry_valid=no")
        print(f"reason={reason}")
        return 2
    secret_values = credential_values(producers, legacy)

    def shown(values: "list[str]") -> str:
        return ",".join(REDACTED if value in secret_values else value for value in values) or "-"

    print("registry_valid=yes")
    print(f"producers={len(producers)}")
    for producer in producers:
        print(
            f"producer id={shown([producer['id']])} "
            f"hosts={shown(producer['hosts'])} "
            f"services={shown(producer['services'])}"
        )
    return 0


def restore_previous(txn: Txn, env: EnvFile) -> None:
    """Put the pre-register content back; failure means the outcome is uncertain."""
    try:
        atomic_replace(txn, env.data, env.mode, env.uid, env.gid, None)
    except BaseException as exc:  # noqa: BLE001 - reported as uncertain, type only
        raise UncertainError(
            f"could not restore the previous registry ({type(exc).__name__}); "
            "the outcome is uncertain, run diagnose"
        ) from None


def register(args: argparse.Namespace) -> int:
    emit = bool(args.emit_token)
    if emit and is_tty(sys.stdout):
        fail("refusing --emit-token: stdout is a terminal; pipe it into the stage command")
    hosts = list(args.host or [])
    services = list(args.service or [])
    if not hosts and not services:
        fail("register needs at least one --host or --service scope")
    with Txn(args.server_env, check_dir=True, lock=True) as txn:
        env = read_env(txn, txn.name, "server environment file")
        legacy = legacy_token(env, "server environment")
        existing = single_assignment(env.lines, REGISTRY_KEY, "server environment", False)
        producers: list = []
        if existing:
            producers, reason = parse_registry(existing.value, legacy)
            if producers is None:
                fail(f"existing registry is invalid ({reason}); run diagnose first")
            if echoes_credential(producers, legacy):
                fail("existing registry has an id or scope equal to a credential; refusing")

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
        if echoes_credential(validated, legacy):
            fail("an id or scope would equal a credential; refusing")

        new_lines = set_line(env.lines, existing, f"{REGISTRY_KEY}='{text}'")
        try:
            backup = commit(txn, env, new_lines)
        except PostReplaceError:
            if not emit:
                raise
            restore_previous(txn, env)
            fail("directory sync failed after the registry was replaced; the change was rolled back")

        status = [
            f"registered id={args.id} action={action} producers={len(validated)}",
            f"hosts={','.join(hosts) or '-'} services={','.join(services) or '-'}",
            f"backup={backup} token={'emitted-to-stdout' if emit else 'stored-not-shown'}",
        ]
        try:
            if emit:
                # Token first, then status; either failing undoes the change.
                sys.stdout.write(token + "\n")
                sys.stdout.flush()
                write_status(sys.stderr, status)
            else:
                write_status(sys.stdout, status)
        except BaseException as exc:  # noqa: BLE001 - restore, then report type only
            restore_previous(txn, env)
            if isinstance(exc, KeyboardInterrupt):
                raise
            fail(
                f"writing the output failed ({type(exc).__name__}); "
                "the registry change was rolled back"
            )
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
    with Txn(args.producer_env, check_dir=True, lock=True) as txn:
        env = read_env(txn, txn.name, "producer environment file")
        existing = single_assignment(env.lines, args.pending_key, "producer environment", False)
        new_lines = set_line(env.lines, existing, f"{args.pending_key}={token}")
        backup = commit(txn, env, new_lines)
    print(f"staged pending_key={args.pending_key} backup={backup}")
    return 0


def cutover(args: argparse.Namespace) -> int:
    check_key(args.active_key)
    check_key(args.pending_key)
    if args.active_key == args.pending_key:
        fail("active and pending keys must differ")
    with Txn(args.producer_env, check_dir=True, lock=True) as txn:
        env = read_env(txn, txn.name, "producer environment file")
        pending = single_assignment(env.lines, args.pending_key, "producer environment", True)
        active = single_assignment(env.lines, args.active_key, "producer environment", True)
        if not TOKEN_RE.fullmatch(pending.value):
            fail("pending value is empty or is not a valid token; stage it first")
        if active.value == pending.value:
            fail("pending token already equals the active token")
        new_lines = list(env.lines)
        new_lines[active.index] = f"{args.active_key}={pending.value}"
        del new_lines[pending.index]
        backup = commit(txn, env, new_lines)
    print(f"cutover active_key={args.active_key} pending_key={args.pending_key} removed=yes backup={backup}")
    return 0


def rollback(args: argparse.Namespace) -> int:
    with Txn(args.env, check_dir=True, lock=True) as txn:
        # The live file may be in any state (that is why we are rolling back);
        # the backup must satisfy every check, including the supported subset.
        env = read_env(txn, txn.name, "environment file", strict=False)
        backup = read_env(txn, backup_name(txn.name), "pre-producer-tokens backup", strict=True)
        if backup.data == env.data:
            print("rollback=unchanged (file already matches the backup)")
            return 0
        atomic_replace(txn, backup.data, env.mode, env.uid, env.gid, env.ident)
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


def report(message: str) -> None:
    try:
        print(message, file=sys.stderr)
    except (OSError, ValueError):
        pass


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
    except UncertainError as exc:
        report(f"error={exc}")
        return 4
    except OpsError as exc:
        report(f"error={exc}")
        return 3
    except KeyboardInterrupt:
        report("error=interrupted")
        return 130
    except Exception as exc:  # noqa: BLE001 - report type and location only
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        report(
            f"error=unexpected {type(exc).__name__} at {Path(frame.filename).name}:{frame.lineno}"
        )
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
