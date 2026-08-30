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
from hashlib import sha256
from pathlib import Path
from typing import Any, BinaryIO, Literal, Mapping, Protocol

RPC_PROTOCOL = "agenttab.rpc"
RPC_VERSION = 1
CLIENT_TO_HOST_MAX_BYTES = 1024 * 1024
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


TransportErrorCode = Literal[
    "request_timeout",
    "connection_closed",
    "transport_error",
]


class AgentTabTransportError(RuntimeError):
    def __init__(
        self,
        method: str,
        code: TransportErrorCode,
        idempotency_key: str | None = None,
    ) -> None:
        super().__init__(f"AgentTab transport failed during {method}: {code}")
        self.outcome: Literal["unknown"] = "unknown"
        self.method = method
        self.code = code
        self.idempotency_key = idempotency_key


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


class _WindowsNamedPipe:
    _agenttab_windows_pipe = True

    def __init__(self, address: str) -> None:
        import ctypes
        from ctypes import wintypes

        class Overlapped(ctypes.Structure):
            _fields_ = [
                ("Internal", ctypes.c_size_t),
                ("InternalHigh", ctypes.c_size_t),
                ("Offset", wintypes.DWORD),
                ("OffsetHigh", wintypes.DWORD),
                ("hEvent", wintypes.HANDLE),
            ]

        self._ctypes = ctypes
        self._wintypes = wintypes
        self._overlapped_type = Overlapped
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        self._kernel32.CreateFileW.restype = wintypes.HANDLE
        self._kernel32.CreateEventW.argtypes = [
            ctypes.c_void_p,
            wintypes.BOOL,
            wintypes.BOOL,
            wintypes.LPCWSTR,
        ]
        self._kernel32.CreateEventW.restype = wintypes.HANDLE
        self._kernel32.ReadFile.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(Overlapped),
        ]
        self._kernel32.ReadFile.restype = wintypes.BOOL
        self._kernel32.WriteFile.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(Overlapped),
        ]
        self._kernel32.WriteFile.restype = wintypes.BOOL
        self._kernel32.GetOverlappedResult.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(Overlapped),
            ctypes.POINTER(wintypes.DWORD),
            wintypes.BOOL,
        ]
        self._kernel32.GetOverlappedResult.restype = wintypes.BOOL
        self._kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self._kernel32.WaitForSingleObject.restype = wintypes.DWORD
        self._kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self._kernel32.CloseHandle.restype = wintypes.BOOL
        self._kernel32.CancelIoEx.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(Overlapped),
        ]
        self._kernel32.CancelIoEx.restype = wintypes.BOOL
        self._handle: int | None = self._kernel32.CreateFileW(
            address,
            0xC0000000,
            0,
            None,
            3,
            0x40000000,
            None,
        )
        if self._handle == ctypes.c_void_p(-1).value:
            self._handle = None
            raise ctypes.WinError(ctypes.get_last_error())

    def _transfer(
        self,
        operation: Any,
        buffer: Any,
        size: int,
        timeout: float | None,
    ) -> int:
        if self._handle is None:
            raise OSError("AgentTab named pipe is closed")
        event = self._kernel32.CreateEventW(None, True, False, None)
        if not event:
            raise self._ctypes.WinError(self._ctypes.get_last_error())
        try:
            overlapped = self._overlapped_type()
            overlapped.hEvent = event
            if not operation(
                self._handle,
                self._ctypes.byref(buffer),
                size,
                None,
                self._ctypes.byref(overlapped),
            ):
                error = self._ctypes.get_last_error()
                if error not in (997,):
                    if error in (109, 232, 233):
                        raise EOFError("AgentTab connection closed during a frame")
                    raise self._ctypes.WinError(error)
            wait_timeout = 0xFFFFFFFF if timeout is None else max(1, int(timeout * 1000))
            wait = self._kernel32.WaitForSingleObject(event, wait_timeout)
            if wait == 0x00000102:
                self._kernel32.CancelIoEx(self._handle, self._ctypes.byref(overlapped))
                self.close()
                self._kernel32.WaitForSingleObject(event, 0xFFFFFFFF)
                raise TimeoutError("AgentTab named-pipe I/O timed out")
            if wait != 0:
                raise self._ctypes.WinError(self._ctypes.get_last_error())
            transferred = self._wintypes.DWORD()
            if not self._kernel32.GetOverlappedResult(
                self._handle,
                self._ctypes.byref(overlapped),
                self._ctypes.byref(transferred),
                False,
            ):
                error = self._ctypes.get_last_error()
                if error in (109, 232, 233):
                    raise EOFError("AgentTab connection closed during a frame")
                raise self._ctypes.WinError(error)
            return int(transferred.value)
        finally:
            self._kernel32.CloseHandle(event)

    def read(self, size: int, timeout: float | None = None) -> bytes:
        if size == 0:
            return b""
        buffer = self._ctypes.create_string_buffer(size)
        transferred = self._transfer(self._kernel32.ReadFile, buffer, size, timeout)
        return buffer.raw[:transferred]

    def write(self, payload: bytes, timeout: float | None = None) -> int:
        if not payload:
            return 0
        buffer = self._ctypes.create_string_buffer(payload, len(payload))
        return self._transfer(self._kernel32.WriteFile, buffer, len(payload), timeout)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        if self._handle is None:
            return
        handle, self._handle = self._handle, None
        self._kernel32.CloseHandle(handle)


