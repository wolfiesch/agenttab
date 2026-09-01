from __future__ import annotations

import io
import re
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agenttab import (
    AgentTabClient,
    AgentTabError,
    AgentTabTransportError,
    DEFAULT_BROWSER_CREDENTIALS_TIMEOUT,
    DEFAULT_BROWSER_HANDOFF_TIMEOUT,
    DEFAULT_BROWSER_WAIT_TIMEOUT,
    LONG_OPERATION_TRANSPORT_GRACE,
    encode_frame,
    read_frame,
    resolve_transport_timeout,
    uuid7,
)
from agenttab.client import create_resume_capability_store


class FramingTests(unittest.TestCase):
    def test_round_trip_and_uuid7(self) -> None:
        value = {"unicode": "AgentTab ✓"}
        self.assertEqual(read_frame(io.BytesIO(encode_frame(value))), value)
        key = str(uuid7(1_787_524_800_000))
        self.assertRegex(key, re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))
        self.assertEqual(int(key.replace("-", "")[:12], 16), 1_787_524_800_000)

    def test_oversize_declaration_is_rejected_before_payload_read(self) -> None:
        stream = io.BytesIO((9).to_bytes(4, "little"))
        with self.assertRaisesRegex(ValueError, "declares 9 bytes; limit is 8"):
            read_frame(stream, 8)


    def test_client_frames_use_utf8_bytes_with_a_1_mib_limit(self) -> None:
        request = {
            "protocol": "agenttab.rpc",
            "version": 1,
            "request_id": "00000000-0000-7000-8000-000000000001",
            "idempotency_key": "00000000-0000-7000-8000-000000000002",
            "method": "browser_act",
            "params": {
                "tab_id": 1,
                "expected_page_revision": 1,
                "actions": [
                    {"kind": "type", "ref": "e1@1", "text": "🧪" * 2048}
                    for _ in range(64)
                ],
            },
        }
        frame = encode_frame(request)

        payload_size = int.from_bytes(frame[:4], "little")
        self.assertGreater(payload_size, 64 * 1024)
        self.assertLessEqual(payload_size, 1024 * 1024)

    def test_client_frames_above_1_mib_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "limit is 1048576"):
            encode_frame({"text": "🧪" * 262_145})

    def test_host_response_frames_remain_capped_at_1_mib(self) -> None:
        stream = io.BytesIO((1024 * 1024 + 1).to_bytes(4, "little"))
        with self.assertRaisesRegex(ValueError, "declares 1048577 bytes; limit is 1048576"):
            read_frame(stream)

