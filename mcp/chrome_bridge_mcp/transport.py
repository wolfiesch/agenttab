"""Bridge transport for the MCP server.

Reuses ``send_command_data`` from the repo-root ``test_client.py`` verbatim so
the MCP surface and the CLI share one wire implementation (connect-retry, token
load, newline framing, socket timeout). ``test_client`` guards its CLI behind
``if __name__ == '__main__'``, so importing it is side-effect-free.
"""
import importlib.util
import os
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
# One bridge consumer at a time: serialize outbound TCP calls.
_call_lock = threading.Lock()


class BridgeError(Exception):
    """Raised when the bridge transport or the extension reports a failure."""


def call(action, payload=None, read_timeout_ms=None, confirmation_token=None, dry_run=False):
    """Send one action to the bridge and return its ``result`` payload.

    Raises ``BridgeError`` with an actionable message on transport failures,
    auth rejection, or an unsuccessful extension result. ``read_timeout_ms``
    extends the post-connect socket read deadline for long waits (e.g. human
    handoff); the wire timeout is kept above it so transport never fires first.
    ``dry_run`` sets the request-level ``dryRun`` flag: the host evaluates the
    request and reports its verdict without forwarding anything to Chrome.
    """
    with _call_lock:
        exit_code, response, stderr = _client.send_command_data(
            action, payload or {}, read_timeout_ms=read_timeout_ms,
            confirmation_token=confirmation_token, dry_run=dry_run)
        # One reconnect attempt is safe only when TCP connection setup failed:
        # exit 111 means the host never received the action. Never replay after
        # an empty response or timeout because a mutating action may have run.
        if exit_code == 111 and response is None:
            delay_ms = float(os.environ.get("BRIDGE_MCP_RECONNECT_DELAY_MS", "100"))
            if delay_ms > 0:
                time.sleep(delay_ms / 1000)
            exit_code, response, stderr = _client.send_command_data(
                action, payload or {}, read_timeout_ms=read_timeout_ms,
                confirmation_token=confirmation_token, dry_run=dry_run)

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


def resolve_tab_id(tab_id):
    """Return ``tab_id`` if given, else the active tab's id.

    Falls back to the first tab when no tab is marked active.
    """
    if tab_id is not None:
        return tab_id
    tabs = call("getTabs")
    if not isinstance(tabs, list) or not tabs:
        raise BridgeError("No open tabs to resolve an active tab from.")
    for tab in tabs:
        if tab.get("active"):
            return tab.get("id")
    return tabs[0].get("id")