def _open_windows_named_pipe(address: str) -> _WindowsNamedPipe:
    return _WindowsNamedPipe(address)


def _uses_windows_named_pipe(stream: object) -> bool:
    return bool(getattr(stream, "_agenttab_windows_pipe", False))


def _read_exact(
    stream: BinaryIO | socket.socket,
    size: int,
    deadline: float | None = None,
) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        if isinstance(stream, socket.socket):
            chunk = stream.recv(remaining)
        elif _uses_windows_named_pipe(stream):
            if deadline is None:
                timeout = None
            else:
                timeout = deadline - time.monotonic()
                if timeout <= 0:
                    raise TimeoutError("AgentTab named-pipe read timed out")
            chunk = stream.read(remaining, timeout)  # type: ignore[call-arg]
        else:
            chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("AgentTab connection closed during a frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(
    stream: BinaryIO | socket.socket,
    limit: int = HOST_TO_CLIENT_MAX_BYTES,
    *,
    timeout: float | None = None,
) -> JsonObject:
    deadline = None if timeout is None else time.monotonic() + timeout
    declared = struct.unpack("<I", _read_exact(stream, 4, deadline))[0]
    if declared > limit:
        raise ValueError(f"AgentTab frame declares {declared} bytes; limit is {limit}")
    value = json.loads(_read_exact(stream, declared, deadline).decode("utf-8"))
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


class ResumeCapabilityStore(Protocol):
    @property
    def path(self) -> Path:
        ...

    def load(self) -> str | None:
        ...

    def load_pending(self) -> str | None:
        ...

    def save(self, capability: str) -> None:
        ...

    def prepare_replacement(self, current_capability: str, replacement_capability: str) -> None:
        ...

    def activate_replacement(self, replacement_capability: str) -> None:
        ...


def _validate_resume_capability(capability: str) -> None:
    if not 32 <= len(capability) <= 64:
        raise ValueError("AgentTab resume capability must contain 32 to 64 characters")


def _prepare_capability_directory(directory: Path, create: bool) -> bool:
    if create:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        metadata = directory.lstat()
    except FileNotFoundError:
        if not create:
            return False
        raise
    if not stat.S_ISDIR(metadata.st_mode) or directory.is_symlink():
        raise RuntimeError(f"AgentTab client state path is not a regular directory: {directory}")
    if os.name != "nt" and metadata.st_mode & 0o077:
        if not create:
            raise RuntimeError(
                f"AgentTab client state directory must be owner-only (0700): {directory}"
            )
        directory.chmod(0o700)
    return True


