#!/usr/bin/env python3
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BROKER = SCRIPT_DIR / "broker.py"
BACKEND_ERROR = "broker backend unavailable: native host did not start"

failures = []


def expect(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"FAIL: {msg}")


def unused_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def connect_client(port, proc, timeout=5):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"broker exited early with {proc.returncode}")
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=0.5)
            sock.settimeout(10)
            return sock
        except OSError as exc:
            last_error = exc
            time.sleep(0.05)
    raise RuntimeError(f"broker did not accept client on {port}: {last_error}")


def start_broker(public_port, backend_port, tmp, extra_env):
    env = os.environ.copy()
    env.update({
        "BRIDGE_BROKER_PORT": str(public_port),
        "BRIDGE_BACKEND_PORT": str(backend_port),
        "BRIDGE_BROKER_SOCKET_IDLE_TIMEOUT": "10",
        "BRIDGE_BROKER_LOG_FILE": str(tmp / "broker.log"),
        "PYTHONUNBUFFERED": "1",
    })
    env.update(extra_env)
    proc = subprocess.Popen(
        [sys.executable, str(BROKER)],
        cwd=SCRIPT_DIR,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


def stop_broker(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def delayed_fake_backend(port):
    time.sleep(0.5)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(1)
    conn, _ = server.accept()
    try:
        buffer = b""
        while True:
            while b"\n" not in buffer:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buffer += chunk
            line, buffer = buffer.split(b"\n", 1)
            request = json.loads(line.decode("utf-8"))
            response = {"success": True, "result": {"echo": request.get("action")}}
            conn.sendall(json.dumps(response).encode("utf-8") + b"\n")
    finally:
        conn.close()
        server.close()


def read_line(sock):
    buffer = b""
    while b"\n" not in buffer:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buffer += chunk
    expect(buffer.strip(), "expected broker response line")
    return json.loads(buffer.split(b"\n", 1)[0].decode("utf-8"))


def test_default_timeout_contract():
    saved = os.environ.pop("BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS", None)
    try:
        spec = importlib.util.spec_from_file_location("broker_contract_module", BROKER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.refresh_config()
        expect(
            module.BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS == 10.0,
            "default backend timeout must remain below the 15s client deadline",
        )
    finally:
        if saved is not None:
            os.environ["BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS"] = saved


def test_delayed_backend_then_proxy_persistent_socket():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        (tmp / "bridge_token.txt").write_text("broker-token\n", encoding="utf-8")
        public_port = unused_port()
        backend_port = unused_port()
        threading.Thread(target=delayed_fake_backend, args=(backend_port,), daemon=True).start()
        proc = start_broker(public_port, backend_port, tmp, {
            "BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS": "5",
        })
        try:
            with connect_client(public_port, proc) as client:
                client.sendall(b'{"action":"ping","payload":{},"token":"broker-token"}\n')
                response = read_line(client)
                expect(response.get("result", {}).get("echo") == "ping", f"ping echo mismatch: {response}")
                client.sendall(b'{"action":"getTabs","payload":{},"token":"broker-token"}\n')
                response = read_line(client)
                expect(response.get("result", {}).get("echo") == "getTabs", f"getTabs echo mismatch: {response}")
        finally:
            stop_broker(proc)


def test_backend_unavailable_error():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        public_port = unused_port()
        backend_port = unused_port()
        proc = start_broker(public_port, backend_port, tmp, {
            "BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS": "1",
        })
        try:
            with connect_client(public_port, proc) as client:
                response = read_line(client)
            expect(response.get("success") is False, f"expected failure response: {response}")
            expect(response.get("error") == BACKEND_ERROR, f"broker error mismatch: {response}")
            expect(response.get("status") == "browser_unavailable", f"broker status mismatch: {response}")
        finally:
            stop_broker(proc)


def main():
    for test in [
        test_default_timeout_contract,
        test_delayed_backend_then_proxy_persistent_socket,
        test_backend_unavailable_error,
    ]:
        try:
            test()
        except Exception as exc:
            expect(False, f"{test.__name__} raised {exc!r}")
    if failures:
        print(f"\n{len(failures)} broker contract failure(s).")
        return 1
    print("Broker contract OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
