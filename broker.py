#!/usr/bin/env python3
from __future__ import annotations

import json
import logging
import os
import socket
import sys
import threading
import time

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
BACKEND_ERROR = "broker backend unavailable: native host did not start"

BRIDGE_BROKER_PORT = 9223
BRIDGE_BACKEND_PORT = 19223
BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS = 10.0
BRIDGE_BROKER_SOCKET_IDLE_TIMEOUT = 300.0
BRIDGE_BROKER_LOG_FILE = os.path.join(SCRIPT_DIR, "broker_debug.log")


def env_value(name: str, default, cast):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return cast(value)
    except ValueError:
        logging.warning("Invalid %s=%r; using %r", name, value, default)
        return default


def refresh_config() -> None:
    global BRIDGE_BROKER_PORT
    global BRIDGE_BACKEND_PORT
    global BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS
    global BRIDGE_BROKER_SOCKET_IDLE_TIMEOUT
    global BRIDGE_BROKER_LOG_FILE

    BRIDGE_BROKER_PORT = env_value("BRIDGE_BROKER_PORT", 9223, int)
    BRIDGE_BACKEND_PORT = env_value("BRIDGE_BACKEND_PORT", 19223, int)
    BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS = env_value("BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS", 10.0, float)
    BRIDGE_BROKER_SOCKET_IDLE_TIMEOUT = env_value("BRIDGE_BROKER_SOCKET_IDLE_TIMEOUT", 300.0, float)
    BRIDGE_BROKER_LOG_FILE = os.environ.get(
        "BRIDGE_BROKER_LOG_FILE", os.path.join(SCRIPT_DIR, "broker_debug.log")
    )


def configure_logging() -> None:
    refresh_config()
    os.makedirs(os.path.dirname(BRIDGE_BROKER_LOG_FILE) or ".", exist_ok=True)
    logging.basicConfig(
        filename=BRIDGE_BROKER_LOG_FILE,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(threadName)s %(message)s",
    )


def connect_backend(deadline: float) -> socket.socket | None:
    while True:
        try:
            backend = socket.create_connection(("127.0.0.1", BRIDGE_BACKEND_PORT), timeout=1)
            logging.info("Native backend connected on 127.0.0.1:%s", BRIDGE_BACKEND_PORT)
            return backend
        except ConnectionRefusedError:
            logging.debug("Native backend is not listening on 127.0.0.1:%s", BRIDGE_BACKEND_PORT)
        except OSError as exc:
            logging.debug("Backend connect failed: %s", exc)

        if time.monotonic() >= deadline:
            logging.warning(
                "Native backend unavailable on 127.0.0.1:%s after %.1fs; refusing without opening Chrome",
                BRIDGE_BACKEND_PORT,
                BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS,
            )
            return None
        time.sleep(0.5)


def pipe(src: socket.socket, dst: socket.socket, label: str) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except (socket.timeout, OSError) as exc:
        logging.debug("Pipe %s closed: %s", label, exc)
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle_client(client_socket: socket.socket, addr) -> None:
    backend_socket = None
    try:
        client_socket.settimeout(BRIDGE_BROKER_SOCKET_IDLE_TIMEOUT)
        deadline = time.monotonic() + BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS
        backend_socket = connect_backend(deadline)
        if backend_socket is None:
            response = {
                "success": False,
                "status": "browser_unavailable",
                "error": BACKEND_ERROR,
            }
            client_socket.sendall(json.dumps(response).encode("utf-8") + b"\n")
            return
        backend_socket.settimeout(BRIDGE_BROKER_SOCKET_IDLE_TIMEOUT)
        threads = [
            threading.Thread(
                target=pipe,
                args=(client_socket, backend_socket, "client-to-backend"),
                daemon=True,
            ),
            threading.Thread(
                target=pipe,
                args=(backend_socket, client_socket, "backend-to-client"),
                daemon=True,
            ),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    except OSError as exc:
        logging.warning("Client %r failed: %s", addr, exc)
    finally:
        for sock in (backend_socket, client_socket):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass


def server_loop() -> None:
    refresh_config()
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind(("127.0.0.1", BRIDGE_BROKER_PORT))
    except OSError:
        logging.exception("Broker bind failed on 127.0.0.1:%s", BRIDGE_BROKER_PORT)
        sys.exit(1)
    server.listen(20)
    logging.info(
        "Broker listening on 127.0.0.1:%s, backend 127.0.0.1:%s",
        BRIDGE_BROKER_PORT,
        BRIDGE_BACKEND_PORT,
    )
    while True:
        client_socket, addr = server.accept()
        threading.Thread(target=handle_client, args=(client_socket, addr), daemon=True).start()


def main() -> None:
    configure_logging()
    server_loop()


if __name__ == "__main__":
    main()