@unittest.skipIf(not hasattr(socket, "AF_UNIX"), "requires Unix sockets")
class ClientTests(unittest.TestCase):
    def test_long_operation_transport_deadlines_follow_protocol_timeouts(self) -> None:
        self.assertEqual(
            resolve_transport_timeout(
                "browser_wait",
                {"tab_id": 1, "condition": {"kind": "load"}},
            ),
            DEFAULT_BROWSER_WAIT_TIMEOUT + LONG_OPERATION_TRANSPORT_GRACE,
        )
        self.assertEqual(
            resolve_transport_timeout(
                "browser_wait",
                {
                    "tab_id": 1,
                    "condition": {"kind": "load"},
                    "timeout_ms": 120_000,
                },
            ),
            120 + LONG_OPERATION_TRANSPORT_GRACE,
        )
        self.assertEqual(
            resolve_transport_timeout(
                "browser_handoff",
                {
                    "tab_id": 1,
                    "expected_page_revision": 1,
                    "prompt": "Complete MFA",
                    "completion": {"kind": "manual_done"},
                },
            ),
            DEFAULT_BROWSER_HANDOFF_TIMEOUT + LONG_OPERATION_TRANSPORT_GRACE,
        )
        self.assertEqual(
            resolve_transport_timeout(
                "browser_credentials",
                {"action": "prepare", "tab_id": 1, "expected_page_revision": 1},
            ),
            DEFAULT_BROWSER_CREDENTIALS_TIMEOUT + LONG_OPERATION_TRANSPORT_GRACE,
        )
        self.assertEqual(resolve_transport_timeout("browser_tabs", {}, 45), 45)
        self.assertEqual(
            resolve_transport_timeout(
                "browser_wait",
                {"tab_id": 1, "condition": {"kind": "load"}, "timeout_ms": 1},
                45,
            ),
            45,
        )

    def test_requested_browser_wait_outlives_shorter_generic_client_timeout(self) -> None:
        class DelayedResponseStream(io.RawIOBase):
            def __init__(self) -> None:
                super().__init__()
                self.response = io.BytesIO()
                self.delayed = False

            def write(self, payload: bytes | bytearray) -> int:
                request = read_frame(io.BytesIO(payload))
                self.response = io.BytesIO(
                    encode_frame(
                        {
                            "protocol": "agenttab.rpc",
                            "version": 1,
                            "request_id": request["request_id"],
                            "ok": True,
                            "outcome": "completed",
                            "result": {"matched": True},
                        }
                    )
                )
                return len(payload)

            def read(self, size: int = -1) -> bytes:
                if not self.delayed:
                    self.delayed = True
                    time.sleep(0.03)
                return self.response.read(size)

            def flush(self) -> None:
                return None

        client = AgentTabClient(DelayedResponseStream(), {}, request_timeout=0.01)
        self.assertEqual(
            client.call(
                "browser_wait",
                {
                    "tab_id": 1,
                    "condition": {"kind": "load"},
                    "timeout_ms": 1,
                },
            ),
            {"matched": True},
        )
        client.close()

    def test_finish_task_preserves_deferred_connection_and_closes_when_finished(self) -> None:
        class CapabilityStore:
            def __init__(self) -> None:
                self.clears = 0

            def clear(self) -> None:
                self.clears += 1

        stream = io.BytesIO()
        store = CapabilityStore()
        client = AgentTabClient(stream, {}, capability_store=store)  # type: ignore[arg-type]
        responses = [
            {
                "finished": False,
                "disposition": "auto",
                "closed_tab_ids": [],
                "retained_tab_ids": [31],
                "deferred": "user_confirmation",
            },
            {
                "finished": True,
                "disposition": "close",
                "closed_tab_ids": [31],
                "retained_tab_ids": [],
            },
        ]
        with patch.object(client, "call", side_effect=responses) as call:
            self.assertFalse(client.finish_task()["finished"])
            self.assertFalse(client._closed)
            self.assertFalse(stream.closed)
            self.assertEqual(store.clears, 0)

            self.assertTrue(client.finish_task(disposition="close")["finished"])
            self.assertTrue(client._closed)
            self.assertTrue(stream.closed)
            self.assertEqual(store.clears, 1)
            self.assertEqual(
                call.call_args_list[1].args,
                (
                    "agenttab.finish",
                    {"disposition": "close", "keep_tab_ids": []},
                ),
            )

    def test_connection_and_typed_request(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(1)
            captured: list[dict[str, object]] = []

            def serve() -> None:
                connection, _ = server.accept()
                try:
                    hello = read_frame(connection)
                    self.assertEqual(hello["kind"], "connect")
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                        "resumed": False,
                        "state": "ready",
                    }, 1024 * 1024))
                    request = read_frame(connection)
                    captured.append(request)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "request_id": request["request_id"],
                        "ok": True,
                        "outcome": "completed",
                        "result": {"tab_id": 7},
                    }, 1024 * 1024))
                finally:
                    connection.close()

            worker = threading.Thread(target=serve)
            worker.start()
            with AgentTabClient.connect(endpoint=endpoint) as client:
                self.assertEqual(
                    client.call("browser_open", {"mode": "create", "url": "https://example.com"}),
                    {"tab_id": 7},
                )
            worker.join(timeout=2)
            server.close()
            self.assertRegex(str(captured[0]["idempotency_key"]), r"-7[0-9a-f]{3}-")

    def test_file_transport_enforces_request_deadline(self) -> None:
        class BlockingStream(io.RawIOBase):
            def __init__(self) -> None:
                super().__init__()
                self.release = threading.Event()

            def read(self, _size: int = -1) -> bytes:
                self.release.wait()
                return b""

            def write(self, payload: bytes | bytearray) -> int:
                return len(payload)

            def flush(self) -> None:
                return None

            def close(self) -> None:
                self.release.set()
                super().close()

        stream = BlockingStream()
        client = AgentTabClient(stream, {}, request_timeout=0.05)
        started = time.monotonic()
        with self.assertRaises(AgentTabTransportError) as raised:
            client.request("browser_tabs", {})
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(raised.exception.code, "request_timeout")
        self.assertEqual(raised.exception.outcome, "unknown")
        self.assertIsNone(raised.exception.idempotency_key)
        self.assertTrue(client._closed)

    def test_windows_named_pipe_read_deadline_is_classified_without_a_worker(self) -> None:
        class StalledWindowsPipe:
            _agenttab_windows_pipe = True

            def __init__(self) -> None:
                self.timeouts: list[float | None] = []
                self.closed = False

            def read(self, _size: int, timeout: float | None = None) -> bytes:
                self.timeouts.append(timeout)
                raise TimeoutError("stalled named pipe")

            def write(self, payload: bytes, _timeout: float | None = None) -> int:
                return len(payload)

            def flush(self) -> None:
                return None

            def close(self) -> None:
                self.closed = True

        stream = StalledWindowsPipe()
        client = AgentTabClient(stream, {}, request_timeout=0.05)
        with self.assertRaises(AgentTabTransportError) as raised:
            client.request("browser_tabs", {})
        self.assertEqual(raised.exception.code, "request_timeout")
        self.assertTrue(client._closed)
        self.assertTrue(stream.closed)
        self.assertEqual(len(stream.timeouts), 1)
        self.assertLessEqual(stream.timeouts[0] or 0, 0.05)

    def test_windows_named_pipe_write_deadline_is_classified_without_a_worker(self) -> None:
        class StalledWindowsPipe:
            _agenttab_windows_pipe = True

            def __init__(self) -> None:
                self.timeouts: list[float | None] = []
                self.closed = False
                self.read_called = False

            def read(self, _size: int, _timeout: float | None = None) -> bytes:
                self.read_called = True
                return b""

            def write(self, _payload: bytes, timeout: float | None = None) -> int:
                self.timeouts.append(timeout)
                raise TimeoutError("stalled named-pipe write")

            def flush(self) -> None:
                return None

            def close(self) -> None:
                self.closed = True

        stream = StalledWindowsPipe()
        client = AgentTabClient(stream, {}, request_timeout=0.05)
        with self.assertRaises(AgentTabTransportError) as raised:
            client.request("browser_tabs", {})
        self.assertEqual(raised.exception.code, "request_timeout")
        self.assertTrue(client._closed)
        self.assertTrue(stream.closed)
        self.assertFalse(stream.read_called)
        self.assertEqual(stream.timeouts, [0.05])

    def test_windows_named_pipe_negotiation_read_uses_connect_deadline(self) -> None:
        class StalledWindowsPipe:
            _agenttab_windows_pipe = True

            def __init__(self) -> None:
                self.timeouts: list[float | None] = []
                self.closed = False

            def read(self, _size: int, timeout: float | None = None) -> bytes:
                self.timeouts.append(timeout)
                raise TimeoutError("stalled named pipe")

            def write(self, payload: bytes, _timeout: float | None = None) -> int:
                return len(payload)

            def flush(self) -> None:
                return None

            def close(self) -> None:
                self.closed = True

        stream = StalledWindowsPipe()
        with patch("agenttab.client.os.name", "nt"), patch(
            "agenttab.client._open_windows_named_pipe",
            return_value=stream,
        ):
            with self.assertRaises(TimeoutError):
                AgentTabClient._negotiate_connection(
                    r"\\.\pipe\agenttab-test",
                    conversation_id=None,
                    resume_capability=None,
                    connect_timeout=0.05,
                    request_timeout=1.0,
                )
        self.assertTrue(stream.closed)
        self.assertEqual(len(stream.timeouts), 1)
        self.assertLessEqual(stream.timeouts[0] or 0, 0.05)

    def test_generated_mutation_key_survives_timeout_and_reuses(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(2)
            captured: list[dict[str, object]] = []
            release_first_request = threading.Event()

            def serve() -> None:
                for attempt in range(2):
                    connection, _ = server.accept()
                    try:
                        hello = read_frame(connection)
                        self.assertEqual(hello["kind"], "connect")
                        connection.sendall(encode_frame({
                            "protocol": "agenttab.rpc",
                            "version": 1,
                            "kind": "connected",
                            "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                            "resumed": False,
                            "state": "ready",
                        }, 1024 * 1024))
                        request = read_frame(connection)
                        captured.append(request)
                        if attempt == 0:
                            release_first_request.wait(timeout=2)
                        else:
                            connection.sendall(encode_frame({
                                "protocol": "agenttab.rpc",
                                "version": 1,
                                "request_id": request["request_id"],
                                "ok": True,
                                "outcome": "completed",
                                "result": {"tab_id": 7},
                            }, 1024 * 1024))
                    finally:
                        connection.close()

            worker = threading.Thread(target=serve)
            worker.start()
            try:
                with AgentTabClient.connect(
                    endpoint=endpoint,
                    request_timeout=0.1,
                ) as client:
                    with self.assertRaises(AgentTabTransportError) as raised:
                        client.call(
                            "browser_open",
                            {"mode": "create", "url": "https://example.com"},
                        )
                error = raised.exception
                self.assertEqual(error.method, "browser_open")
                self.assertEqual(error.code, "request_timeout")
                self.assertRegex(str(error.idempotency_key), r"-7[0-9a-f]{3}-")
                self.assertEqual(error.idempotency_key, captured[0]["idempotency_key"])
                self.assertIsInstance(error.__cause__, (TimeoutError, socket.timeout))

                release_first_request.set()
                with AgentTabClient.connect(endpoint=endpoint) as retry_client:
                    self.assertEqual(
                        retry_client.call(
                            "browser_open",
                            {"mode": "create", "url": "https://example.com"},
                            idempotency_key=error.idempotency_key,
                        ),
                        {"tab_id": 7},
                    )
            finally:
                release_first_request.set()
                worker.join(timeout=2)
                server.close()

            self.assertEqual(len(captured), 2)
            self.assertEqual(
                captured[0]["idempotency_key"],
                captured[1]["idempotency_key"],
            )

    def test_supplied_mutation_key_survives_connection_close_and_reuses(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(2)
            captured: list[dict[str, object]] = []
            supplied_key = "00000000-0000-7000-8000-000000000001"

            def serve() -> None:
                for attempt in range(2):
                    connection, _ = server.accept()
                    try:
                        hello = read_frame(connection)
                        self.assertEqual(hello["kind"], "connect")
                        connection.sendall(encode_frame({
                            "protocol": "agenttab.rpc",
                            "version": 1,
                            "kind": "connected",
                            "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                            "resumed": False,
                            "state": "ready",
                        }, 1024 * 1024))
                        request = read_frame(connection)
                        captured.append(request)
                        if attempt == 1:
                            connection.sendall(encode_frame({
                                "protocol": "agenttab.rpc",
                                "version": 1,
                                "request_id": request["request_id"],
                                "ok": True,
                                "outcome": "completed",
                                "result": {"tab_id": 7},
                            }, 1024 * 1024))
                    finally:
                        connection.close()

            worker = threading.Thread(target=serve)
            worker.start()
            try:
                with AgentTabClient.connect(endpoint=endpoint) as client:
                    with self.assertRaises(AgentTabTransportError) as raised:
                        client.call(
                            "browser_open",
                            {"mode": "create", "url": "https://example.com"},
                            idempotency_key=supplied_key,
                        )
                error = raised.exception
                self.assertEqual(error.method, "browser_open")
                self.assertEqual(error.code, "connection_closed")
                self.assertEqual(error.idempotency_key, supplied_key)
                self.assertEqual(captured[0]["idempotency_key"], supplied_key)
                self.assertIsInstance(error.__cause__, EOFError)

                with AgentTabClient.connect(endpoint=endpoint) as retry_client:
                    self.assertEqual(
                        retry_client.call(
                            "browser_open",
                            {"mode": "create", "url": "https://example.com"},
                            idempotency_key=error.idempotency_key,
                        ),
                        {"tab_id": 7},
                    )
            finally:
                worker.join(timeout=2)
                server.close()

            self.assertEqual(len(captured), 2)
            self.assertEqual(
                captured[0]["idempotency_key"],
                captured[1]["idempotency_key"],
            )

    def test_read_only_transport_error_has_no_idempotency_key(self) -> None:
        stream, peer = socket.socketpair()
        client = AgentTabClient(stream, {})
        try:
            peer.close()
            with self.assertRaises(AgentTabTransportError) as raised:
                client.request("browser_tabs", {})
            error = raised.exception
            self.assertEqual(error.method, "browser_tabs")
            self.assertEqual(error.code, "connection_closed")
            self.assertIsNone(error.idempotency_key)
        finally:
            client.close()

    def test_resumed_connection_requires_explicit_confirmation_before_rpc(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(1)
            candidate = "b" * 32

            def serve() -> None:
                connection, _ = server.accept()
                try:
                    hello = read_frame(connection)
                    self.assertEqual(hello["resume_capability"], "a" * 32)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                        "resumed": True,
                        "task_id": "018f22b2-4126-7c1a-8c31-3f45a783da43",
                        "resume_capability": candidate,
                        "state": "ready",
                    }, 1024 * 1024))
                    confirmation = read_frame(connection)
                    self.assertEqual(confirmation["kind"], "resume_confirm")
                    self.assertEqual(confirmation["resume_capability"], candidate)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "resume_confirmed",
                        "connection_id": confirmation["connection_id"],
                    }, 1024 * 1024))
                finally:
                    connection.close()

            worker = threading.Thread(target=serve)
            worker.start()
            client = AgentTabClient.connect(endpoint=endpoint, resume_capability="a" * 32)
            self.assertIsNone(client.resume_capability)
            self.assertEqual(client.pending_resume_capability, candidate)
            with self.assertRaisesRegex(RuntimeError, "Persist pending_resume_capability"):
                client.request("browser_tabs", {})
            client.confirm_resume_capability()
            self.assertEqual(client.resume_capability, candidate)
            client.close()
            worker.join(timeout=2)
            server.close()

    def test_failed_initial_capability_save_retains_a_confirmable_recovery_path(
        self,
    ) -> None:
        class FailOnceStore:
            path = Path("memory")

            def __init__(self) -> None:
                self.capability: str | None = None
                self.saves = 0

            def load(self) -> str | None:
                return self.capability

            def load_pending(self) -> str | None:
                return None

            def save(self, capability: str) -> None:
                self.saves += 1
                if self.saves == 1:
                    raise OSError("fsync failed")
                self.capability = capability

            def prepare_replacement(self, _current: str, _replacement: str) -> None:
                return None

            def activate_replacement(self, _replacement: str) -> None:
                return None

        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(1)
            capability = "c" * 32
            confirmations = 0
            methods: list[str] = []

            def serve() -> None:
                nonlocal confirmations
                connection, _ = server.accept()
                try:
                    read_frame(connection)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                        "resumed": False,
                        "state": "ready",
                    }, 1024 * 1024))
                    first = read_frame(connection)
                    methods.append(str(first["method"]))
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "request_id": first["request_id"],
                        "ok": True,
                        "outcome": "completed",
                        "result": {"created": True},
                        "task": {
                            "task_id": "018f22b2-4126-7c1a-8c31-3f45a783da43",
                            "resume_capability": capability,
                        },
                    }, 1024 * 1024))
                    confirmation = read_frame(connection)
                    self.assertEqual(confirmation["kind"], "resume_confirm")
                    self.assertEqual(confirmation["resume_capability"], capability)
                    confirmations += 1
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "resume_confirmed",
                        "connection_id": confirmation["connection_id"],
                    }, 1024 * 1024))
                    second = read_frame(connection)
                    methods.append(str(second["method"]))
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "request_id": second["request_id"],
                        "ok": True,
                        "outcome": "completed",
                        "result": {"recovered": True},
                    }, 1024 * 1024))
                finally:
                    connection.close()

            worker = threading.Thread(target=serve)
            worker.start()
            store = FailOnceStore()
            client = AgentTabClient.connect(endpoint=endpoint, capability_store=store)
            with self.assertRaises(AgentTabError) as raised:
                client.call("browser_open", {"mode": "create"})
            self.assertEqual(raised.exception.code, "capability_persistence_failed")
            self.assertEqual(confirmations, 0)
            self.assertEqual(client.pending_resume_capability, capability)
            self.assertIsNone(client.resume_capability)

            store.save(capability)
            client.confirm_resume_capability()
            self.assertEqual(confirmations, 1)
            self.assertEqual(client.resume_capability, capability)
            self.assertIsNone(client.pending_resume_capability)
            self.assertEqual(client.call("browser_tabs", {}), {"recovered": True})
            self.assertEqual(methods, ["browser_open", "browser_tabs"])
            client.close()
            worker.join(timeout=2)
            server.close()

    def test_rejected_resume_capability_does_not_fall_back_to_a_new_task(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(1)

            def serve() -> None:
                connection, _ = server.accept()
                try:
                    hello = read_frame(connection)
                    self.assertEqual(hello["resume_capability"], "a" * 32)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                        "resumed": False,
                        "state": "ready",
                    }, 1024 * 1024))
                finally:
                    connection.close()

            worker = threading.Thread(target=serve)
            worker.start()
            with self.assertRaisesRegex(RuntimeError, "rejected the supplied resume capability"):
                AgentTabClient.connect(endpoint=endpoint, resume_capability="a" * 32)
            worker.join(timeout=2)
            server.close()

    def test_retries_active_capability_after_pending_replacement_is_rejected(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            store = create_resume_capability_store(
                "python-sdk",
                scope="pending-fallback",
                state_dir=root,
            )
            active = "a" * 32
            pending = "b" * 32
            replacement = "c" * 32
            store.save(active)
            store.prepare_replacement(active, pending)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(2)
            attempted: list[str] = []

            def serve() -> None:
                rejected, _ = server.accept()
                try:
                    hello = read_frame(rejected)
                    attempted.append(str(hello["resume_capability"]))
                    rejected.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da41",
                        "resumed": False,
                        "state": "ready",
                    }, 1024 * 1024))
                finally:
                    rejected.close()

                resumed, _ = server.accept()
                try:
                    hello = read_frame(resumed)
                    attempted.append(str(hello["resume_capability"]))
                    resumed.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                        "resumed": True,
                        "task_id": "018f22b2-4126-7c1a-8c31-3f45a783da43",
                        "resume_capability": replacement,
                        "state": "ready",
                    }, 1024 * 1024))
                    confirmation = read_frame(resumed)
                    self.assertEqual(confirmation["resume_capability"], replacement)
                    resumed.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "resume_confirmed",
                        "connection_id": confirmation["connection_id"],
                    }, 1024 * 1024))
                finally:
                    resumed.close()

            worker = threading.Thread(target=serve)
            worker.start()
            client = AgentTabClient.connect(
                endpoint=endpoint,
                capability_store=store,
            )
            self.assertEqual(attempted, [pending, active])
            self.assertEqual(store.load(), replacement)
            self.assertIsNone(store.load_pending())
            client.close()
            worker.join(timeout=2)
            server.close()


    def test_explicit_memory_only_resume_is_rejected_when_a_store_is_configured(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = create_resume_capability_store(
                "python-sdk",
                scope="explicit-memory-only",
                state_dir=root,
            )
            with self.assertRaisesRegex(ValueError, "configured ResumeCapabilityStore"):
                AgentTabClient.connect(
                    resume_capability="a" * 32,
                    capability_store=store,
                )

    def test_durable_resume_prepares_before_confirmation_and_activates_after_success(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            store = create_resume_capability_store(
                "python-sdk",
                scope="prepare-before-confirm",
                state_dir=root,
            )
            active = "a" * 32
            replacement = "b" * 32
            store.save(active)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(1)

            def serve() -> None:
                connection, _ = server.accept()
                try:
                    hello = read_frame(connection)
                    self.assertEqual(hello["resume_capability"], active)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                        "resumed": True,
                        "task_id": "018f22b2-4126-7c1a-8c31-3f45a783da43",
                        "resume_capability": replacement,
                        "state": "ready",
                    }, 1024 * 1024))
                    confirmation = read_frame(connection)
                    self.assertEqual(confirmation["kind"], "resume_confirm")
                    self.assertEqual(confirmation["resume_capability"], replacement)
                    self.assertEqual(store.load(), active)
                    self.assertEqual(store.load_pending(), replacement)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "resume_confirmed",
                        "connection_id": confirmation["connection_id"],
                    }, 1024 * 1024))
                finally:
                    connection.close()

            worker = threading.Thread(target=serve)
            worker.start()
            client = AgentTabClient.connect(endpoint=endpoint, capability_store=store)
            self.assertEqual(client.resume_capability, replacement)
            self.assertIsNone(client.pending_resume_capability)
            self.assertEqual(store.load(), replacement)
            self.assertIsNone(store.load_pending())
            client.close()
            worker.join(timeout=2)
            server.close()

    def test_failed_resume_confirmation_retains_and_recovers_active_capability(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = create_resume_capability_store(
                "python-sdk",
                scope="confirmation-failure",
                state_dir=root,
            )
            active = "a" * 32
            failed_replacement = "b" * 32
            recovered_replacement = "c" * 32
            store.save(active)

            failed_endpoint = str(Path(root) / "failed.sock")
            failed_server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            failed_server.bind(failed_endpoint)
            failed_server.listen(1)

            def reject_confirmation() -> None:
                connection, _ = failed_server.accept()
                try:
                    hello = read_frame(connection)
                    self.assertEqual(hello["resume_capability"], active)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                        "resumed": True,
                        "task_id": "018f22b2-4126-7c1a-8c31-3f45a783da43",
                        "resume_capability": failed_replacement,
                        "state": "ready",
                    }, 1024 * 1024))
                    confirmation = read_frame(connection)
                    self.assertEqual(confirmation["resume_capability"], failed_replacement)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "resume_rejected",
                        "connection_id": confirmation["connection_id"],
                    }, 1024 * 1024))
                finally:
                    connection.close()

            failed_worker = threading.Thread(target=reject_confirmation)
            failed_worker.start()
            with self.assertRaisesRegex(RuntimeError, "durable resume-capability rotation"):
                AgentTabClient.connect(endpoint=failed_endpoint, capability_store=store)
            self.assertEqual(store.load(), active)
            self.assertEqual(store.load_pending(), failed_replacement)
            failed_worker.join(timeout=2)
            failed_server.close()

            recovery_endpoint = str(Path(root) / "recovery.sock")
            recovery_server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            recovery_server.bind(recovery_endpoint)
            recovery_server.listen(2)
            resumed_with: list[object] = []

            def recover() -> None:
                for expected, resumed in (
                    (failed_replacement, False),
                    (active, True),
                ):
                    connection, _ = recovery_server.accept()
                    try:
                        hello = read_frame(connection)
                        resumed_with.append(hello.get("resume_capability"))
                        self.assertEqual(hello["resume_capability"], expected)
                        connection.sendall(encode_frame({
                            "protocol": "agenttab.rpc",
                            "version": 1,
                            "kind": "connected",
                            "connection_id": (
                                "018f22b2-4126-7c1a-8c31-3f45a783da44"
                                if resumed
                                else "018f22b2-4126-7c1a-8c31-3f45a783da45"
                            ),
                            "resumed": resumed,
                            "task_id": "018f22b2-4126-7c1a-8c31-3f45a783da43",
                            "resume_capability": (
                                recovered_replacement if resumed else None
                            ),
                            "state": "ready",
                        }, 1024 * 1024))
                        if resumed:
                            confirmation = read_frame(connection)
                            self.assertEqual(
                                confirmation["resume_capability"],
                                recovered_replacement,
                            )
                            connection.sendall(encode_frame({
                                "protocol": "agenttab.rpc",
                                "version": 1,
                                "kind": "resume_confirmed",
                                "connection_id": confirmation["connection_id"],
                            }, 1024 * 1024))
                    finally:
                        connection.close()

            recovery_worker = threading.Thread(target=recover)
            recovery_worker.start()
            client = AgentTabClient.connect(
                endpoint=recovery_endpoint,
                capability_store=store,
            )
            self.assertEqual(resumed_with, [failed_replacement, active])
            self.assertEqual(client.resume_capability, recovered_replacement)
            self.assertEqual(store.load(), recovered_replacement)
            self.assertIsNone(store.load_pending())
            client.close()
            recovery_worker.join(timeout=2)
            recovery_server.close()

    def test_pending_replacement_is_reconciled_before_the_active_capability(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as root:
            endpoint = str(Path(root) / "agenttab.sock")
            store = create_resume_capability_store(
                "python-sdk",
                scope="pending-reconciliation",
                state_dir=root,
            )
            active = "a" * 32
            pending = "b" * 32
            replacement = "c" * 32
            store.save(active)
            store.prepare_replacement(active, pending)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(endpoint)
            server.listen(1)

            def serve() -> None:
                connection, _ = server.accept()
                try:
                    hello = read_frame(connection)
                    self.assertEqual(hello["resume_capability"], pending)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "connected",
                        "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                        "resumed": True,
                        "task_id": "018f22b2-4126-7c1a-8c31-3f45a783da43",
                        "resume_capability": replacement,
                        "state": "ready",
                    }, 1024 * 1024))
                    confirmation = read_frame(connection)
                    self.assertEqual(store.load(), pending)
                    self.assertEqual(store.load_pending(), replacement)
                    connection.sendall(encode_frame({
                        "protocol": "agenttab.rpc",
                        "version": 1,
                        "kind": "resume_confirmed",
                        "connection_id": confirmation["connection_id"],
                    }, 1024 * 1024))
                finally:
                    connection.close()

            worker = threading.Thread(target=serve)
            worker.start()
            client = AgentTabClient.connect(endpoint=endpoint, capability_store=store)
            self.assertEqual(client.resume_capability, replacement)
            self.assertEqual(store.load(), replacement)
            self.assertIsNone(store.load_pending())
            client.close()
            worker.join(timeout=2)
            server.close()

if __name__ == "__main__":
    unittest.main()
