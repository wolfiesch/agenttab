#!/usr/bin/env python3
"""Verify AgentTab's offline permission decision and explicit PR3 live lifecycle.

Without ``--live-lifecycle`` this remains the PR1 decision gate: it only derives
and validates a reduced manifest in memory.  It neither writes extension files,
opens Chrome, reloads an extension, nor changes Chrome permissions.

The explicit live mode runs only against a preloaded AgentTab candidate on the
trusted macOS runner.  It observes permission changes made by a human through
the AgentTab UI; this probe never calls ``chrome.permissions.request`` or
``chrome.permissions.remove``.  Its only mutations are local fixture HTTP
requests and task-owned tabs created through AgentTab Core RPC.  Cleanup closes
those tabs, restores the original optional-permission state through a human UI
checkpoint, and removes only the exact fixture download from an explicit test
download directory.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Iterator
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import uuid


ROOT = Path(__file__).resolve().parents[2]
ROOT_MANIFEST = ROOT / "manifest.json"
MIRROR_MANIFEST = ROOT / "extension" / "manifest.json"
REQUIRED_PERMISSIONS = (
    "nativeMessaging",
    "tabs",
    "tabGroups",
    "storage",
    "alarms",
    "downloads",
)
OPTIONAL_PERMISSIONS = ("scripting", "debugger")
REMOVED_PERMISSIONS = (
    "activeTab",
    "bookmarks",
    "contentSettings",
    "cookies",
    "history",
)
HOST_PERMISSIONS = ("<all_urls>",)
CORE_PROTOCOL = "agenttab.rpc"
CORE_VERSION = 1
MAX_CORE_FRAME_BYTES = 64 * 1024 * 1024
MAX_DEVTOOLS_FRAME_BYTES = 1024 * 1024
EXTENSION_ID_LENGTH = 32


class GateFailure(RuntimeError):
    """A deterministic gate failure safe to put in the scrubbed report."""


class ChromeOperationFailure(GateFailure):
    """Names the Chrome API operation without echoing page or profile data."""


def manifest_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise GateFailure(f"cannot read {path.relative_to(ROOT)}: {error}") from error


def parse_manifest(path: Path, payload: bytes) -> dict[str, Any]:
    try:
        value = json.loads(payload)
    except json.JSONDecodeError as error:
        raise GateFailure(f"invalid JSON in {path.relative_to(ROOT)}: {error}") from error
    if not isinstance(value, dict):
        raise GateFailure(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def string_set(manifest: dict[str, Any], key: str) -> set[str]:
    value = manifest.get(key, [])
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise GateFailure(f"manifest {key} must be an array of strings")
    return set(value)


def reduced_manifest(source: dict[str, Any]) -> dict[str, Any]:
    staged = json.loads(json.dumps(source))
    staged["permissions"] = list(REQUIRED_PERMISSIONS)
    staged["optional_permissions"] = list(OPTIONAL_PERMISSIONS)
    staged["host_permissions"] = list(HOST_PERMISSIONS)
    return staged


def canonical_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def verify() -> dict[str, Any]:
    """Run the side-effect-free PR1 manifest decision gate."""
    root_bytes = manifest_bytes(ROOT_MANIFEST)
    mirror_bytes = manifest_bytes(MIRROR_MANIFEST)
    if root_bytes != mirror_bytes:
        raise GateFailure("manifest.json and extension/manifest.json differ")

    source = parse_manifest(ROOT_MANIFEST, root_bytes)
    if source.get("manifest_version") != 3:
        raise GateFailure("permission gate requires a Manifest V3 source")

    source_grants = string_set(source, "permissions") | string_set(source, "optional_permissions")
    expected_grants = set(REQUIRED_PERMISSIONS) | set(OPTIONAL_PERMISSIONS)
    missing = sorted(expected_grants - source_grants)
    if missing:
        raise GateFailure(f"source manifest cannot produce target; missing grants: {missing}")
    if not set(HOST_PERMISSIONS).issubset(string_set(source, "host_permissions")):
        raise GateFailure("source manifest cannot produce target; <all_urls> is missing")

    staged = reduced_manifest(source)
    required = string_set(staged, "permissions")
    optional = string_set(staged, "optional_permissions")
    host = string_set(staged, "host_permissions")
    if required != set(REQUIRED_PERMISSIONS):
        raise GateFailure("staged required permissions differ from the ADR target")
    if optional != set(OPTIONAL_PERMISSIONS):
        raise GateFailure("staged optional permissions differ from the ADR target")
    if host != set(HOST_PERMISSIONS):
        raise GateFailure("staged host permissions differ from the ADR target")
    forbidden = sorted((required | optional) & set(REMOVED_PERMISSIONS))
    if forbidden:
        raise GateFailure(f"staged manifest retains forbidden permissions: {forbidden}")

    staged_bytes = canonical_bytes(staged)
    if staged_bytes != canonical_bytes(reduced_manifest(source)):
        raise GateFailure("reduced manifest transformation is not deterministic")

    return {
        "schema_version": 1,
        "decision_gate": True,
        "installed_extension_modified": False,
        "permissions": list(REQUIRED_PERMISSIONS),
        "optional_permissions": list(OPTIONAL_PERMISSIONS),
        "host_permissions": list(HOST_PERMISSIONS),
        "removed_permissions": list(REMOVED_PERMISSIONS),
        "active_tab_retained": False,
        "source_manifest_sha256": hashlib.sha256(root_bytes).hexdigest(),
        "staged_manifest_sha256": hashlib.sha256(staged_bytes).hexdigest(),
    }


def uuid7() -> str:
    """Generate a UUIDv7 without depending on the runner's Python minor version."""
    milliseconds = int(time.time() * 1000)
    if not 0 <= milliseconds < 1 << 48:
        raise GateFailure("cannot generate Core RPC UUIDv7 idempotency key")
    value = (
        (milliseconds << 80)
        | (0x7 << 76)
        | (secrets.randbits(12) << 64)
        | (0b10 << 62)
        | secrets.randbits(62)
    )
    return str(uuid.UUID(int=value))


def request_id() -> str:
    return f"live-{uuid.uuid4().hex}"


def scrubbed_error_code(response: dict[str, Any]) -> str:
    error = response.get("error")
    return error.get("code", "missing_error_code") if isinstance(error, dict) else "missing_error_code"



def response_outcome(response: dict[str, Any]) -> str:
    value = response.get("outcome")
    return value if isinstance(value, str) else "missing_outcome"


def require_completed(operation: str, response: dict[str, Any]) -> dict[str, Any]:
    if response.get("ok") is True and response_outcome(response) == "completed":
        result = response.get("result")
        if isinstance(result, dict):
            return result
        raise GateFailure(f"{operation}: completed response omitted object result")
    raise GateFailure(
        f"{operation}: expected completed; received {response_outcome(response)}"
        f" ({scrubbed_error_code(response)})"
    )


def require_denied(
    operation: str,
    response: dict[str, Any],
    allowed_codes: set[str] | None = None,
    prefix: str | None = None,
) -> None:
    code = scrubbed_error_code(response)
    if response.get("ok") is not False or response_outcome(response) != "not_started":
        raise GateFailure(f"{operation}: expected not_started denial; received {response_outcome(response)} ({code})")
    if allowed_codes is not None and code not in allowed_codes:
        raise GateFailure(f"{operation}: expected one of {sorted(allowed_codes)}; received {code}")
    if prefix is not None and not code.startswith(prefix):
        raise GateFailure(f"{operation}: expected error code prefixed {prefix}; received {code}")


def require_result_int(result: dict[str, Any], field: str, operation: str) -> int:
    value = result.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise GateFailure(f"{operation}: result.{field} must be a non-negative integer")
    return value


def require_result_string(result: dict[str, Any], field: str, operation: str) -> str:
    value = result.get(field)
    if not isinstance(value, str) or not value:
        raise GateFailure(f"{operation}: result.{field} must be a non-empty string")
    return value


