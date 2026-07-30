#!/usr/bin/env python3
"""Offline contract test for the MCP server.

Stands up a mock TCP bridge (same newline-framed protocol as bridge.py),
imports the MCP tool functions, and asserts each tool emits the exact
{action, payload} the CLI sends, that an omitted tab_id resolves the active
tab, that screenshots return inline image content, and that bridge failures map
to BridgeError. No browser or real host needed.
"""
import asyncio
import json
import os
import tempfile
import shutil
import socket
import subprocess
import sys
import threading
import time

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))

# Point the MCP package at this checkout and a fixed test port, then make it
# importable.
PORT = 9226
os.environ["BRIDGE_REPO_ROOT"] = SCRIPT_DIR
os.environ["BRIDGE_PORT"] = str(PORT)
os.environ["BRIDGE_CONNECT_TIMEOUT_SECONDS"] = "5"
TOKEN_FIXTURE = "/tmp/chrome-bridge-mcp-token.txt"
with open(TOKEN_FIXTURE, "w", encoding="utf-8") as f:
    f.write("mcp-token\n")
os.environ["BRIDGE_TOKEN_FILE"] = TOKEN_FIXTURE
# Hermetic gating: do not inherit scoping flags from the runner's environment.
os.environ.pop("BRIDGE_MCP_READONLY", None)
os.environ.pop("BRIDGE_MCP_ALLOW_SENSITIVE", None)

sys.path.insert(0, os.path.join(SCRIPT_DIR, "mcp"))
from chrome_bridge_mcp import server  # noqa: E402
from chrome_bridge_mcp import transport  # noqa: E402
from chrome_bridge_mcp.transport import BridgeError  # noqa: E402

# Captured requests the mock bridge received.
received = []
received_raw = []
received_lock = threading.Lock()
accepted_connections = 0


# The active result function; swap it to change mock behavior without rebinding.
_result_fn = None


def serve():
    global accepted_connections
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT))
    srv.listen(8)
    srv.settimeout(0.5)
    while not stop_event.is_set():
        try:
            conn, _ = srv.accept()
            accepted_connections += 1
        except socket.timeout:
            continue
        except OSError:
            break
        with conn:
            buf = b""
            while not stop_event.is_set():
                while b"\n" not in buf:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                if b"\n" not in buf:
                    break
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                req = json.loads(line.decode("utf-8"))
                if req.get("token") != "mcp-token":
                    conn.sendall((json.dumps({"success": False, "error": "unauthorized"}) + "\n").encode())
                    continue
                action, payload = req.get("action"), req.get("payload")
                with received_lock:
                    received.append((action, payload))
                    received_raw.append(req)
                try:
                    result = _result_fn(action, payload)
                    resp = {"success": True, "result": result}
                except Exception as exc:  # noqa: BLE001
                    resp = {"success": False, "error": str(exc)}
                conn.sendall((json.dumps(resp) + "\n").encode())
    srv.close()


stop_event = threading.Event()

failures = []


def expect(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"FAIL: {msg}")


def last_request():
    with received_lock:
        return received[-1] if received else (None, None)


def last_raw_request():
    with received_lock:
        return received_raw[-1] if received_raw else {}


def _tool_names(srv):
    return {t.name for t in srv._tool_manager.list_tools()}


def _resource_uris(srv):
    res = asyncio.run(srv.list_resources())
    tmpl = asyncio.run(srv.list_resource_templates())
    return {str(r.uri) for r in res} | {str(t.uriTemplate) for t in tmpl}


class _Unauthorized(Exception):
    def __str__(self):
        return "unauthorized"


# Default mock: active-tab tabs list, and per-action canned results.
TABS = [
    {"id": 11, "active": False, "url": "https://a.test", "title": "A"},
    {"id": 22, "active": True, "url": "https://b.test", "title": "B"},
]


def default_result(action, payload):
    if action == "ping":
        return "pong"
    if action == "getTabs":
        return TABS
    if action == "navigate":
        return {"tabId": 99}
    if action == "createTaskSession":
        return {"sessionId": "session-1", "name": payload.get("name"), "tabIds": []}
    if action == "navigateTaskSession":
        return {"sessionId": payload.get("sessionId"), "tabId": 99, "active": payload.get("active")}
    if action == "getTaskSessions":
        return []
    if action == "observe":
        return [{"role": "button", "name": "OK"}]
    if action == "extractText":
        return {"success": True, "text": "hello"}
    if action == "screenshot":
        return {"success": True, "mimeType": "image/png", "dataUrl": "data:image/png;base64,QUJD"}
    if action == "getHTML":
        return {"success": True, "html": "H" * 50}
    if action == "getCurrentState":
        return {"success": True, "tab": {"id": payload.get("tabId"), "url": "https://b.test"}}
    if action == "getCookies":
        return [{"name": "sid", "domain": payload.get("domain")}]
    return {"success": True, "tabId": payload.get("tabId")}


