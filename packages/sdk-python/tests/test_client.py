from __future__ import annotations

import io
import re
import socket
import sys
import tempfile
import threading
import unittest
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agenttab import AgentTabClient, AgentTabTransportError, encode_frame, read_frame, uuid7
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