class _FileResumeCapabilityStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _load_stored_capability(self) -> JsonObject | None:
        directory = self.path.parent
        if not _prepare_capability_directory(directory, create=False):
            return None
        try:
            metadata = self.path.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(metadata.st_mode) or self.path.is_symlink():
            raise RuntimeError(
                f"AgentTab resume capability path is not a regular file: {self.path}"
            )
        if os.name != "nt" and metadata.st_mode & 0o077:
            raise RuntimeError(
                f"AgentTab resume capability must be owner-only (0600): {self.path}"
            )
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(
                f"AgentTab resume capability file is invalid: {self.path}"
            ) from error
        if (
            not isinstance(value, dict)
            or value.get("schemaVersion") != 1
            or not isinstance(value.get("resumeCapability"), str)
            or (
                "pendingResumeCapability" in value
                and not isinstance(value["pendingResumeCapability"], str)
            )
        ):
            raise RuntimeError(f"AgentTab resume capability file is invalid: {self.path}")
        _validate_resume_capability(value["resumeCapability"])
        pending = value.get("pendingResumeCapability")
        if pending is not None:
            _validate_resume_capability(pending)
        return value

    def _save_stored_capability(self, value: JsonObject) -> None:
        active = value["resumeCapability"]
        pending = value.get("pendingResumeCapability")
        if not isinstance(active, str):
            raise RuntimeError("AgentTab resume capability state is missing its active capability")
        _validate_resume_capability(active)
        if pending is not None:
            if not isinstance(pending, str):
                raise RuntimeError(
                    "AgentTab resume capability state has an invalid pending capability"
                )
            _validate_resume_capability(pending)

        directory = self.path.parent
        _prepare_capability_directory(directory, create=True)
        temporary = self.path.with_name(
            f".{self.path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
        )
        try:
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(f"{json.dumps(value, separators=(',', ':'))}\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            if os.name != "nt":
                self.path.chmod(0o600)
            with self.path.open("rb") as handle:
                os.fsync(handle.fileno())
            if os.name != "nt":
                descriptor = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def load(self) -> str | None:
        stored = self._load_stored_capability()
        return None if stored is None else stored["resumeCapability"]

    def load_pending(self) -> str | None:
        stored = self._load_stored_capability()
        return None if stored is None else stored.get("pendingResumeCapability")

    def save(self, capability: str) -> None:
        _validate_resume_capability(capability)
        self._save_stored_capability(
            {"schemaVersion": 1, "resumeCapability": capability}
        )

    def prepare_replacement(
        self,
        current_capability: str,
        replacement_capability: str,
    ) -> None:
        _validate_resume_capability(current_capability)
        _validate_resume_capability(replacement_capability)
        if current_capability == replacement_capability:
            raise ValueError(
                "AgentTab resume capability replacement must differ from the current capability"
            )
        stored = self._load_stored_capability()
        if stored is None or (
            stored["resumeCapability"] != current_capability
            and stored.get("pendingResumeCapability") != current_capability
        ):
            raise RuntimeError(
                "AgentTab resume capability store does not contain the capability being resumed"
            )
        self._save_stored_capability(
            {
                "schemaVersion": 1,
                "resumeCapability": current_capability,
                "pendingResumeCapability": replacement_capability,
            }
        )

    def activate_replacement(self, replacement_capability: str) -> None:
        _validate_resume_capability(replacement_capability)
        stored = self._load_stored_capability()
        if stored is None or stored.get("pendingResumeCapability") != replacement_capability:
            raise RuntimeError(
                "AgentTab resume capability store does not contain the confirmed replacement"
            )
        self._save_stored_capability(
            {"schemaVersion": 1, "resumeCapability": replacement_capability}
        )


def create_resume_capability_store(
    namespace: str,
    *,
    scope: str,
    state_dir: str | os.PathLike[str] | None = None,
) -> ResumeCapabilityStore:
    if not re.fullmatch(r"[a-z0-9_-]+", namespace):
        raise ValueError(
            "AgentTab capability store namespace must contain only lowercase letters, digits, dashes, or underscores"
        )
    if not scope:
        raise ValueError("AgentTab capability store scope must not be empty")
    root = (
        Path(state_dir)
        if state_dir is not None
        else Path(os.environ.get("AGENTTAB_STATE_DIR", Path.home() / ".agenttab"))
    )
    scope_hash = sha256(scope.encode("utf-8")).hexdigest()[:32]
    return _FileResumeCapabilityStore(root / "clients" / f"{namespace}-{scope_hash}.json")


class AgentTabClient:
    def __init__(
        self,
        stream: BinaryIO | socket.socket,
        connection: JsonObject,
        request_timeout: float = 30.0,
        capability_store: ResumeCapabilityStore | None = None,
    ) -> None:
        self._stream = stream
        self.connection = connection
        self.request_timeout = request_timeout
        self._capability_store = capability_store
        candidate = connection.get("resume_capability")
        self.pending_resume_capability = candidate if connection.get("resumed") else None
        self.resume_capability = None
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
        capability_store: ResumeCapabilityStore | None = None,
    ) -> AgentTabClient:
        if capability_store is not None and resume_capability is not None:
            raise ValueError(
                "AgentTab uses the configured ResumeCapabilityStore instead of an explicit resume capability"
            )
        if capability_store is None:
            active_capability = resume_capability
            candidates = [resume_capability]
        else:
            pending_capability = capability_store.load_pending()
            active_capability = capability_store.load()
            candidates = []
            for capability in (pending_capability, active_capability):
                if capability is not None and capability not in candidates:
                    candidates.append(capability)
            if not candidates:
                candidates.append(None)

        address = endpoint or resolve_endpoint()
        negotiated: tuple[BinaryIO | socket.socket, JsonObject] | None = None
        attempted_capability: str | None = None
        for capability in candidates:
            stream, connection = cls._negotiate_connection(
                address,
                conversation_id=conversation_id,
                resume_capability=capability,
                connect_timeout=connect_timeout,
                request_timeout=request_timeout,
            )
            if capability is not None and connection.get("resumed") is not True:
                stream.close()
                if capability_store is not None and capability != active_capability:
                    continue
                source = "stored" if capability_store is not None else "supplied"
                raise RuntimeError(
                    f"AgentTab rejected the {source} resume capability; "
                    "start without it only when creating a new task is intended"
                )
            negotiated = (stream, connection)
            attempted_capability = capability
            break
        if negotiated is None:
            raise RuntimeError("AgentTab could not establish a connection")

        stream, connection = negotiated
        client = cls(
            stream,
            connection,
            request_timeout,
            capability_store=capability_store,
        )
        if connection.get("resumed"):
            candidate = connection.get("resume_capability")
            if capability_store is not None:
                if attempted_capability is None or not isinstance(candidate, str):
                    client.close()
                    raise RuntimeError(
                        "AgentTab resumed without the durable resume-confirmation prerequisites"
                    )
                try:
                    capability_store.prepare_replacement(attempted_capability, candidate)
                    client.confirm_resume_capability()
                    capability_store.activate_replacement(candidate)
                except Exception as error:
                    client.close()
                    raise RuntimeError(
                        "AgentTab could not complete durable resume-capability rotation: "
                        f"{error}"
                    ) from error
        elif connection.get("resume_capability") is not None:
            client.close()
            raise RuntimeError(
                "AgentTab returned an initial resume capability before creating a task"
            )
        return client

    @classmethod
    def _negotiate_connection(
        cls,
        address: str,
        *,
        conversation_id: str | None,
        resume_capability: str | None,
        connect_timeout: float,
        request_timeout: float,
    ) -> tuple[BinaryIO | socket.socket, JsonObject]:
        if os.name == "nt":
            stream: BinaryIO | socket.socket = _open_windows_named_pipe(address)
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
        try:
            negotiation_deadline = (
                time.monotonic() + connect_timeout
                if _uses_windows_named_pipe(stream)
                else None
            )
            cls._write(
                stream,
                encode_frame(request),
                timeout=connect_timeout if negotiation_deadline is not None else None,
            )
            remaining = (
                negotiation_deadline - time.monotonic()
                if negotiation_deadline is not None
                else None
            )
            if remaining is not None and remaining <= 0:
                raise TimeoutError("AgentTab named-pipe connection negotiation timed out")
            connection = read_frame(stream, timeout=remaining)
            if (
                connection.get("protocol") != RPC_PROTOCOL
                or connection.get("version") != RPC_VERSION
                or connection.get("kind") != "connected"
            ):
                raise RuntimeError("AgentTab returned an invalid connection acknowledgement")
            if connection.get("resumed") and (
                not isinstance(connection.get("connection_id"), str)
                or not isinstance(connection.get("task_id"), str)
                or not isinstance(connection.get("resume_capability"), str)
            ):
                raise RuntimeError(
                    "AgentTab returned an invalid resumed connection acknowledgement"
                )
        except Exception:
            stream.close()
            raise
        if isinstance(stream, socket.socket):
            stream.settimeout(request_timeout)
        return stream, connection

    @staticmethod
    def _write(
        stream: BinaryIO | socket.socket,
        payload: bytes,
        *,
        timeout: float | None = None,
    ) -> None:
        if isinstance(stream, socket.socket):
            stream.sendall(payload)
        elif _uses_windows_named_pipe(stream):
            written = stream.write(payload, timeout)  # type: ignore[call-arg]
            if written != len(payload):
                raise EOFError("AgentTab connection closed during a frame")
        else:
            stream.write(payload)
            stream.flush()

    def _close_after_transport_failure(self) -> None:
        self._closed = True
        try:
            self._stream.close()
        except Exception:
            pass

    @staticmethod
    def _cancel_windows_io(worker: threading.Thread) -> None:
        if os.name != "nt" or worker.native_id is None:
            return
        try:
            import ctypes

            thread_terminate = 0x0001
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenThread.argtypes = [
                ctypes.c_ulong,
                ctypes.c_bool,
                ctypes.c_ulong,
            ]
            kernel32.OpenThread.restype = ctypes.c_void_p
            kernel32.CancelSynchronousIo.argtypes = [ctypes.c_void_p]
            kernel32.CancelSynchronousIo.restype = ctypes.c_bool
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel32.CloseHandle.restype = ctypes.c_bool
            handle = kernel32.OpenThread(thread_terminate, False, worker.native_id)
            if handle:
                try:
                    kernel32.CancelSynchronousIo(handle)
                finally:
                    kernel32.CloseHandle(handle)
        except (AttributeError, OSError):
            pass

    def _exchange(self, payload: bytes) -> JsonObject:
        if isinstance(self._stream, socket.socket) or _uses_windows_named_pipe(self._stream):
            with self._lock:
                if _uses_windows_named_pipe(self._stream):
                    deadline = time.monotonic() + self.request_timeout
                    self._write(self._stream, payload, timeout=self.request_timeout)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(
                            f"AgentTab request timed out after {self.request_timeout} seconds"
                        )
                    return read_frame(self._stream, timeout=remaining)
                self._write(self._stream, payload)
                return read_frame(self._stream)

        responses: list[JsonObject] = []
        failures: list[Exception] = []
        finished = threading.Event()

        def exchange() -> None:
            try:
                with self._lock:
                    self._write(self._stream, payload)
                    responses.append(read_frame(self._stream))
            except Exception as error:
                failures.append(error)
            finally:
                finished.set()

        worker = threading.Thread(target=exchange, daemon=True)
        worker.start()
        if not finished.wait(self.request_timeout):
            self._closed = True
            self._cancel_windows_io(worker)
            threading.Thread(
                target=self._close_after_transport_failure,
                daemon=True,
            ).start()
            raise TimeoutError(
                f"AgentTab request timed out after {self.request_timeout} seconds"
            )
        if failures:
            raise failures[0]
        if not responses:
            raise EOFError("AgentTab connection closed before a response arrived")
        return responses[0]

    def confirm_resume_capability(self) -> None:
        candidate = self.pending_resume_capability
        connection_id = self.connection.get("connection_id")
        if candidate is None:
            raise RuntimeError("AgentTab has no pending resume capability to confirm")
        if not isinstance(connection_id, str):
            raise RuntimeError("AgentTab resumed connection is missing its connection_id")
        with self._lock:
            payload = encode_frame(
                {
                    "protocol": RPC_PROTOCOL,
                    "version": RPC_VERSION,
                    "kind": "resume_confirm",
                    "connection_id": connection_id,
                    "resume_capability": candidate,
                }
            )
            if _uses_windows_named_pipe(self._stream):
                deadline = time.monotonic() + self.request_timeout
                self._write(self._stream, payload, timeout=self.request_timeout)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        f"AgentTab request timed out after {self.request_timeout} seconds"
                    )
                acknowledgement = read_frame(self._stream, timeout=remaining)
            else:
                self._write(self._stream, payload)
                acknowledgement = read_frame(self._stream)
        if (
            acknowledgement.get("protocol") != RPC_PROTOCOL
            or acknowledgement.get("version") != RPC_VERSION
            or acknowledgement.get("kind") != "resume_confirmed"
            or acknowledgement.get("connection_id") != connection_id
        ):
            raise RuntimeError("AgentTab rejected the resume capability confirmation")
        self.resume_capability = candidate
        self.pending_resume_capability = None

    def request(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        if self._closed:
            raise RuntimeError("AgentTab client is closed")
        if self.pending_resume_capability is not None:
            raise RuntimeError(
                "Persist pending_resume_capability durably, then call confirm_resume_capability before RPC"
            )
        mutation_idempotency_key: str | None = None
        if method in MUTATIONS:
            mutation_idempotency_key = (
                idempotency_key if idempotency_key is not None else str(uuid7())
            )
        request_id = str(uuid.uuid4())
        request: JsonObject = {
            "protocol": RPC_PROTOCOL,
            "version": RPC_VERSION,
            "request_id": request_id,
            "method": method,
            "params": dict(params),
        }
        if mutation_idempotency_key is not None:
            request["idempotency_key"] = mutation_idempotency_key
        payload = encode_frame(request)
        try:
            response = self._exchange(payload)
        except (OSError, EOFError) as error:
            if not self._closed:
                self._close_after_transport_failure()
            if isinstance(error, (TimeoutError, socket.timeout)):
                code: TransportErrorCode = "request_timeout"
            elif isinstance(error, (EOFError, ConnectionError)):
                code = "connection_closed"
            else:
                code = "transport_error"
            raise AgentTabTransportError(
                method,
                code,
                mutation_idempotency_key,
            ) from error
        if response.get("request_id") != request_id:
            raise RuntimeError("AgentTab response request_id did not match the request")
        task = response.get("task")
        if isinstance(task, Mapping) and isinstance(task.get("resume_capability"), str):
            capability = task["resume_capability"]
            self.pending_resume_capability = capability
            if self._capability_store is not None:
                try:
                    self._capability_store.save(capability)
                except Exception as error:
                    raise AgentTabError(
                        {
                            "protocol": RPC_PROTOCOL,
                            "version": RPC_VERSION,
                            "request_id": request_id,
                            "ok": False,
                            "outcome": response.get("outcome", "unknown"),
                            "error": {
                                "code": "capability_persistence_failed",
                                "message": (
                                    "AgentTab completed the RPC but could not persist its "
                                    f"resume capability: {error}"
                                ),
                                "recovery": (
                                    "Repair the owner-only AgentTab client state directory "
                                    "before restarting or retrying."
                                ),
                            },
                        }
                    ) from error
                self.confirm_resume_capability()
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