def main():
    global _result_fn
    _result_fn = default_result
    t = threading.Thread(target=serve, daemon=True)
    t.start()
    time.sleep(0.2)

    ready = json.loads(server.browser_ready(timeout_ms=500, poll_interval_ms=50))
    expect(ready["ready"] is True and ready["extension"] == "connected",
           "browser_ready should report the live mock extension")

    # 1. list_tabs -> getTabs, no payload tabId.
    server.browser_list_tabs()
    expect(last_request()[0] == "getTabs", "list_tabs should call getTabs")

    # 2. navigate -> navigate with url.
    server.browser_navigate("https://x.test")
    action, payload = last_request()
    expect(action == "navigate" and payload == {"url": "https://x.test"}, "navigate payload mismatch")
    server.browser_navigate_and_snapshot(
        "https://x.test",
        session_id="session-1",
        wait_mode="selector",
        selector="#ready",
        timeout_ms=2000,
        roles=["button"],
        diff=True,
    )
    expect(last_request() == ("navigateAndSnapshot", {
        "url": "https://x.test",
        "reuse": True,
        "active": False,
        "waitMode": "selector",
        "timeoutMs": 2000,
        "compact": True,
        "limit": 50,
        "diff": True,
        "sessionId": "session-1",
        "selector": "#ready",
        "roles": ["button"],
    }), "navigate_and_snapshot payload mismatch")
    try:
        server.browser_navigate_and_snapshot("https://x.test", wait_mode="url")
        expect(False, "navigate_and_snapshot accepted URL wait without url_substring")
    except ValueError:
        pass


    server.browser_task_session_create("research")
    expect(last_request() == ("createTaskSession", {"name": "research"}), "task session create mismatch")
    server.browser_task_session_navigate("session-1", "https://x.test")
    expect(last_request() == ("navigateTaskSession", {
        "sessionId": "session-1", "url": "https://x.test", "reuse": True, "active": False,
    }), "task session navigate mismatch")
    server.browser_task_session_list("session-1")
    expect(last_request() == ("getTaskSessions", {"sessionId": "session-1"}), "task session list mismatch")
    server.browser_task_session_state("session-1", "completed")
    expect(last_request() == ("updateTaskSessionState", {
        "sessionId": "session-1", "state": "completed",
    }), "task session state mismatch")
    server.browser_task_session_close("session-1")
    expect(last_request() == ("closeTaskSession", {"sessionId": "session-1"}), "task session close mismatch")

    # 3. snapshot with explicit tab_id -> observe with that tabId (no active-tab lookup).
    with received_lock:
        received.clear()
    server.browser_snapshot(tab_id=11)
    expect(last_request() == ("observe", {"tabId": 11, "compact": True, "limit": 50}), "snapshot explicit tabId mismatch")
    with received_lock:
        only_observe = [a for a, _ in received] == ["observe"]
    expect(only_observe, "snapshot with explicit tabId must not call getTabs")

    # 4. snapshot with omitted tab_id -> resolves active tab (22) via getTabs.
    with received_lock:
        received.clear()
    server.browser_snapshot()
    with received_lock:
        seq = [a for a, _ in received]
    expect(seq == ["getTabs", "observe"], f"snapshot active-tab resolve sequence wrong: {seq}")
    expect(last_request() == ("observe", {"tabId": 22, "compact": True, "limit": 50}), "snapshot should target active tab 22")

    server.browser_snapshot(tab_id=11, compact=False, roles=["button", "link"], name="save", limit=10)
    expect(last_request() == ("observe", {
        "tabId": 11, "compact": False, "roles": ["button", "link"], "name": "save", "limit": 10,
    }), "filtered snapshot payload mismatch")

    # 5. extract_text default max_chars.
    server.browser_extract_text(tab_id=11)
    expect(last_request() == ("extractText", {"tabId": 11, "maxChars": 20000}), "extract_text payload mismatch")

    # 6. click / type / fill payloads.
    server.browser_click("#go", tab_id=11)
    expect(last_request() == ("click", {"tabId": 11, "selector": "#go"}), "click payload mismatch")
    server.browser_type("#q", "hello", tab_id=11)
    expect(last_request() == ("type", {"tabId": 11, "selector": "#q", "text": "hello"}), "type payload mismatch")
    server.browser_fill("#q", "hi", tab_id=11)
    expect(last_request() == ("fill", {"tabId": 11, "selector": "#q", "text": "hi"}), "fill payload mismatch")
    rich_nodes = [
        {"type": "heading", "attrs": {"level": 2}, "children": [
            {"type": "text", "text": "Title", "marks": ["bold"]},
        ]},
        {"type": "paragraph", "children": [
            {"type": "text", "text": "Body"},
        ]},
    ]
    server.browser_insert_rich_text("#editor", rich_nodes, tab_id=11)
    expect(last_request() == ("insertRichText", {
        "tabId": 11, "selector": "#editor", "nodes": rich_nodes, "clear": True,
    }), "insert_rich_text payload mismatch")


    # 7. wait_for modes map to the right actions.
    server.browser_wait_for("load", tab_id=11)
    expect(last_request() == ("waitForLoad", {"tabId": 11, "timeoutMs": 10000}), "wait_for load mismatch")
    server.browser_wait_for("selector", tab_id=11, selector="#r", timeout_ms=2000)
    expect(last_request() == ("waitForSelector", {"tabId": 11, "selector": "#r", "timeoutMs": 2000}), "wait_for selector mismatch")
    server.browser_wait_for("text", tab_id=11, text="Done")
    expect(last_request() == ("waitForText", {"tabId": 11, "text": "Done", "timeoutMs": 10000}), "wait_for text mismatch")
    server.browser_wait_for("url", tab_id=11, url_substring="x.test")
    expect(last_request() == ("waitForUrl", {"tabId": 11, "substring": "x.test", "timeoutMs": 10000}), "wait_for url mismatch")

    # 7a. expect modes map to the one `expect` action, with only assertion fields.
    server.browser_expect("selector", tab_id=11, selector="#done")
    expect(last_request() == ("expect", {"tabId": 11, "mode": "selector", "timeoutMs": 5000, "selector": "#done"}),
           "expect selector payload mismatch")
    server.browser_expect("text", tab_id=11, text="Done", negate=True, timeout_ms=1500)
    expect(last_request() == ("expect", {"tabId": 11, "mode": "text", "timeoutMs": 1500, "negate": True, "text": "Done"}),
           "expect text/negate payload mismatch")
    server.browser_expect("url", tab_id=11, url_substring="x.test")
    expect(last_request() == ("expect", {"tabId": 11, "mode": "url", "timeoutMs": 5000, "urlSubstring": "x.test"}),
           "expect url payload mismatch")
    server.browser_expect("schema", tab_id=11, schema={"type": "object"}, selector="#s")
    expect(last_request() == ("expect", {"tabId": 11, "mode": "schema", "timeoutMs": 5000,
                                         "schema": {"type": "object"}, "selector": "#s"}),
           "expect schema payload mismatch")

    # 8. tab_control ops.
    for op, act in [("activate", "activateTab"), ("close", "closeTab"), ("reload", "reload"), ("back", "goBack"), ("forward", "goForward")]:
        server.browser_tab_control(op, tab_id=11)
        expect(last_request() == (act, {"tabId": 11}), f"tab_control {op} should call {act}")

    # 9. browser_action passthrough.
    server.browser_action("performanceMetrics", {"tabId": 11})
    expect(last_request() == ("performanceMetrics", {"tabId": 11}), "browser_action passthrough mismatch")

    # 9a. typed batch keeps every primitive on one explicit tab.
    batch_steps = [
        {"action": "fill", "payload": {"selector": "ref=e8", "text": "Draft"}},
        {
            "action": "waitForText",
            "payload": {"text": "Saved"},
            "timeoutMs": 5000,
        },
    ]
    server.browser_batch(11, batch_steps)
    expect(last_request() == ("batch", {
        "tabId": 11,
        "steps": batch_steps,
        "stopOnError": True,
    }), "browser_batch payload mismatch")
    read_batch_steps = [
        {"action": "expect", "payload": {"mode": "selector", "selector": "#saved"}},
        {"action": "observe", "payload": {"compact": True}},
        {"action": "extractStructured", "payload": {"schema": {"type": "object"}}},
    ]
    server.browser_batch(11, read_batch_steps)
    expect(last_request() == ("batch", {
        "tabId": 11,
        "steps": read_batch_steps,
        "stopOnError": True,
    }), "browser_batch should accept typed observation steps")
    server.browser_batch(11, [
        {"action": "extractText", "payload": {"maxChars": 999999}},
    ])
    expect(last_request() == ("batch", {
        "tabId": 11,
        "steps": [{"action": "extractText", "payload": {"maxChars": 20000}}],
        "stopOnError": True,
    }), "browser_batch should clamp extractText output per step")
    for unsafe_steps, message in [
        ([{"action": "executeScript", "payload": {"code": "1"}}], "sensitive action"),
        ([{"action": "click", "payload": {"tabId": 12, "selector": "#save"}}], "cross-tab action"),
        ([{"action": "observe", "payload": {"diff": True}}], "snapshot-diff state mutation"),
    ]:
        try:
            server.browser_batch(11, unsafe_steps)
            expect(False, f"browser_batch accepted {message}")
        except ValueError:
            pass

    # 9a. browser_confirm_action forwards the same action with top-level confirmation token.
    server.browser_confirm_action("executeScript", "confirm-token", {"tabId": 11, "code": "1"})
    expect(last_request() == ("executeScript", {"tabId": 11, "code": "1"}), "browser_confirm_action payload mismatch")
    expect(last_raw_request().get("confirmationToken") == "confirm-token", "browser_confirm_action confirmation token mismatch")

    server.browser_confirm("confirm-token")
    expect(last_request() == ("confirm", {"confirmationToken": "confirm-token"}), "browser_confirm token-only payload mismatch")

    # 9b. browser_policy_check forwards policyCheck with action/payload, no tab resolve.
    with received_lock:
        received.clear()
    server.browser_policy_check("getCookies", {"domain": "x.test"})
    expect(last_request() == ("policyCheck", {"action": "getCookies", "payload": {"domain": "x.test"}}),
           "policy_check payload mismatch")
    with received_lock:
        expect([a for a, _ in received] == ["policyCheck"],
               "policy_check must not resolve a tab")

    # 10. screenshot returns inline image content from the data URL.
    shot = server.browser_screenshot(tab_id=11)
    expect(getattr(shot, "type", None) == "image" and shot.data == "QUJD" and shot.mimeType == "image/png",
           "screenshot should return ImageContent decoded from dataUrl")

    # 11. invalid wait mode raises before any call.
    try:
        server.browser_wait_for("bogus", tab_id=11)
        expect(False, "invalid wait_for mode should raise")
    except BridgeError:
        pass
    # --- P2 cases ---

    # 13. New named tools emit correct payloads.
    server.browser_hover("#h", tab_id=11)
    expect(last_request() == ("hover", {"tabId": 11, "selector": "#h"}), "hover payload mismatch")
    server.browser_scroll(5, 10, tab_id=11)
    expect(last_request() == ("scroll", {"tabId": 11, "deltaX": 5, "deltaY": 10, "selector": None}), "scroll payload mismatch")
    server.browser_scroll(1, 2, tab_id=11, selector="#p")
    expect(last_request() == ("scroll", {"tabId": 11, "deltaX": 1, "deltaY": 2, "selector": "#p"}), "scroll selector payload mismatch")
    server.browser_press("Enter", tab_id=11)
    expect(last_request() == ("press", {"tabId": 11, "key": "Enter"}), "press payload mismatch")
    server.browser_drag("#a", "#b", tab_id=11)
    expect(last_request() == ("drag", {"tabId": 11, "fromSelector": "#a", "toSelector": "#b"}), "drag payload mismatch")
    server.browser_select("#s", "v", tab_id=11)
    expect(last_request() == ("select", {"tabId": 11, "selector": "#s", "value": "v"}), "select payload mismatch")
    server.browser_get_cookies("x.test")
    expect(last_request() == ("getCookies", {"domain": "x.test"}), "get_cookies payload mismatch")

    # 14. get_html truncates to max_chars with a marker.
    out = server.browser_get_html(tab_id=11, max_chars=10)
    expect(out.startswith("H" * 10) and "truncated 40 chars" in out, f"get_html truncation wrong: {out!r}")

    # 15. upload_file validates paths before any bridge call.
    with received_lock:
        received.clear()
    try:
        server.browser_upload_file("#f", ["/no/such/file-xyz.txt"])
        expect(False, "upload_file should raise on missing file")
    except BridgeError as exc:
        expect("Upload file not found" in str(exc), "upload_file error message wrong")
    with received_lock:
        expect(received == [], "upload_file must not contact the bridge on missing file")
    # Valid file -> expanded absolute path forwarded.
    fd, real = tempfile.mkstemp()
    os.close(fd)
    server.browser_upload_file("#f", [real], tab_id=11)
    act, payload = last_request()
    expect(act == "uploadFile" and payload["files"] == [os.path.abspath(real)], "upload_file should forward abs path")
    os.unlink(real)

    # First-class GitHub PR-body helper validates and forwards local files.
    fd, real = tempfile.mkstemp()
    os.close(fd)
    server.browser_github_attach_pr_body([real], tab_id=11, timeout_ms=15000)
    expect(last_request() == ("githubAttachPrBody", {
        "tabId": 11, "files": [os.path.abspath(real)], "timeoutMs": 15000,
    }), "github PR-body attachment payload mismatch")
    os.unlink(real)

    # 16. Gating: default build hides sensitive tools (cookies + action escape hatch).
    default_names = _tool_names(server.build_server())
    expect("browser_get_cookies" not in default_names, "cookies must be hidden by default")
    expect("browser_action" not in default_names, "browser_action must be hidden by default (sensitive)")
    expect("browser_click" in default_names, "mutating non-sensitive tool should be present by default")
    expect("browser_batch" in default_names, "typed batch should be present by default")
    expect("browser_policy_check" in default_names, "policy_check must be present by default (read-only, non-sensitive)")
    expect("browser_confirm_action" in default_names, "confirm_action must be present by default (mutating, non-sensitive)")
    expect("browser_confirm" in default_names, "token-only confirm must be present by default")
    expect("browser_github_attach_pr_body" in default_names, "GitHub PR-body helper must be present by default")
    expect("browser_ready" in default_names, "readiness tool must be present by default")
    expect("browser_navigate_and_snapshot" in default_names,
           "navigate-and-snapshot tool must be present by default")
    expect("browser_insert_rich_text" in default_names,
           "rich-text insertion tool must be present by default")

    # 17. allow_sensitive exposes sensitive tools.
    sens_names = _tool_names(server.build_server(allow_sensitive=True))
    expect("browser_get_cookies" in sens_names and "browser_action" in sens_names, "allow_sensitive should expose sensitive tools")

    # 18. readonly hides ALL mutating tools (including the escape hatch).
    ro_names = _tool_names(server.build_server(readonly=True, allow_sensitive=True))
    expect("browser_click" not in ro_names and "browser_navigate" not in ro_names, "readonly must hide mutating tools")
    expect("browser_action" not in ro_names, "readonly must hide browser_action (mutating)")
    expect("browser_batch" not in ro_names, "readonly must hide typed batch")
    expect("browser_confirm_action" not in ro_names, "readonly must hide browser_confirm_action (mutating)")
    expect("browser_confirm" not in ro_names, "readonly must hide token-only confirm (mutating)")
    expect("browser_snapshot" in ro_names and "browser_list_tabs" in ro_names, "readonly must keep read-only tools")
    expect("browser_policy_check" in ro_names, "readonly must keep policy_check (read-only)")
    expect("browser_ready" in ro_names, "readonly must keep readiness")
    expect("browser_navigate_and_snapshot" not in ro_names,
           "readonly must hide navigate-and-snapshot")
    expect("browser_insert_rich_text" not in ro_names,
           "readonly must hide rich-text insertion")

    # 19. Annotations + resources are registered.
    srv = server.build_server(allow_sensitive=True)
    tools = {t.name: t for t in srv._tool_manager.list_tools()}
    expect(tools["browser_click"].annotations.destructiveHint is True, "mutating tool should be destructiveHint=True")
    expect(tools["browser_batch"].annotations.destructiveHint is True, "typed batch should be destructiveHint=True")
    expect(tools["browser_confirm_action"].annotations.destructiveHint is True, "confirm_action should be destructiveHint=True")
    expect(tools["browser_confirm"].annotations.destructiveHint is True, "token-only confirm should be destructiveHint=True")
    expect(tools["browser_snapshot"].annotations.readOnlyHint is True, "read-only tool should be readOnlyHint=True")
    res_uris = _resource_uris(srv)
    expect("browser://tabs" in res_uris, "browser://tabs resource missing")
    expect(any(u.startswith("browser://tab/") for u in res_uris), "tab state resource template missing")

    # 19b. Lease tools emit the host-side lease verbs.
    server.browser_lease(ttl_ms=5000)
    expect(last_request() == ("lease", {"ttlMs": 5000}), "browser_lease payload mismatch")
    server.browser_release()
    expect(last_request() == ("release", {}), "browser_release payload mismatch")
    server.browser_lease_status()
    expect(last_request() == ("leaseStatus", {}), "browser_lease_status payload mismatch")
    # lease verbs never resolve a tab (no getTabs).
    with received_lock:
        recent = [a for a, _ in received[-3:]]
    expect("getTabs" not in recent, "lease tools must not resolve a tab")

    # 19c. session_status -> sessionStatus with domains list.
    server.browser_session_status(["a.test", "b.test"])
    expect(last_request() == ("sessionStatus", {"domains": ["a.test", "b.test"]}),
           "session_status payload mismatch")

    # 19d. wait_for_handoff -> waitForHandoff with until payload, and the call
    #      must pass read_timeout_ms=timeout_ms so the wire outlasts the human.
    captured_kwargs = {}
    real_call = server.call

    def _capture_call(action, payload=None, read_timeout_ms=None):
        captured_kwargs["read_timeout_ms"] = read_timeout_ms
        return real_call(action, payload, read_timeout_ms=read_timeout_ms)

    server.call = _capture_call
    try:
        server.browser_wait_for_handoff(
            "log in please", mode="selector", selector="#done",
            timeout_ms=30000, tab_id=11,
        )
    finally:
        server.call = real_call
    expect(last_request() == ("waitForHandoff", {
        "message": "log in please",
        "until": {"mode": "selector", "selector": "#done"},
        "timeoutMs": 30000,
        "tabId": 11,
    }), "wait_for_handoff payload mismatch")
    expect(captured_kwargs.get("read_timeout_ms") == 30000,
           "wait_for_handoff must pass read_timeout_ms=timeout_ms to call()")

    # 19e. session_status is sensitive: hidden by default, present with allow_sensitive.
    expect("browser_session_status" not in _tool_names(server.build_server()),
           "session_status must be hidden by default (sensitive)")
    expect("browser_session_status" in _tool_names(server.build_server(allow_sensitive=True)),
           "session_status should be exposed under allow_sensitive")

    # 19f. wait_for_handoff is mutating non-sensitive: present in a normal build,
    #      hidden under readonly.
    expect("browser_wait_for_handoff" in _tool_names(server.build_server()),
           "wait_for_handoff should be present in a normal build")
    expect("browser_wait_for_handoff" not in _tool_names(server.build_server(readonly=True)),
           "wait_for_handoff must be hidden under readonly")

    # 19f-2. expect is a read-only assertion, so it survives a readonly build and
    #        carries the read-only annotation.
    expect("browser_expect" in _tool_names(server.build_server(readonly=True)),
           "expect is read-only and must survive a readonly build")
    expect(tools["browser_expect"].annotations.readOnlyHint is True,
           "expect should be annotated readOnlyHint=True")
    expect(tools["browser_expect"].annotations.destructiveHint is False,
           "expect must not be annotated destructive")

    # 19g. search_tabs is sensitive: its snippets carry content from every open
    #      tab of the real profile, so it is gated like history and bookmarks.
    expect("browser_search_tabs" not in _tool_names(server.build_server()),
           "search_tabs must be hidden by default (sensitive)")
    expect("browser_search_tabs" in _tool_names(server.build_server(allow_sensitive=True)),
           "search_tabs should be exposed under allow_sensitive")
    expect("browser_search_history" not in _tool_names(server.build_server()),
           "search_history must be hidden by default (sensitive)")
    os.environ["BRIDGE_MCP_ALLOW_SENSITIVE"] = "1"
    try:
        env_names = _tool_names(server.build_server())
        expect("browser_search_tabs" in env_names,
               "search_tabs should be exposed with BRIDGE_MCP_ALLOW_SENSITIVE=1")
        expect("browser_search_history" in env_names and "browser_search_bookmarks" in env_names,
               "history/bookmarks should be exposed with BRIDGE_MCP_ALLOW_SENSITIVE=1")
    finally:
        os.environ.pop("BRIDGE_MCP_ALLOW_SENSITIVE", None)

    # 19h. screencast_save and cache_selectors are NOT read-only: one consumes
    #      the extension frame buffer and writes/replaces local files, the other
    #      supports clear/import.
    for name in ("browser_screencast_save", "browser_cache_selectors"):
        expect(name in default_names, f"{name} should be present in a normal build")
        expect(name not in ro_names, f"{name} must be hidden under readonly (mutating)")
        expect(tools[name].annotations.readOnlyHint is False,
               f"{name} must not be annotated readOnlyHint=True")
        expect(tools[name].annotations.destructiveHint is True,
               f"{name} must be annotated destructiveHint=True")

    # 19i. screencast_save validates/prepares the destination BEFORE draining and
    #      a second, shorter save never keeps the previous save's frames.
    drains = []
    frame_counts = [3, 1]

    def screencast_result(action, payload):
        if action == "screencastFrames":
            drains.append(payload)
            count = frame_counts.pop(0) if frame_counts else 0
            return {
                "success": True, "format": "jpeg", "droppedFrames": 0,
                "frames": [{"base64": "QUJD", "timestamp": index} for index in range(count)],
            }
        return default_result(action, payload)

    _result_fn = screencast_result
    shots = tempfile.mkdtemp()
    try:
        first = json.loads(server.browser_screencast_save(shots, tab_id=11))
        expect(first["frames"] == 3 and first["staleArtifactsRemoved"] == 0,
               f"first screencast save should write 3 frames into a clean dir: {first}")
        expect(sorted(os.listdir(shots)) == [
            "frame-00000.jpg", "frame-00001.jpg", "frame-00002.jpg", "frames.json",
        ], f"first save layout wrong: {sorted(os.listdir(shots))}")
        second = json.loads(server.browser_screencast_save(shots, tab_id=11))
        expect(second["frames"] == 1 and second["staleArtifactsRemoved"] == 4,
               f"second save should clear 4 stale artifacts and write 1 frame: {second}")
        expect(sorted(os.listdir(shots)) == ["frame-00000.jpg", "frames.json"],
               f"second shorter save must not keep stale frames: {sorted(os.listdir(shots))}")
        with open(os.path.join(shots, "frames.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        expect(manifest["count"] == 1 and len(manifest["timestamps"]) == 1,
               f"manifest must describe only this save's frames: {manifest}")
        # An unusable destination must fail while the frames are still buffered.
        fd, blocker = tempfile.mkstemp()
        os.close(fd)
        drained_before = len(drains)
        try:
            server.browser_screencast_save(blocker, tab_id=11)
            expect(False, "screencast_save into a non-directory should raise")
        except BridgeError as exc:
            expect("not a directory" in str(exc),
                   f"non-directory destination error should be actionable: {exc}")
        expect(len(drains) == drained_before,
               "a destination that cannot be prepared must not consume the frame buffer")
        os.unlink(blocker)
    finally:
        shutil.rmtree(shots, ignore_errors=True)
        _result_fn = default_result

    # Normal traffic reuses one connection. Asserted BEFORE the unauthorized
    # case below, because an `unauthorized` reply deliberately discards the
    # cached socket (both native hosts hang up after that reply), so measuring
    # reuse across it would be measuring the reconnect, not connection reuse.
    expect(accepted_connections == 1, "MCP calls should reuse one serialized TCP connection")

    # 20. unauthorized maps to an actionable message.
    def unauth(action, payload):
        raise _Unauthorized()
    _result_fn = unauth
    try:
        server.browser_list_tabs()
        expect(False, "unauthorized should raise")
    except BridgeError as exc:
        expect("token mismatch" in str(exc), f"unauthorized should be actionable: {exc}")

    # 12. bridge failure result maps to BridgeError (swap behavior, same server).
    def failing(action, payload):
        raise RuntimeError("boom")

    _result_fn = failing
    try:
        server.browser_click("#x", tab_id=11)
        expect(False, "bridge failure should raise BridgeError")
    except BridgeError as exc:
        expect("boom" in str(exc), "BridgeError should carry the bridge error message")
    # Exactly one reconnect, caused by the unauthorized reply discarding the
    # socket. This mock keeps its connection open, unlike the real hosts, so the
    # reconnect is driven purely by the transport invalidating its own cache.
    expect(accepted_connections == 2,
           f"unauthorized should force exactly one reconnect, saw {accepted_connections}")
    transport._connection.close()
    stop_event.set()
    t.join(timeout=5)

    # 21. Call dispatch never retries an ambiguous transport result. Connection
    # setup retries live inside PersistentBridgeConnection before send.
    saved_connection = transport._connection
    wire_calls = []

    class FakeConnection:
        def __init__(self, result):
            self.result = result

        def request(self, *args, **kwargs):
            wire_calls.append((args, kwargs))
            return self.result

    transport._connection = FakeConnection((124, None, "timed out"))
    try:
        try:
            transport.call("click", {"tabId": 1, "selector": "#save"})
            expect(False, "ambiguous timeout should raise without replay")
        except BridgeError:
            pass
        expect(len(wire_calls) == 1, "ambiguous MCP failure must not replay a mutating action")
    finally:
        transport._connection = saved_connection

    # 22. A packaged-style import with only mcp/ on PYTHONPATH must still load
    # repo sibling helpers. This reproduces the former MCP startup crash.
    startup_env = os.environ.copy()
    startup_env["PYTHONPATH"] = os.path.join(SCRIPT_DIR, "mcp")
    startup_env["BRIDGE_REPO_ROOT"] = SCRIPT_DIR
    startup = subprocess.run(
        [sys.executable, "-c", "import chrome_bridge_mcp.transport; print('startup-ok')"],
        cwd="/tmp",
        env=startup_env,
        text=True,
        capture_output=True,
    )
    expect(startup.returncode == 0 and "startup-ok" in startup.stdout,
           f"packaged MCP startup import failed: {startup.stderr.strip()}")

    # 23. HTTP per-request bridge tokens (docs/mcp.md "Per-request bridge
    # tokens"). ``transport.call(token=...)`` must put the override on the wire
    # in place of the ambient identity, and must restore the ambient token
    # afterwards so the stdio path is unaffected.
    recorder_port = PORT + 1
    recorded_tokens = []
    recorder_stop = threading.Event()

    def record_tokens():
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", recorder_port))
        srv.listen(4)
        srv.settimeout(0.5)
        while not recorder_stop.is_set():
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                buf = b""
                while not recorder_stop.is_set():
                    while b"\n" not in buf:
                        chunk = conn.recv(65536)
                        if not chunk:
                            break
                        buf += chunk
                    if b"\n" not in buf:
                        break
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    req = json.loads(line.decode("utf-8"))
                    recorded_tokens.append(req.get("token"))
                    conn.sendall((json.dumps({"success": True, "result": "pong"}) + "\n").encode())
        srv.close()

    recorder = threading.Thread(target=record_tokens, daemon=True)
    recorder.start()
    time.sleep(0.2)
    saved_port = os.environ["BRIDGE_PORT"]
    os.environ["BRIDGE_PORT"] = str(recorder_port)
    try:
        transport.call("ping", token="per-request-token")
        expect(recorded_tokens[-1] == "per-request-token",
               "token override should replace the ambient token in the outbound request")
        transport.call("ping")
        expect(recorded_tokens[-1] == "mcp-token",
               "omitting the token override should restore the ambient bridge token")
    finally:
        transport._connection.close()
        os.environ["BRIDGE_PORT"] = saved_port
        recorder_stop.set()
        recorder.join(timeout=5)

    # 24. Header extraction feeding that override: Bearer wins, X-Bridge-Token
    # is the fallback, and no HTTP request (the stdio path) means no override.
    from mcp.server.lowlevel.server import request_ctx  # noqa: E402

    class _Headers(dict):
        # Mimic Starlette's case-insensitive Headers mapping.
        def get(self, key, default=None):
            return dict.get(self, key.lower(), default)

    class _FakeRequest:
        def __init__(self, headers):
            self.headers = _Headers(headers)

    class _FakeRequestContext:
        def __init__(self, request):
            self.request = request

    header_cases = [
        ({"authorization": "Bearer bearer-tok", "x-bridge-token": "hdr-tok"}, "bearer-tok",
         "Authorization: Bearer should win over X-Bridge-Token"),
        ({"x-bridge-token": "hdr-tok"}, "hdr-tok",
         "X-Bridge-Token should be used when Authorization is absent"),
        ({"authorization": "Basic abc"}, None,
         "a non-Bearer Authorization scheme should not be treated as a bridge token"),
        ({}, None, "no token header should fall back to the ambient identity"),
    ]
    for headers, expected, msg in header_cases:
        ctx_token = request_ctx.set(_FakeRequestContext(_FakeRequest(headers)))
        try:
            expect(server._http_request_token() == expected, msg)
        finally:
            request_ctx.reset(ctx_token)

    ctx_token = request_ctx.set(_FakeRequestContext(None))
    try:
        expect(server._http_request_token() is None,
               "stdio requests carry no HTTP request and must use the ambient token")
    finally:
        request_ctx.reset(ctx_token)

    # 25. An ``unauthorized`` reply must invalidate the cached socket. Both
    # native hosts close the TCP connection right after that reply, so a
    # transport that kept it marked reusable would write the next legitimate
    # request into a dead connection and fail with an ambiguous-delivery error.
    reject_port = PORT + 2
    reject_conns = []
    reject_stop = threading.Event()
    # Bind before starting the thread so the listener is provably ready and no
    # assertion depends on a startup sleep.
    reject_srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    reject_srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    reject_srv.bind(("127.0.0.1", reject_port))
    reject_srv.listen(4)
    reject_srv.settimeout(0.5)

    def serve_unauthorized_then_ok():
        while not reject_stop.is_set():
            try:
                conn, _ = reject_srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            reject_conns.append(1)
            first = len(reject_conns) == 1
            with conn:
                buf = b""
                while not reject_stop.is_set() and b"\n" not in buf:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                if b"\n" not in buf:
                    continue
                if first:
                    # Mirror the hosts: reply unauthorized, then hang up.
                    conn.sendall((json.dumps({"success": False, "error": "unauthorized"}) + "\n").encode())
                    continue
                conn.sendall((json.dumps({"success": True, "result": "pong"}) + "\n").encode())
        reject_srv.close()

    rejecter = threading.Thread(target=serve_unauthorized_then_ok, daemon=True)
    rejecter.start()
    saved_port = os.environ["BRIDGE_PORT"]
    os.environ["BRIDGE_PORT"] = str(reject_port)
    transport._connection.close()
    try:
        try:
            transport.call("ping", token="bad-token")
            expect(False, "an unauthorized reply should raise BridgeError")
        except transport.BridgeError as exc:
            expect("unauthorized" in str(exc), f"unexpected unauthorized error text: {exc}")
        expect(transport._connection._socket is None,
               "an unauthorized reply must discard the cached persistent socket")
        expect(transport.call("ping") == "pong",
               "the request after an unauthorized reply must succeed on a fresh connection")
        expect(len(reject_conns) == 2,
               f"transport should have opened a second connection, saw {len(reject_conns)}")
    finally:
        transport._connection.close()
        os.environ["BRIDGE_PORT"] = saved_port
        reject_stop.set()
        rejecter.join(timeout=5)

    if failures:
        print(f"\n{len(failures)} contract failure(s).")
        sys.exit(1)
    print("MCP contract OK")


if __name__ == "__main__":
    main()