def normalize_label(value: Any) -> str:
    if isinstance(value, str):
        return value.casefold()
    if isinstance(value, dict):
        for key in ("value", "name", "text", "label"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                return candidate.casefold()
    return ""


def find_named_ref(value: Any, expected_name: str, expected_role: str | None = None) -> str | None:
    """Find an accessibility ref without retaining or printing snapshot contents."""
    needle = expected_name.casefold()
    role = expected_role.casefold() if expected_role is not None else None
    if isinstance(value, dict):
        ref = value.get("ref")
        labels = (
            normalize_label(value.get("name")),
            normalize_label(value.get("label")),
            normalize_label(value.get("text")),
            normalize_label(value.get("description")),
        )
        role_matches = role is None or normalize_label(value.get("role")) == role
        if isinstance(ref, str) and ref and role_matches and any(needle in label for label in labels):
            return ref
        for child in value.values():
            found = find_named_ref(child, expected_name, expected_role)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_named_ref(child, expected_name, expected_role)
            if found is not None:
                return found
    return None


def contains_text(value: Any, expected: str) -> bool:
    """Check fixture-only text without serializing a snapshot to output."""
    if isinstance(value, str):
        return expected in value
    if isinstance(value, dict):
        return any(contains_text(item, expected) for item in value.values())
    if isinstance(value, list):
        return any(contains_text(item, expected) for item in value)
    return False


class CoreRpcClient:
    """Strict Unix-socket Core RPC client for the live candidate only."""

    def __init__(self, socket_path: Path, timeout_seconds: float) -> None:
        self.socket_path = socket_path
        self.timeout_seconds = timeout_seconds
        self.connection: socket.socket | None = None
        self.resume_capability: str | None = None
        self.task_id: str | None = None

    def connect(self, resume_capability: str | None = None) -> None:
        socket_ready_deadline = time.monotonic() + self.timeout_seconds
        while True:
            try:
                file_mode = self.socket_path.stat().st_mode
                break
            except OSError as error:
                if time.monotonic() >= socket_ready_deadline:
                    raise GateFailure(
                        "AgentTab Core socket stat failed before Chrome API interaction"
                    ) from error
                time.sleep(0.1)
        if not stat.S_ISSOCK(file_mode):
            raise GateFailure("AgentTab Core socket path is not a Unix-domain socket")
        if self.socket_path.stat().st_uid != os.getuid():
            raise GateFailure("AgentTab Core socket is not owned by the current user")
        if stat.S_IMODE(file_mode) & 0o077:
            raise GateFailure("AgentTab Core socket permissions are broader than 0600")

        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout_seconds)
        try:
            connection.connect(os.fspath(self.socket_path))
            self.connection = connection
            hello: dict[str, Any] = {
                "protocol": CORE_PROTOCOL,
                "version": CORE_VERSION,
                "kind": "connect",
            }
            if resume_capability is not None:
                hello["resume_capability"] = resume_capability
            self._send(hello)
            reply = self._recv()
        except OSError as error:
            connection.close()
            self.connection = None
            raise GateFailure("AgentTab Core connect failed before Chrome API interaction") from error

        if reply.get("protocol") != CORE_PROTOCOL or reply.get("version") != CORE_VERSION:
            self.close()
            raise GateFailure("AgentTab Core connect returned incompatible protocol")
        connection_id = reply.get("connection_id")
        resumed = reply.get("resumed")
        task_id = reply.get("task_id")
        capability = reply.get("resume_capability")
        if not isinstance(connection_id, str) or not connection_id:
            self.close()
            raise GateFailure("AgentTab Core connect omitted connection_id")
        if not isinstance(resumed, bool):
            self.close()
            raise GateFailure("AgentTab Core connect omitted resumed state")
        if resumed:
            if not isinstance(task_id, str) or not task_id:
                self.close()
                raise GateFailure("resumed AgentTab Core connect omitted task_id")
            if not isinstance(capability, str) or len(capability) < 32:
                self.close()
                raise GateFailure("resumed AgentTab Core connect omitted rotated capability")
            self.task_id = task_id
            self.resume_capability = capability
        else:
            if task_id is not None or capability is not None:
                self.close()
                raise GateFailure("new AgentTab Core connect created a task before first browser use")
            self.task_id = None
            self.resume_capability = None

    def close(self) -> None:
        if self.connection is not None:
            with contextlib.suppress(OSError):
                self.connection.close()
        self.connection = None

    def _require_connection(self) -> socket.socket:
        if self.connection is None:
            raise GateFailure("AgentTab Core request attempted without a connection")
        return self.connection

    def _send(self, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_CORE_FRAME_BYTES:
            raise GateFailure("AgentTab Core request exceeds framing limit")
        try:
            self._require_connection().sendall(struct.pack("<I", len(encoded)) + encoded)
        except OSError as error:
            raise GateFailure("AgentTab Core write failed") from error

    def _read_exact(self, count: int) -> bytes:
        chunks: list[bytes] = []
        remaining = count
        try:
            connection = self._require_connection()
            while remaining:
                chunk = connection.recv(remaining)
                if not chunk:
                    raise GateFailure("AgentTab Core read ended before frame completion")
                chunks.append(chunk)
                remaining -= len(chunk)
        except OSError as error:
            raise GateFailure("AgentTab Core read failed") from error
        return b"".join(chunks)

    def _recv(self) -> dict[str, Any]:
        declared = struct.unpack("<I", self._read_exact(4))[0]
        if declared > MAX_CORE_FRAME_BYTES:
            raise GateFailure("AgentTab Core declared an oversize response frame")
        try:
            value = json.loads(self._read_exact(declared))
        except json.JSONDecodeError as error:
            raise GateFailure("AgentTab Core returned invalid JSON") from error
        if not isinstance(value, dict):
            raise GateFailure("AgentTab Core returned a non-object frame")
        return value

    def _bind_task(self, response: dict[str, Any]) -> None:
        binding = response.get("task")
        if binding is None:
            return
        if not isinstance(binding, dict):
            raise GateFailure("AgentTab Core response task binding is not an object")
        task_id = binding.get("task_id")
        capability = binding.get("resume_capability")
        if not isinstance(task_id, str) or not task_id:
            raise GateFailure("AgentTab Core response task binding omitted task_id")
        if self.task_id is not None and task_id != self.task_id:
            raise GateFailure("AgentTab Core response changed the connection task_id")
        if self.task_id is None and (not isinstance(capability, str) or len(capability) < 32):
            raise GateFailure("first AgentTab Core task binding omitted resume capability")
        if capability is not None and (not isinstance(capability, str) or len(capability) < 32):
            raise GateFailure("AgentTab Core response returned an invalid resume capability")
        self.task_id = task_id
        if isinstance(capability, str):
            self.resume_capability = capability

    def call(
        self,
        method: str,
        params: dict[str, Any],
        *,
        mutation: bool = False,
        idempotency_key: str | None = None,
    ) -> tuple[dict[str, Any], str | None]:
        payload: dict[str, Any] = {
            "protocol": CORE_PROTOCOL,
            "version": CORE_VERSION,
            "request_id": request_id(),
            "method": method,
            "params": params,
        }
        key = idempotency_key
        if mutation:
            key = key or uuid7()
            payload["idempotency_key"] = key
        self._send(payload)
        expected_request_id = payload["request_id"]
        while True:
            response = self._recv()
            if response.get("request_id") != expected_request_id:
                # Lifecycle events may share this connection, but a different Core
                # response means the host broke its connection-scoped routing contract.
                if "request_id" in response:
                    raise GateFailure("AgentTab Core routed a response to the wrong request_id")
                continue
            if response.get("protocol") != CORE_PROTOCOL or response.get("version") != CORE_VERSION:
                raise GateFailure("AgentTab Core response protocol mismatch")
            self._bind_task(response)
            return response, key


class DevToolsSocket:
    """A minimal, read-only DevTools client for fixed AgentTab inspection calls."""

    def __init__(self, websocket_url: str, timeout_seconds: float) -> None:
        parsed = urlparse(websocket_url)
        if parsed.scheme != "ws" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise GateFailure("Chrome DevTools websocket must be loopback ws://")
        if parsed.port is None:
            raise GateFailure("Chrome DevTools websocket must include a port")
        self._socket = socket.create_connection((parsed.hostname, parsed.port), timeout=timeout_seconds)
        self._socket.settimeout(timeout_seconds)
        self._next_id = 1
        path = parsed.path or "/"
        if parsed.query:
            path += f"?{parsed.query}"
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        self._socket.sendall(request)
        response = self._recv_http_headers()
        if not response.startswith(b"HTTP/1.1 101"):
            self.close()
            raise GateFailure("Chrome DevTools websocket upgrade failed")

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self._socket.close()

    def _recv_http_headers(self) -> bytes:
        received = bytearray()
        while b"\r\n\r\n" not in received:
            if len(received) > 16384:
                raise GateFailure("Chrome DevTools websocket headers exceed limit")
            chunk = self._socket.recv(1024)
            if not chunk:
                raise GateFailure("Chrome DevTools websocket closed during handshake")
            received.extend(chunk)
        return bytes(received)

    def _read_exact(self, count: int) -> bytes:
        received = bytearray()
        while len(received) < count:
            chunk = self._socket.recv(count - len(received))
            if not chunk:
                raise GateFailure("Chrome DevTools websocket closed during frame")
            received.extend(chunk)
        return bytes(received)

    def _send_json(self, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_DEVTOOLS_FRAME_BYTES:
            raise GateFailure("Chrome DevTools inspection request exceeds limit")
        mask = secrets.token_bytes(4)
        length = len(encoded)
        if length < 126:
            header = bytes((0x81, 0x80 | length))
        elif length <= 0xFFFF:
            header = bytes((0x81, 0x80 | 126)) + struct.pack(">H", length)
        else:
            header = bytes((0x81, 0x80 | 127)) + struct.pack(">Q", length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(encoded))
        self._socket.sendall(header + mask + masked)

    def _recv_json(self) -> dict[str, Any]:
        while True:
            first, second = self._read_exact(2)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exact(8))[0]
            if length > MAX_DEVTOOLS_FRAME_BYTES:
                raise GateFailure("Chrome DevTools declared an oversize inspection frame")
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length)
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 0x8:
                raise GateFailure("Chrome DevTools websocket closed")
            if opcode == 0x9:
                self._socket.sendall(bytes((0x8A, len(payload))) + payload)
                continue
            if opcode != 0x1:
                continue
            try:
                value = json.loads(payload)
            except json.JSONDecodeError as error:
                raise GateFailure("Chrome DevTools returned invalid JSON") from error
            if not isinstance(value, dict):
                raise GateFailure("Chrome DevTools returned a non-object frame")
            return value

    def evaluate(self, expression: str, operation: str) -> dict[str, Any]:
        command_id = self._next_id
        self._next_id += 1
        self._send_json({
            "id": command_id,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "userGesture": False,
            },
        })
        while True:
            message = self._recv_json()
            if message.get("id") != command_id:
                continue
            result = message.get("result")
            if not isinstance(result, dict) or "exceptionDetails" in result:
                raise ChromeOperationFailure(f"Chrome DevTools Runtime.evaluate ({operation}) failed")
            remote = result.get("result")
            if not isinstance(remote, dict) or not isinstance(remote.get("value"), dict):
                raise ChromeOperationFailure(f"Chrome DevTools Runtime.evaluate ({operation}) returned no object")
            return remote["value"]


