"""Persistent bridge transport for the MCP server.

Keeps one serialized newline-framed TCP connection open across MCP calls.
Connection establishment may retry because the host has not received an action;
after any send attempt, failures are returned without replaying the action.
"""
import importlib.util
import json
import os
import socket
import sys
import threading
import time

# Repo root is the parent of the ``mcp/`` package directory.
_REPO_ROOT = os.environ.get(
    "BRIDGE_REPO_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__)))),
)


def _load_test_client():
    path = os.path.join(_REPO_ROOT, "test_client.py")
    if not os.path.exists(path):
        raise RuntimeError(
            f"Cannot locate test_client.py at {path}. Set BRIDGE_REPO_ROOT to the "
            "chrome-native-bridge checkout."
        )
    # ``test_client.py`` imports sibling helpers such as ``bridge_wake``. A
    # packaged/uvx MCP launch does not naturally put the checkout root on
    # sys.path (unlike invoking the CLI from the repo), which used to crash the
    # MCP process at startup with ModuleNotFoundError while the CLI worked.
    repo_root = os.path.realpath(_REPO_ROOT)
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    spec = importlib.util.spec_from_file_location("chrome_bridge_test_client", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("chrome_bridge_test_client", module)
    spec.loader.exec_module(module)
    return module


_client = _load_test_client()
# One bridge consumer at a time: serialize access to the persistent socket.
_call_lock = threading.Lock()


class BridgeError(Exception):
    """Raised when the bridge transport or the extension reports a failure."""


class PersistentBridgeConnection:
    def __init__(self):
        self._socket = None
        self._buffer = b""
        self._endpoint = None
        self._last_used = 0.0

    def close(self):
        sock, self._socket = self._socket, None
        self._buffer = b""
        self._endpoint = None
        self._last_used = 0.0
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _connect(self, endpoint, response_timeout):
        retry_seconds = _client.env_float("BRIDGE_CONNECT_TIMEOUT_SECONDS", 45.0)
        deadline = time.monotonic() + retry_seconds
        while True:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(15)
            try:
                sock.connect(endpoint)
                sock.settimeout(response_timeout)
                self._socket = sock
                self._endpoint = endpoint
                self._buffer = b""
                return None
            except ConnectionRefusedError:
                sock.close()
                if time.monotonic() >= deadline:
                    return (
                        111,
                        None,
                        "Error: browser unavailable. Chrome may be closed, the extension may be "
                        "disabled, or the native connection may be disconnected.",
                    )
                time.sleep(0.5)
            except OSError as exc:
                sock.close()
                return 1, None, f"Error connecting to bridge: {exc}"

    def _recv_line(self):
        while b"\n" not in self._buffer:
            chunk = self._socket.recv(65536)
            if not chunk:
                raise ConnectionError("bridge closed the persistent connection")
            self._buffer += chunk
        line, self._buffer = self._buffer.split(b"\n", 1)
        return line

    def request(
        self,
        action,
        payload=None,
        read_timeout_ms=None,
        confirmation_token=None,
        dry_run=False,
        token=None,
    ):
        payload = dict(payload or {})
        if read_timeout_ms is None:
            payload_timeout = payload.get("timeoutMs")
            if isinstance(payload_timeout, (int, float)) and payload_timeout > 0:
                read_timeout_ms = payload_timeout
        resolved_token = token or _client.load_token()
        if not resolved_token:
            return 2, None, "Error: could not read bridge token."
        response_timeout = _client.response_timeout_seconds(read_timeout_ms)
        endpoint = ("127.0.0.1", int(os.environ.get("BRIDGE_PORT", "9223")))
        max_idle = _client.env_float("BRIDGE_MCP_CONNECTION_MAX_IDLE_SECONDS", 240.0)
        if (
            self._socket is not None
            and (
                self._endpoint != endpoint
                or (max_idle >= 0 and time.monotonic() - self._last_used > max_idle)
            )
        ):
            self.close()
        if self._socket is None:
            error = self._connect(endpoint, response_timeout)
            if error is not None:
                return error
        else:
            self._socket.settimeout(response_timeout)

        command = {"action": action, "payload": payload, "token": resolved_token}
        if dry_run:
            command["dryRun"] = True
        if isinstance(confirmation_token, str) and confirmation_token:
            command["confirmationToken"] = confirmation_token
        encoded = (json.dumps(command) + "\n").encode("utf-8")
        try:
            self._socket.sendall(encoded)
            response = json.loads(self._recv_line().decode("utf-8"))
            self._last_used = time.monotonic()
        except socket.timeout:
            self.close()
            return 124, None, (
                f"Error: timed out after {response_timeout:g}s waiting for a bridge response. "
                "The action was not replayed because it may have reached Chrome."
            )
        except (ConnectionError, OSError, ValueError) as exc:
            self.close()
            return 1, None, (
                f"Error communicating over the persistent bridge connection: {exc}. "
                "The action was not replayed because delivery is ambiguous."
            )
        exit_code = 0 if response.get("success") is True else 1
        result = response.get("result")
        if isinstance(result, dict) and result.get("success") is False:
            exit_code = 1
        return exit_code, response, ""


_connection = PersistentBridgeConnection()


def call(action, payload=None, read_timeout_ms=None, confirmation_token=None, dry_run=False,
         token=None):
    """Send one action and return its result without ambiguous replays.

    The persistent connection is serialized for newline framing. It reconnects
    only before a send when no live socket exists; any failure after ``sendall``
    closes the socket and surfaces an error so mutating actions cannot run twice.
    """
    with _call_lock:
        exit_code, response, stderr = _connection.request(
            action,
            payload or {},
            read_timeout_ms=read_timeout_ms,
            confirmation_token=confirmation_token,
            dry_run=dry_run,
            token=token,
        )

    if response is None:
        raise BridgeError(stderr or "No response from bridge.")

    if response.get("success") is not True:
        err = response.get("error") or stderr or "Bridge reported failure."
        if err == "unauthorized":
            err = ("unauthorized: bridge token mismatch. Ensure the MCP server "
                   "reads the same bridge_token.txt as the running host "
                   "(check BRIDGE_TOKEN_FILE / BRIDGE_REPO_ROOT).")
        raise BridgeError(err)

    # A dry run carries its verdict at the top level, not under ``result``.
    if response.get("dryRun") is True:
        return {k: v for k, v in response.items() if k != "success"}

    result = response.get("result")
    if isinstance(result, dict) and result.get("success") is False:
        raise BridgeError(result.get("err") or "Extension action failed.")
    return result


def resolve_tab_id(tab_id, token=None):
    """Return ``tab_id`` if given, else the active tab's id.

    Falls back to the first tab when no tab is marked active. ``token`` is the
    same per-request identity override ``call`` takes, so the lookup runs as
    the requesting client rather than the ambient one.
    """
    if tab_id is not None:
        return tab_id
    tabs = call("getTabs", token=token)
    if not isinstance(tabs, list) or not tabs:
        raise BridgeError("No open tabs to resolve an active tab from.")
    for tab in tabs:
        if tab.get("active"):
            return tab.get("id")
    return tabs[0].get("id")
