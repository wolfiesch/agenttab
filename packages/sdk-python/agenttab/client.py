from __future__ import annotations

import json
import os
import re
import secrets
import socket
import stat
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, BinaryIO, Mapping

RPC_PROTOCOL = "agenttab.rpc"
RPC_VERSION = 1
CLIENT_TO_HOST_MAX_BYTES = 64 * 1024
HOST_TO_CLIENT_MAX_BYTES = 1024 * 1024
MUTATIONS = {
    "browser_open",
    "browser_act",
    "browser_handoff",
    "browser_commit",
    "browser_developer",
}

JsonObject = dict[str, Any]


class AgentTabError(RuntimeError):
    def __init__(self, response: Mapping[str, Any]) -> None:
        error = response.get("error")
        details = error if isinstance(error, Mapping) else {}
        super().__init__(str(details.get("message", "AgentTab request failed")))
        self.code = str(details.get("code", "unknown"))
        self.outcome = str(response.get("outcome", "unknown"))
        self.recovery = details.get("recovery")
        self.details = details.get("details")


def uuid7(now_ms: int | None = None) -> uuid.UUID:
    timestamp = int(time.time() * 1000) if now_ms is None else now_ms
    if not 0 <= timestamp < 1 << 48:
        raise ValueError("UUIDv7 timestamp must fit in 48 bits")
    payload = bytearray(secrets.token_bytes(16))
    payload[:6] = timestamp.to_bytes(6, "big")
    payload[6] = 0x70 | (payload[6] & 0x0F)
    payload[8] = 0x80 | (payload[8] & 0x3F)
    return uuid.UUID(bytes=bytes(payload))


def encode_frame(value: Mapping[str, Any], limit: int = CLIENT_TO_HOST_MAX_BYTES) -> bytes:
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > limit:
        raise ValueError(f"AgentTab frame is {len(payload)} bytes; limit is {limit}")
    return struct.pack("<I", len(payload)) + payload


def _read_exact(stream: BinaryIO | socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.recv(remaining) if isinstance(stream, socket.socket) else stream.read(remaining)
        if not chunk:
            raise EOFError("AgentTab connection closed during a frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(
    stream: BinaryIO | socket.socket,
    limit: int = HOST_TO_CLIENT_MAX_BYTES,
) -> JsonObject:
    declared = struct.unpack("<I", _read_exact(stream, 4))[0]
    if declared > limit:
        raise ValueError(f"AgentTab frame declares {declared} bytes; limit is {limit}")
    value = json.loads(_read_exact(stream, declared).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("AgentTab frame must contain a JSON object")
    return value


def _windows_sid() -> str:
    result = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"],
        check=True,
        capture_output=True,
        text=True,
        shell=False,
    )
    match = re.search(r"S-1-[0-9-]+", result.stdout, re.IGNORECASE)
    if not match:
        raise RuntimeError("Could not determine the current Windows user SID")
    return match.group(0)


def resolve_endpoint(environment: Mapping[str, str] | None = None) -> str:
    values = os.environ if environment is None else environment
    if values.get("AGENTTAB_SOCKET"):
        return values["AGENTTAB_SOCKET"]
    if values.get("AGENTTAB_PIPE_NAME"):
        return values["AGENTTAB_PIPE_NAME"]
    if os.name == "nt":
        return rf"\\.\pipe\agenttab-{_windows_sid()}"

    home = Path(values.get("HOME", str(Path.home())))
    state_root = Path(values.get("AGENTTAB_STATE_DIR", str(home / ".agenttab")))
    runtime = values.get("XDG_RUNTIME_DIR")
    if runtime:
        try:
            metadata = os.stat(runtime, follow_symlinks=False)
            if stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.geteuid():
                return str(Path(runtime) / "agenttab" / "agenttab.sock")
        except OSError:
            pass
    return str(state_root / "run" / "agenttab.sock")


class AgentTabClient:
    def __init__(
        self,
        stream: BinaryIO | socket.socket,
        connection: JsonObject,
        request_timeout: float = 30.0,
    ) -> None:
        self._stream = stream
        self.connection = connection
        self.request_timeout = request_timeout
        self.resume_capability = connection.get("resume_capability")
        self._lock = threading.Lock()
        self._closed = False

    @classmethod
    def connect(
        cls,
        *,
        conversation_id: str | None = None,
        resume_capability: str | None = None,
        endpoint: str | None = None,
        connect_timeout: float = 5.0,
        request_timeout: float = 30.0,
    ) -> AgentTabClient:
        address = endpoint or resolve_endpoint()
        if os.name == "nt":
            stream: BinaryIO | socket.socket = open(address, "r+b", buffering=0)
        else:
            unix_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            unix_socket.settimeout(connect_timeout)
            unix_socket.connect(address)
            stream = unix_socket
        request: JsonObject = {
            "protocol": RPC_PROTOCOL,
            "version": RPC_VERSION,
            "kind": "connect",
        }
        if conversation_id:
            request["conversation_id"] = conversation_id
        if resume_capability:
            request["resume_capability"] = resume_capability
        cls._write(stream, encode_frame(request))
        connection = read_frame(stream)
        if (
            connection.get("protocol") != RPC_PROTOCOL
            or connection.get("version") != RPC_VERSION
            or connection.get("kind") != "connected"
        ):
            stream.close()
            raise RuntimeError("AgentTab returned an invalid connection acknowledgement")
        if isinstance(stream, socket.socket):
            stream.settimeout(request_timeout)
        return cls(stream, connection, request_timeout)

    @staticmethod
    def _write(stream: BinaryIO | socket.socket, payload: bytes) -> None:
        if isinstance(stream, socket.socket):
            stream.sendall(payload)
        else:
            stream.write(payload)
            stream.flush()

    def request(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        if self._closed:
            raise RuntimeError("AgentTab client is closed")
        request_id = str(uuid.uuid4())
        request: JsonObject = {
            "protocol": RPC_PROTOCOL,
            "version": RPC_VERSION,
            "request_id": request_id,
            "method": method,
            "params": dict(params),
        }
        if method in MUTATIONS:
            request["idempotency_key"] = idempotency_key or str(uuid7())
        with self._lock:
            self._write(self._stream, encode_frame(request))
            response = read_frame(self._stream)
        if response.get("request_id") != request_id:
            raise RuntimeError("AgentTab response request_id did not match the request")
        task = response.get("task")
        if isinstance(task, Mapping) and isinstance(task.get("resume_capability"), str):
            self.resume_capability = task["resume_capability"]
        return response

    def call(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> Any:
        response = self.request(method, params, idempotency_key=idempotency_key)
        if not response.get("ok"):
            raise AgentTabError(response)
        return response.get("result")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._stream.close()

    def __enter__(self) -> AgentTabClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