class ChromeInspector:
    """Use the candidate extension target for fixed, read-only Chrome API checks."""

    _READ_ONLY_STATE = """(async () => {
      const contains = (permission) => new Promise((resolve) =>
        chrome.permissions.contains({ permissions: [permission] }, resolve));
      const [scripting, debuggerPermission, activeTabs, uiState] = await Promise.all([
        contains('scripting'),
        contains('debugger'),
        chrome.tabs.query({ active: true, lastFocusedWindow: true }),
        chrome.runtime.sendMessage({ kind: 'get_ui_state' }),
      ]);
      const targetState = await new Promise((resolve) => {
        if (!chrome.debugger?.getTargets) {
          resolve({ available: false, targets: [] });
          return;
        }
        chrome.debugger.getTargets((targets) => {
          const failed = Boolean(chrome.runtime.lastError);
          resolve({ available: !failed, targets: Array.isArray(targets) ? targets : [] });
        });
      });
      const tasks = Array.isArray(uiState?.tasks) ? uiState.tasks : [];
      return {
        runtime_id: chrome.runtime.id,
        scripting: Boolean(scripting),
        debugger_permission: Boolean(debuggerPermission),
        active_window_id: activeTabs[0]?.windowId ?? null,
        active_tab_id: activeTabs[0]?.id ?? null,
        debugger_targets_available: targetState.available,
        attached_tab_ids: targetState.targets
          .filter((target) => target.attached && Number.isInteger(target.tabId))
          .map((target) => target.tabId),
        task_ids: tasks
          .map((task) => task?.task_id)
          .filter((taskId) => typeof taskId === 'string'),
      };
    })()"""

    def __init__(self, debugging_url: str, extension_id: str, timeout_seconds: float) -> None:
        parsed = urlparse(debugging_url)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise GateFailure("Chrome DevTools HTTP endpoint must be loopback http://")
        if parsed.port is None:
            raise GateFailure("Chrome DevTools HTTP endpoint must include a port")
        self.debugging_url = debugging_url.rstrip("/")
        self.extension_id = extension_id
        self.timeout_seconds = timeout_seconds

    def _candidate_websocket(self) -> str:
        try:
            request = Request(f"{self.debugging_url}/json/list", headers={"Accept": "application/json"})
            with urlopen(request, timeout=self.timeout_seconds) as response:
                targets = json.load(response)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise ChromeOperationFailure("Chrome DevTools GET /json/list failed") from error
        if not isinstance(targets, list):
            raise ChromeOperationFailure("Chrome DevTools GET /json/list returned invalid targets")
        prefix = f"chrome-extension://{self.extension_id}/"
        candidates: list[tuple[str, str]] = []
        for target in targets:
            if not isinstance(target, dict):
                continue
            target_type = target.get("type")
            url = target.get("url")
            websocket = target.get("webSocketDebuggerUrl")
            if (
                target_type in {"service_worker", "page"}
                and isinstance(url, str)
                and url.startswith(prefix)
                and isinstance(websocket, str)
            ):
                candidates.append((target_type, websocket))
        for preferred_type in ("service_worker", "page"):
            for target_type, websocket in candidates:
                if target_type == preferred_type:
                    return websocket
        raise ChromeOperationFailure("Chrome target discovery requires a live AgentTab extension target")

    def _evaluate(self, expression: str, operation: str) -> dict[str, Any]:
        channel = DevToolsSocket(self._candidate_websocket(), self.timeout_seconds)
        try:
            return channel.evaluate(expression, operation)
        finally:
            channel.close()

    def state(self) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            try:
                state = self._evaluate(self._READ_ONLY_STATE, "candidate-state")
                break
            except ChromeOperationFailure:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        if state.get("runtime_id") != self.extension_id:
            raise ChromeOperationFailure("chrome.runtime.id did not match the requested AgentTab candidate")
        if not isinstance(state.get("scripting"), bool) or not isinstance(state.get("debugger_permission"), bool):
            raise ChromeOperationFailure("chrome.permissions.contains returned invalid automation state")
        if not isinstance(state.get("active_window_id"), int) or not isinstance(state.get("active_tab_id"), int):
            raise ChromeOperationFailure("chrome.tabs.query(active,lastFocusedWindow) returned no active IDs")
        if not isinstance(state.get("debugger_targets_available"), bool):
            raise ChromeOperationFailure("chrome.debugger.getTargets returned invalid availability state")
        attached = state.get("attached_tab_ids")
        if not isinstance(attached, list) or any(not isinstance(tab_id, int) for tab_id in attached):
            raise ChromeOperationFailure("chrome.debugger.getTargets returned invalid attachment state")
        task_ids = state.get("task_ids")
        if not isinstance(task_ids, list) or any(not isinstance(task_id, str) for task_id in task_ids):
            raise ChromeOperationFailure("AgentTab UI state returned invalid task inventory")
        return state

    def assert_permission(self, permission: str, expected: bool, operation: str) -> None:
        field = "debugger_permission" if permission == "debugger" else permission
        actual = self.state()[field]
        if actual is not expected:
            expected_text = "granted" if expected else "not granted"
            raise ChromeOperationFailure(
                f"chrome.permissions.contains({permission}) ({operation}) expected {expected_text}"
            )

    def assert_automation_permissions(self, expected: bool, operation: str) -> None:
        self.assert_permission("scripting", expected, operation)
        self.assert_permission("debugger", expected, operation)

    def selection(self) -> tuple[int, int]:
        state = self.state()
        return state["active_window_id"], state["active_tab_id"]

    def assert_selection_unchanged(self, before: tuple[int, int], operation: str) -> None:
        after = self.selection()
        if after != before:
            raise ChromeOperationFailure(
                f"chrome.tabs.query(active,lastFocusedWindow) ({operation}) changed active window/tab IDs "
                f"from {before} to {after}"
            )

    def debugger_is_attached(self, tab_id: int) -> bool:
        state = self.state()
        if state["debugger_permission"] and not state["debugger_targets_available"]:
            raise ChromeOperationFailure("chrome.debugger.getTargets unavailable while debugger permission is granted")
        return tab_id in state["attached_tab_ids"]

    def task_ids(self) -> set[str]:
        return set(self.state()["task_ids"])

    def runtime_instance(self) -> str:
        result = self._evaluate(
            "chrome.runtime.sendMessage({ kind: 'runtime_instance' })",
            "candidate-runtime-instance",
        )
        value = result.get("runtime_instance")
        if not isinstance(value, str) or not value:
            raise ChromeOperationFailure("AgentTab candidate omitted its private runtime instance")
        return value

    def automation_revocation_generation(self) -> int:
        result = self._evaluate(
            "chrome.runtime.sendMessage({ kind: 'automation_revocation_state' })",
            "candidate-automation-revocation-state",
        )
        value = result.get("generation")
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ChromeOperationFailure("AgentTab candidate omitted its private revocation generation")
        return value

    def assert_candidate_files(self, file_digests: dict[str, str]) -> None:
        encoded = json.dumps(file_digests, separators=(",", ":"), sort_keys=True)
        result = self._evaluate(
            f"""(async () => {{
              const expected = {encoded};
              let checkedCount = 0;
              for (const [path, expectedDigest] of Object.entries(expected)) {{
                const response = await fetch(chrome.runtime.getURL(path), {{ cache: 'no-store' }});
                if (!response.ok) return {{ matches: false, checked_count: checkedCount }};
                const bytes = new Uint8Array(await response.arrayBuffer());
                const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
                  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
                checkedCount += 1;
                if (digest !== expectedDigest) return {{ matches: false, checked_count: checkedCount }};
              }}
              return {{ matches: true, checked_count: checkedCount }};
            }})()""",
            "candidate-file-digests",
        )
        if result.get("matches") is not True or result.get("checked_count") != len(file_digests):
            raise ChromeOperationFailure("loaded AgentTab files differ from --candidate-dir")

    def close_task(self, task_id: str) -> None:
        encoded_task_id = json.dumps(task_id)
        result = self._evaluate(
            f"chrome.runtime.sendMessage({{ kind: 'close_task', task_id: {encoded_task_id} }})",
            "candidate-task-cleanup",
        )
        if result.get("closed") is not True:
            raise ChromeOperationFailure("AgentTab task cleanup was not accepted")

    def request_reload(self) -> None:
        result = self._evaluate(
            "(() => { setTimeout(() => chrome.runtime.reload(), 0); return { scheduled: true }; })()",
            "candidate-reload",
        )
        if result.get("scheduled") is not True:
            raise ChromeOperationFailure("Chrome DevTools candidate reload was not scheduled")


