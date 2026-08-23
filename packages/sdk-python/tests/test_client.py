from __future__ import annotations

import io
import re
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agenttab import AgentTabClient, encode_frame, read_frame, uuid7


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


if __name__ == "__main__":
    unittest.main()