class LifecycleFixture(http.server.ThreadingHTTPServer):
    """A loopback-only fixture that serves no user data and suppresses request logs."""

    allow_reuse_address = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), LifecycleFixtureHandler)
        self.download_filename = "agenttab-permission-probe-unset.txt"

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"


class LifecycleFixtureHandler(http.server.BaseHTTPRequestHandler):
    server: LifecycleFixture

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _reply(self, status_code: int, body: bytes, content_type: str) -> None:
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        filename = self.server.download_filename
        if self.path == "/":
            body = f"""<!doctype html><title>AgentTab lifecycle fixture</title>
<label>Task field <input id=task-field aria-label="Task field" oninput="window.inputCount=(window.inputCount||0)+1;count.textContent='Input count '+window.inputCount"></label>
<p id=count>Input count 0</p>
<button id=harmless aria-label="Harmless action">Harmless action</button>
<button id=popup aria-label="Open popup" onclick="window.open('/popup','agenttab-popup')">Open popup</button>
<a aria-label="Download harmless fixture" href="/download/{filename}" download>Download harmless fixture</a>
""".encode("utf-8")
            self._reply(200, body, "text/html; charset=utf-8")
            return
        if self.path == "/popup":
            self._reply(200, b"<!doctype html><title>AgentTab popup fixture</title><p>Owned popup</p>", "text/html; charset=utf-8")
            return
        if self.path == "/replacement":
            self._reply(200, b"<!doctype html><title>Replacement</title><p>Replacement document</p>", "text/html; charset=utf-8")
            return
        if self.path == "/handoff":
            body = b"""<!doctype html><title>AgentTab handoff fixture</title><p>Handoff active</p>
<script>setTimeout(() => location.assign('/handoff-complete'), 1500)</script>"""
            self._reply(200, body, "text/html; charset=utf-8")
            return
        if self.path == "/handoff-complete":
            self._reply(200, b"<!doctype html><title>Handoff complete</title><p>Handoff complete</p>", "text/html; charset=utf-8")
            return
        if self.path == f"/download/{filename}":
            body = b"AgentTab lifecycle fixture download\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        self._reply(404, b"not found\n", "text/plain; charset=utf-8")


@contextlib.contextmanager
def lifecycle_fixture() -> Iterator[LifecycleFixture]:
    fixture = LifecycleFixture()
    thread = threading.Thread(target=fixture.serve_forever, name="agenttab-live-fixture", daemon=True)
    thread.start()
    try:
        yield fixture
    finally:
        fixture.shutdown()
        fixture.server_close()
        thread.join(timeout=2)


def parse_command(value: str, option: str) -> list[str]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise GateFailure(f"{option} must be a JSON argument array, not a shell command") from error
    if not isinstance(parsed, list) or not parsed or any(not isinstance(item, str) or not item for item in parsed):
        raise GateFailure(f"{option} must be a non-empty JSON array of non-empty strings")
    return parsed


def validate_extension_id(value: str) -> str:
    if len(value) != EXTENSION_ID_LENGTH or any(character < "a" or character > "p" for character in value):
        raise GateFailure("--extension-id must be the 32-character Chrome extension ID")
    return value


def extension_id_from_manifest_key(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise GateFailure("live candidate manifest must contain its trusted unpacked-extension key")
    try:
        public_key = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise GateFailure("live candidate manifest key is not valid base64") from error
    if not public_key:
        raise GateFailure("live candidate manifest key decoded to an empty value")
    digest = hashlib.sha256(public_key).digest()
    return "".join(
        chr(ord("a") + nibble)
        for byte in digest[:16]
        for nibble in (byte >> 4, byte & 0x0F)
    )


def validate_candidate(candidate_dir: Path) -> tuple[str, str, dict[str, str], str]:
    manifest_path = candidate_dir / "manifest.json"
    try:
        resolved_candidate = candidate_dir.resolve(strict=True)
        payload = manifest_path.read_bytes()
    except OSError as error:
        raise GateFailure("candidate manifest could not be read") from error
    if not resolved_candidate.is_dir():
        raise GateFailure("--candidate-dir must name the unpacked candidate directory")
    manifest = parse_manifest(manifest_path, payload)
    if manifest.get("manifest_version") != 3 or manifest.get("name") != "AgentTab":
        raise GateFailure("candidate manifest is not the AgentTab Manifest V3 candidate")
    if string_set(manifest, "permissions") != set(REQUIRED_PERMISSIONS):
        raise GateFailure("candidate manifest required permissions differ from the locked target")
    if string_set(manifest, "optional_permissions") != set(OPTIONAL_PERMISSIONS):
        raise GateFailure("candidate manifest optional permissions differ from the locked target")
    if string_set(manifest, "host_permissions") != set(HOST_PERMISSIONS):
        raise GateFailure("candidate manifest host permissions differ from the locked target")

    extension_id = extension_id_from_manifest_key(manifest.get("key"))
    file_digests: dict[str, str] = {}
    for path in sorted(resolved_candidate.rglob("*")):
        if path.is_symlink():
            raise GateFailure("candidate directory must not contain symbolic links")
        if path.is_dir():
            continue
        if not path.is_file():
            raise GateFailure("candidate directory contains a non-regular entry")
        relative = path.relative_to(resolved_candidate).as_posix()
        try:
            file_digests[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            raise GateFailure("candidate file could not be read") from error
    if "manifest.json" not in file_digests:
        raise GateFailure("candidate directory omitted manifest.json")
    tree_digest = hashlib.sha256(canonical_bytes(file_digests)).hexdigest()
    return hashlib.sha256(payload).hexdigest(), extension_id, file_digests, tree_digest


def validate_download_directory(download_dir: Path) -> Path:
    try:
        resolved = download_dir.resolve(strict=True)
    except OSError as error:
        raise GateFailure("--download-dir must name an existing disposable test directory") from error
    if not resolved.is_dir() or resolved in {Path("/").resolve(), Path.home().resolve(), ROOT.resolve()}:
        raise GateFailure("--download-dir must be an explicit disposable directory, not root, home, or the repository")
    return resolved


def run_control_command(command: list[str], operation: str) -> None:
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GateFailure(f"{operation} failed before Chrome API verification") from error
    if completed.returncode != 0:
        raise GateFailure(f"{operation} returned a non-zero status")


class LiveLifecycleProbe:
    """Runs one complete lifecycle matrix while retaining only scrubbed evidence."""

    def __init__(self, args: argparse.Namespace, candidate_file_digests: dict[str, str]) -> None:
        self.args = args
        self.client = CoreRpcClient(args.socket, args.timeout_seconds)
        self.inspector = ChromeInspector(args.debugging_url, args.extension_id, args.timeout_seconds)
        self.download_dir = validate_download_directory(args.download_dir)
        self.candidate_file_digests = candidate_file_digests
        self.owned_tabs: set[int] = set()
        self.replay_request: tuple[dict[str, Any], str] | None = None
        self.initial_automation_permissions: bool | None = None

    def prompt(self, phase: str, instruction: str) -> None:
        if not self.args.interactive or not sys.stdin.isatty():
            raise GateFailure(f"{phase} requires --interactive with a terminal; the probe will not change Chrome permissions")
        print(f"\n[{phase}] {instruction}\nPress Return only after the stated AgentTab/Chrome UI state is visible.", file=sys.stderr)
        try:
            input()
        except EOFError as error:
            raise GateFailure(f"{phase} did not receive operator confirmation") from error

    def connect(self, resume: bool = False) -> None:
        self.client.close()
        capability = self.client.resume_capability if resume else None
        self.client.connect(capability)

    def reconnect_until_ready(self, operation: str, *, resume: bool = True) -> None:
        deadline = time.monotonic() + self.args.recovery_timeout_seconds
        last_error: GateFailure | None = None
        while time.monotonic() < deadline:
            try:
                self.connect(resume=resume)
                status, _ = self.client.call("agenttab.status", {})
                result = require_completed(f"{operation} agenttab.status", status)
                if result.get("state") == "ready" and result.get("handoff_active") is False:
                    return
                last_error = GateFailure(f"{operation} agenttab.status did not reach ready")
            except GateFailure as error:
                last_error = error
            time.sleep(0.25)
        raise GateFailure(f"{operation} recovery timed out") from last_error
    def assert_core_unavailable(self, operation: str) -> None:
        self.client.close()
        deadline = time.monotonic() + self.args.recovery_timeout_seconds
        while time.monotonic() < deadline:
            try:
                file_mode = self.args.socket.stat().st_mode
            except FileNotFoundError:
                return
            except OSError as error:
                raise GateFailure(f"{operation}: AgentTab Core socket inspection failed") from error
            if not stat.S_ISSOCK(file_mode):
                raise GateFailure(f"{operation}: AgentTab Core path stopped being a Unix-domain socket")

            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.settimeout(0.25)
            try:
                connection.connect(os.fspath(self.args.socket))
            except OSError:
                return
            finally:
                connection.close()
            time.sleep(0.1)
        raise GateFailure(f"{operation}: AgentTab Core remained available after the extension was disabled")


    def status(self, operation: str, expected_state: str = "ready") -> dict[str, Any]:
        response, _ = self.client.call("agenttab.status", {})
        result = require_completed(f"{operation} agenttab.status", response)
        if result.get("state") != expected_state:
            raise GateFailure(f"{operation} agenttab.status expected {expected_state}")
        return result

    def open_tab(self, url: str, operation: str) -> tuple[int, int]:
        response, _ = self.client.call(
            "browser_open",
            {"mode": "create", "url": url, "background": True},
            mutation=True,
        )
        result = require_completed(operation, response)
        tab_id = require_result_int(result, "tab_id", operation)
        revision = require_result_int(result, "page_revision", operation)
        if not isinstance(self.client.task_id, str) or not self.client.task_id:
            raise GateFailure(f"{operation}: Core connection omitted task ownership")
        self.owned_tabs.add(tab_id)
        return tab_id, revision

    def snapshot(self, tab_id: int, mode: str, operation: str) -> tuple[dict[str, Any], int]:
        response, _ = self.client.call("browser_snapshot", {"tab_id": tab_id, "mode": mode})
        result = require_completed(operation, response)
        revision = require_result_int(result, "page_revision", operation)
        return result, revision

    def act(
        self,
        tab_id: int,
        revision: int,
        action: dict[str, Any],
        operation: str,
        *,
        idempotency_key: str | None = None,
    ) -> tuple[dict[str, Any], str]:
        response, key = self.client.call(
            "browser_act",
            {"tab_id": tab_id, "expected_page_revision": revision, "actions": [action]},
            mutation=True,
            idempotency_key=idempotency_key,
        )
        if key is None:
            raise GateFailure(f"{operation}: mutation did not receive an idempotency key")
        result = require_completed(operation, response)
        return result, key

    def assert_scripting_denied(self, tab_id: int, operation: str) -> None:
        response, _ = self.client.call("browser_snapshot", {"tab_id": tab_id, "mode": "text"})
        require_denied(
            operation,
            response,
            allowed_codes={
                "automation_disabled",
                "permissions_required",
                "scripting_not_granted",
                "scripting_permission_required",
                "scripting_required",
            },
        )
        error = response.get("error")
        if not isinstance(error, dict) or not isinstance(error.get("recovery"), str) or not error["recovery"]:
            raise GateFailure(f"{operation}: scripting denial omitted enablement recovery")

    def assert_raw_cdp_denied(self, tab_id: int) -> None:
        response, _ = self.client.call(
            "browser_developer",
            {"action": "Runtime.evaluate", "params": {"tab_id": tab_id, "expression": "0"}},
            mutation=True,
        )
        require_denied(
            "Standard browser_developer Runtime.evaluate dispatch",
            response,
            {"developer_mode_disabled", "developer_mode_required"},
        )

    def assert_debugger_lifecycle(self, tab_id: int) -> int:
        selection_before = self.inspector.selection()
        if self.inspector.debugger_is_attached(tab_id):
            raise ChromeOperationFailure("chrome.debugger.getTargets showed a debugger before lazy task use")
        _, observed_revision = self.snapshot(tab_id, "accessibility", "browser_snapshot accessibility lazy attach")
        if not self.inspector.debugger_is_attached(tab_id):
            raise ChromeOperationFailure("chrome.debugger.attach was not observed after accessibility snapshot")
        _, reuse_revision = self.snapshot(tab_id, "accessibility", "browser_snapshot accessibility debugger reuse")
        if reuse_revision != observed_revision or not self.inspector.debugger_is_attached(tab_id):
            raise ChromeOperationFailure("chrome.debugger attachment was not reused for the task tab")
        time.sleep(self.args.debugger_idle_wait_seconds)
        if self.inspector.debugger_is_attached(tab_id):
            raise ChromeOperationFailure("chrome.debugger.detach did not occur by the configured idle wait")
        self.inspector.assert_selection_unchanged(selection_before, "browser_snapshot debugger lifecycle")
        return reuse_revision

    def assert_popup_and_download(self, tab_id: int, revision: int, fixture: LifecycleFixture) -> int:
        selection_before = self.inspector.selection()
        snapshot, revision = self.snapshot(tab_id, "accessibility", "browser_snapshot accessibility popup controls")
        popup_ref = find_named_ref(snapshot, "Open popup", "button")
        download_ref = find_named_ref(snapshot, "Download harmless fixture", "link")
        if popup_ref is None or download_ref is None:
            raise GateFailure("browser_snapshot accessibility did not expose fixture popup/download refs")
        self.act(tab_id, revision, {"kind": "click", "ref": popup_ref}, "browser_act popup ownership")
        deadline = time.monotonic() + self.args.timeout_seconds
        popup_id: int | None = None
        while time.monotonic() < deadline:
            response, _ = self.client.call("browser_tabs", {})
            result = require_completed("browser_tabs popup ownership", response)
            tabs = result.get("tabs")
            if not isinstance(tabs, list):
                raise GateFailure("browser_tabs popup ownership omitted tabs array")
            for item in tabs:
                if isinstance(item, dict) and isinstance(item.get("tab_id"), int) and item["tab_id"] != tab_id:
                    popup_id = item["tab_id"]
                    break
            if popup_id is not None:
                break
            time.sleep(0.1)
        if popup_id is None:
            raise GateFailure("chrome.tabs.onCreated popup did not inherit task ownership")
        self.owned_tabs.add(popup_id)
        self.snapshot(popup_id, "accessibility", "browser_snapshot owned popup")

        self.act(tab_id, revision, {"kind": "click", "ref": download_ref}, "browser_act ordinary download")
        response, _ = self.client.call(
            "browser_wait",
            {"tab_id": tab_id, "condition": {"kind": "download"}, "timeout_ms": int(self.args.timeout_seconds * 1000)},
        )
        require_completed("browser_wait download", response)
        expected_file = self.download_dir / fixture.download_filename
        deadline = time.monotonic() + self.args.timeout_seconds
        while time.monotonic() < deadline and not expected_file.is_file():
            time.sleep(0.1)
        if not expected_file.is_file() or expected_file.is_symlink():
            raise ChromeOperationFailure("chrome.downloads.download did not write the fixture file to --download-dir")
        self.inspector.assert_selection_unchanged(selection_before, "popup/download task interactions")
        return revision

    def assert_stale_ref(self, tab_id: int, revision: int, fixture: LifecycleFixture) -> int:
        selection_before = self.inspector.selection()
        snapshot, revision = self.snapshot(tab_id, "accessibility", "browser_snapshot stale-ref source")
        old_ref = find_named_ref(snapshot, "Task field", "textbox")
        if old_ref is None:
            raise GateFailure("browser_snapshot stale-ref source omitted Task field ref")
        self.act(tab_id, revision, {"kind": "navigate", "url": f"{fixture.base_url}/replacement"}, "browser_act document replacement")
        _, replacement_revision = self.snapshot(tab_id, "accessibility", "browser_snapshot replacement document")
        if replacement_revision <= revision:
            raise GateFailure("page_revision did not advance after document replacement")
        deadline = time.monotonic() + self.args.timeout_seconds
        while True:
            response, _ = self.client.call(
                "browser_act",
                {
                    "tab_id": tab_id,
                    "expected_page_revision": replacement_revision,
                    "actions": [{"kind": "click", "ref": old_ref}],
                },
                mutation=True,
            )
            error = response.get("error")
            error_code = error.get("code") if isinstance(error, dict) else None
            if error_code == "stale_ref":
                break
            if error_code != "stale_page_revision" or time.monotonic() >= deadline:
                require_denied("browser_act stale_ref rejection", response, {"stale_ref"})
            time.sleep(0.1)
            _, replacement_revision = self.snapshot(
                tab_id,
                "accessibility",
                "browser_snapshot replacement document revision settle",
            )
        self.inspector.assert_selection_unchanged(selection_before, "stale-ref task interactions")
        return replacement_revision

    def assert_idempotency_recovery(self, tab_id: int, fixture: LifecycleFixture) -> None:
        _, current_revision = self.snapshot(tab_id, "accessibility", "browser_snapshot fixture reset source")
        self.act(tab_id, current_revision, {"kind": "navigate", "url": fixture.base_url}, "browser_act fixture reset")
        snapshot, revision = self.snapshot(tab_id, "accessibility", "browser_snapshot idempotency source")
        field_ref = find_named_ref(snapshot, "Task field", "textbox")
        if field_ref is None:
            raise GateFailure("browser_snapshot idempotency source omitted Task field ref")
        key = uuid7()
        params = {"tab_id": tab_id, "expected_page_revision": revision, "actions": [{"kind": "type", "ref": field_ref, "text": "x"}]}
        selection_before = self.inspector.selection()
        response, _ = self.client.call("browser_act", params, mutation=True, idempotency_key=key)
        require_completed("browser_act durable completed mutation", response)
        self.replay_request = (params, key)
        self.inspector.assert_selection_unchanged(selection_before, "browser_act durable mutation")
        text, _ = self.snapshot(tab_id, "text", "browser_snapshot initial idempotent mutation")
        if not contains_text(text, "Input count 1"):
            raise GateFailure("browser_act initial idempotent mutation did not execute exactly once")

    def assert_replayed_once(self, tab_id: int) -> None:
        if self.replay_request is None:
            raise GateFailure("idempotency replay was not prepared")
        params, key = self.replay_request
        response, _ = self.client.call("browser_act", params, mutation=True, idempotency_key=key)
        require_completed("browser_act completed idempotency replay", response)
        text, _ = self.snapshot(tab_id, "text", "browser_snapshot idempotency replay")
        if not contains_text(text, "Input count 1"):
            raise GateFailure("browser_act completed idempotency replay re-executed a mutation")

    def assert_handoff(self, fixture: LifecycleFixture, run_number: int) -> None:
        selection_before = self.inspector.selection()
        handoff_tab, revision = self.open_tab(f"{fixture.base_url}/handoff", "browser_open handoff fixture")
        self.inspector.assert_selection_unchanged(selection_before, "browser_open handoff fixture")
        response, _ = self.client.call(
            "browser_handoff",
            {
                "tab_id": handoff_tab,
                "expected_page_revision": revision,
                "prompt": "Complete the local AgentTab handoff fixture.",
                "completion": {"kind": "url", "value": f"{fixture.base_url}/handoff-complete"},
                "timeout_ms": int(self.args.timeout_seconds * 1000),
            },
            mutation=True,
        )
        if response.get("ok") is not True or response_outcome(response) != "needs_user":
            raise GateFailure(
                "browser_handoff: expected immediate needs_user admission state; "
                f"received {response_outcome(response)} ({scrubbed_error_code(response)})"
            )
        _selected_window, selected_tab = self.inspector.selection()
        if selected_tab != handoff_tab:
            raise ChromeOperationFailure(
                "browser_handoff did not select its admitted handoff tab in the focused Chrome window"
            )
        status = self.status("browser_handoff blackout", expected_state="ready")
        if status.get("handoff_active") is not True:
            raise GateFailure("agenttab.status did not persist active handoff")
        response, _ = self.client.call("browser_snapshot", {"tab_id": handoff_tab, "mode": "accessibility"})
        require_denied("browser_snapshot global handoff blackout", response, {"handoff_blackout"})
        self.prompt(
            f"run {run_number}: handoff completion",
            "Wait for the focused local fixture to show Handoff complete, then choose I'm done in the "
            "AgentTab popup.",
        )
        deadline = time.monotonic() + self.args.timeout_seconds
        while time.monotonic() < deadline:
            status_response, _ = self.client.call("agenttab.status", {})
            status_result = require_completed("agenttab.status handoff completion", status_response)
            if status_result.get("handoff_active") is False:
                return
            time.sleep(0.1)
        raise GateFailure("browser_handoff local completion did not clear blackout")

    def close_owned_tabs(self) -> None:
        task_id = self.client.task_id
        if self.client.connection is None or task_id is None:
            return
        self.inspector.close_task(task_id)
        deadline = time.monotonic() + self.args.recovery_timeout_seconds
        while time.monotonic() < deadline:
            response, _ = self.client.call("browser_tabs", {})
            result = require_completed("browser_tabs cleanup verification", response)
            tabs = result.get("tabs")
            if not isinstance(tabs, list):
                raise GateFailure("browser_tabs cleanup verification omitted tabs array")
            if tabs == [] and task_id not in self.inspector.task_ids():
                self.owned_tabs.clear()
                return
            time.sleep(0.1)
        raise GateFailure("transactional cleanup retained the probe task record or an owned tab")

    def remove_fixture_download(self, filename: str) -> None:
        target = self.download_dir / filename
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_file() or target.parent != self.download_dir:
                raise GateFailure("fixture download cleanup refused a non-regular or escaped file")
            try:
                target.unlink()
            except OSError as error:
                raise GateFailure("fixture download cleanup could not remove its exact file") from error

    def run_one(self, run_number: int, fixture: LifecycleFixture) -> dict[str, Any]:
        fixture.download_filename = f"agenttab-permission-probe-{uuid.uuid4().hex}.txt"
        initial_state = self.inspector.state()
        run_start_permissions = initial_state["scripting"]
        if initial_state["debugger_permission"] is not run_start_permissions:
            raise ChromeOperationFailure("AgentTab scripting/debugger permissions did not begin in one lifecycle state")
        if self.initial_automation_permissions is None:
            self.initial_automation_permissions = run_start_permissions
        if run_start_permissions:
            denial_instruction = (
                "Open AgentTab Settings and choose Turn off under Automation access. "
                "The popup must return to Automation is off."
            )
        else:
            denial_instruction = "Leave AgentTab at Automation is off; no Chrome permission prompt is expected."
        self.prompt(f"run {run_number}: automation denial state", denial_instruction)
        self.inspector.assert_automation_permissions(False, "denial observation")
        self.connect()
        self.status("initial lifecycle status")
        selection_before = self.inspector.selection()
        tab_id, _ = self.open_tab(fixture.base_url, "browser_open background task")
        self.inspector.assert_selection_unchanged(selection_before, "browser_open background task")
        self.assert_scripting_denied(tab_id, "browser_snapshot text while scripting denied")
        self.assert_raw_cdp_denied(tab_id)

        self.prompt(
            f"run {run_number}: optional automation grant",
            "Choose Enable AgentTab automation. Chrome grants scripting and debugger together from the click.",
        )
        self.inspector.assert_automation_permissions(True, "grant observation")
        self.snapshot(tab_id, "text", "browser_snapshot text after automation grant")
        revision = self.assert_debugger_lifecycle(tab_id)
        self.assert_popup_and_download(tab_id, revision, fixture)
        self.assert_stale_ref(tab_id, revision, fixture)
        self.assert_idempotency_recovery(tab_id, fixture)
        runtime_before_reload = self.inspector.runtime_instance()
        selection_before_reload = self.inspector.selection()
        run_control_command(
            [
                os.fspath(self.args.extension_reload_script),
                "--extension-id",
                self.args.extension_id,
                "--debugging-url",
                self.args.debugging_url,
            ],
            "extension service-worker reload command",
        )
        self.reconnect_until_ready("extension service-worker restart")
        self.inspector.assert_selection_unchanged(selection_before_reload, "extension service-worker restart")
        runtime_after_reload = self.inspector.runtime_instance()
        if runtime_after_reload == runtime_before_reload:
            raise ChromeOperationFailure("extension reload did not create a new AgentTab runtime instance")
        self.inspector.assert_candidate_files(self.candidate_file_digests)
        self.assert_replayed_once(tab_id)

        selection_before_host_restart = self.inspector.selection()
        run_control_command(self.args.host_restart_command, "Rust host restart command")
        self.reconnect_until_ready("Rust host crash recovery")
        self.assert_replayed_once(tab_id)
        self.inspector.assert_selection_unchanged(selection_before_host_restart, "Rust host crash recovery")
        self.assert_handoff(fixture, run_number)

        self.snapshot(tab_id, "accessibility", "browser_snapshot debugger revocation source")
        if not self.inspector.debugger_is_attached(tab_id):
            raise ChromeOperationFailure("debugger revocation source tab was not attached")
        revocation_generation = self.inspector.automation_revocation_generation()
        self.prompt(
            f"run {run_number}: optional automation revocation",
            "Open AgentTab Settings and choose Turn off under Automation access.",
        )
        self.inspector.assert_automation_permissions(False, "revocation observation")
        detach_deadline = time.monotonic() + self.args.timeout_seconds
        while self.inspector.automation_revocation_generation() <= revocation_generation:
            if time.monotonic() >= detach_deadline:
                raise ChromeOperationFailure("automation revocation did not acknowledge debugger-session cleanup")
            time.sleep(0.1)
        detached_state = self.inspector.state()
        if detached_state["debugger_targets_available"] and tab_id in detached_state["attached_tab_ids"]:
            raise ChromeOperationFailure("debugger revocation retained an attached task tab")
        self.assert_scripting_denied(tab_id, "browser_snapshot after automation revocation")
        self.prompt(
            f"run {run_number}: optional automation re-grant",
            "Choose Enable AgentTab automation.",
        )
        self.inspector.assert_automation_permissions(True, "re-grant observation")
        self.snapshot(tab_id, "accessibility", "browser_snapshot after automation re-grant")

        self.prompt(
            f"run {run_number}: pause",
            "Use the AgentTab popup's Pause agents control and wait for its confirmed PAUSED state.",
        )
        self.status("Pause agents", expected_state="paused")
        response, _ = self.client.call("browser_snapshot", {"tab_id": tab_id, "mode": "accessibility"})
        require_denied("browser_snapshot while paused", response, {"automation_paused"})
        runtime_before_paused_reload = self.inspector.runtime_instance()
        selection_before_paused_reload = self.inspector.selection()
        run_control_command(
            [
                os.fspath(self.args.extension_reload_script),
                "--extension-id",
                self.args.extension_id,
                "--debugging-url",
                self.args.debugging_url,
            ],
            "paused extension service-worker reload command",
        )
        self.client.close()
        time.sleep(0.25)
        self.connect(resume=True)
        self.status("paused restart restoration", expected_state="paused")
        self.inspector.assert_selection_unchanged(selection_before_paused_reload, "paused extension service-worker restart")
        runtime_after_paused_reload = self.inspector.runtime_instance()
        if runtime_after_paused_reload == runtime_before_paused_reload:
            raise ChromeOperationFailure("paused extension reload did not create a new AgentTab runtime instance")
        self.inspector.assert_candidate_files(self.candidate_file_digests)
        self.prompt(
            f"run {run_number}: resume",
            "Use the AgentTab popup's Resume control and wait for its confirmed READY state.",
        )
        self.reconnect_until_ready("Resume agents")

        self.prompt(
            f"run {run_number}: extension disable recovery",
            "In chrome://extensions, disable AgentTab. Do not change any other extension or Chrome setting.",
        )
        # Chrome owns the native-messaging host lifetime. Disabling AgentTab
        # closes the native port, so Core exits and removes its socket rather
        # than returning an extension-level response on an orphaned process.
        self.assert_core_unavailable("AgentTab disable")
        self.prompt(
            f"run {run_number}: extension restore",
            "Re-enable AgentTab in chrome://extensions, then open or reload its wake page without changing permissions.",
        )
        self.reconnect_until_ready("AgentTab re-enable")
        self.inspector.assert_automation_permissions(True, "post-disable re-enable")

        self.close_owned_tabs()
        self.remove_fixture_download(fixture.download_filename)
        return {
            "run": run_number,
            "task_cleanup": True,
            "active_window_tab_preserved": True,
            "automation_permission_lifecycle_observed": True,
            "debugger_detach_on_revocation_observed": True,
            "raw_cdp_standard_denied": True,
            "handoff_blackout_observed": True,
            "crash_recovery_observed": True,
        }

    def restore_and_cleanup(self, fixture_filename: str | None) -> None:
        try:
            if self.client.task_id is not None:
                self.prompt(
                    "transactional cleanup preparation",
                    "Ensure AgentTab is enabled, agents are resumed, and any active handoff is complete.",
                )
                self.reconnect_until_ready("transactional cleanup preparation")
                self.close_owned_tabs()
            if fixture_filename:
                self.remove_fixture_download(fixture_filename)
            if self.initial_automation_permissions is not None:
                expected = "granted" if self.initial_automation_permissions else "not granted"
                action = (
                    "choose Enable AgentTab automation"
                    if self.initial_automation_permissions
                    else "open AgentTab Settings and choose Turn off under Automation access"
                )
                self.prompt(
                    "transactional restoration",
                    f"Restore AgentTab automation permissions to their state before this run ({expected}): {action}. "
                    "Ensure the extension remains enabled, agents are resumed, and any active handoff is complete.",
                )
                self.inspector.assert_automation_permissions(
                    self.initial_automation_permissions,
                    "transactional restoration",
                )
        finally:
            self.client.close()


def verify_live(args: argparse.Namespace) -> dict[str, Any]:
    if sys.platform != "darwin":
        raise GateFailure("--live-lifecycle is restricted to the trusted macOS runner")
    if args.runs != 3:
        raise GateFailure("--live-lifecycle requires exactly --runs 3 consecutive matrices")
    if not args.interactive:
        raise GateFailure("--live-lifecycle requires --interactive; it never automates Chrome permission changes")
    if args.timeout_seconds <= 0 or args.recovery_timeout_seconds <= 0 or args.debugger_idle_wait_seconds <= 0:
        raise GateFailure("live lifecycle timeout values must be positive")
    if args.extension_reload_script is None or not args.extension_reload_script.is_file():
        raise GateFailure("--live-lifecycle requires an executable --extension-reload-script")
    if not os.access(args.extension_reload_script, os.X_OK):
        raise GateFailure("--extension-reload-script must be executable")
    if args.host_restart_command is None:
        raise GateFailure("--live-lifecycle requires --host-restart-command as a JSON argv array")

    args.extension_id = validate_extension_id(args.extension_id)
    manifest_sha256, candidate_extension_id, candidate_file_digests, candidate_tree_sha256 = validate_candidate(
        args.candidate_dir
    )
    if args.extension_id != candidate_extension_id:
        raise GateFailure("--extension-id does not match the public key in --candidate-dir/manifest.json")
    args.host_restart_command = parse_command(args.host_restart_command, "--host-restart-command")
    probe = LiveLifecycleProbe(args, candidate_file_digests)
    probe.inspector.assert_candidate_files(candidate_file_digests)
    results: list[dict[str, Any]] = []
    with lifecycle_fixture() as fixture:
        try:
            for run_number in range(1, args.runs + 1):
                results.append(probe.run_one(run_number, fixture))
        except BaseException as primary_error:
            try:
                probe.restore_and_cleanup(fixture.download_filename)
            except BaseException as cleanup_error:
                raise GateFailure(
                    f"{primary_error}; transactional cleanup also failed: {cleanup_error}"
                ) from primary_error
            raise
        probe.restore_and_cleanup(fixture.download_filename)
    return {
        "schema_version": 1,
        "live_lifecycle": True,
        "runs": results,
        "candidate_manifest_sha256": manifest_sha256,
        "chrome_permission_mutations_by_probe": False,
        "candidate_tree_sha256": candidate_tree_sha256,
        "policy_mutations_by_probe": False,
        "report_contains_page_content": False,
        "report_contains_extension_capability": False,
    }


def print_live_prerequisites() -> None:
    print("Live lifecycle prerequisites (the probe refuses to supply or alter them):")
    print("  1. A disposable trusted macOS Chrome profile has the exact packages/extension/dist AgentTab candidate loaded.")
    print("  2. Chrome was started with a loopback remote-debugging endpoint and the candidate extension target is live.")
    print("  3. The AgentTab Rust host is READY on a current-user 0600 Unix socket; no TCP token endpoint is accepted.")
    print("  4. --download-dir already exists, is disposable, and is Chrome's configured download directory for that profile.")
    print("  5. An operator can perform the prompted AgentTab/Chrome UI permission, pause, disable, and restore steps.")
    print("  6. --host-restart-command is the runner's reviewed Rust-host restart argv encoded as JSON; it is never shell-evaluated.")
    print("")
    print("CLI (run only after the prerequisites are deliberately prepared):")
    print("  python3 tests/architecture/verify_permissions.py --live-lifecycle --interactive \\")
    print("    --candidate-dir packages/extension/dist --extension-id <chrome-extension-id> \\")
    print("    --socket \"$HOME/.agenttab/run/agenttab.sock\" --debugging-url http://127.0.0.1:<port> \\")
    print("    --download-dir <disposable-chrome-download-dir> \\")
    print("    --extension-reload-script scripts/reload_unpacked_extension.sh \\")
    print("    --host-restart-command '[\"reviewed-host-restart\", \"arg\"]' --runs 3")


def request_extension_reload(args: argparse.Namespace) -> dict[str, Any]:
    extension_id = validate_extension_id(args.extension_id)
    if not args.debugging_url:
        raise GateFailure("--request-extension-reload requires --debugging-url")
    ChromeInspector(args.debugging_url, extension_id, args.timeout_seconds).request_reload()
    return {
        "schema_version": 1,
        "extension_reload_requested": True,
        "extension_id": extension_id,
    }

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="write the scrubbed JSON report")
    parser.add_argument("--print-live-prerequisites", action="store_true", help="print live CLI/environment prerequisites and exit")
    parser.add_argument("--live-lifecycle", action="store_true", help="run the explicit PR3 macOS lifecycle matrix")
    parser.add_argument("--interactive", action="store_true", help="allow prompts for human Chrome UI permission/state changes")
    parser.add_argument(
        "--request-extension-reload",
        action="store_true",
        help="reload the candidate extension through its loopback DevTools service-worker target",
    )
    parser.add_argument("--runs", type=int, default=3, help="live matrix count; must be exactly 3")
    parser.add_argument("--candidate-dir", type=Path, default=ROOT / "packages" / "extension" / "dist")
    parser.add_argument("--extension-id", default="", help="preloaded AgentTab Chrome extension ID")
    parser.add_argument("--socket", type=Path, default=Path.home() / ".agenttab" / "run" / "agenttab.sock")
    parser.add_argument("--debugging-url", default="", help="loopback Chrome DevTools HTTP endpoint")
    parser.add_argument("--download-dir", type=Path, help="existing disposable Chrome download directory")
    parser.add_argument("--extension-reload-script", type=Path, default=ROOT / "scripts" / "reload_unpacked_extension.sh")
    parser.add_argument("--host-restart-command", help="reviewed Rust-host restart command as a JSON argv array")
    parser.add_argument("--timeout-seconds", type=float, default=15.0, help="per-operation live timeout")
    parser.add_argument("--recovery-timeout-seconds", type=float, default=30.0, help="extension/host recovery timeout")
    parser.add_argument("--debugger-idle-wait-seconds", type=float, default=10.0, help="wait beyond configured task debugger idle timeout")
    return parser.parse_args()


def write_and_print_report(args: argparse.Namespace, report: dict[str, Any]) -> None:
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(payload, encoding="utf-8")
    print(payload, end="")


def main() -> int:
    args = parse_args()
    if args.print_live_prerequisites:
        print_live_prerequisites()
        return 0
    try:
        if args.request_extension_reload:
            if args.live_lifecycle or args.print_live_prerequisites:
                raise GateFailure("--request-extension-reload cannot be combined with another mode")
            report = request_extension_reload(args)
        elif args.live_lifecycle:
            if not args.debugging_url or args.download_dir is None:
                raise GateFailure("--live-lifecycle requires --debugging-url and --download-dir")
            report = verify_live(args)
        else:
            report = verify()
    except GateFailure as error:
        print(json.dumps({"schema_version": 1, "error": str(error)}, indent=2, sort_keys=True))
        return 1
    write_and_print_report(args, report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
