#!/usr/bin/env python3
import argparse
import base64
import os
import sys
import json
import time
import http.server
import threading
import subprocess
import contextlib
import shutil
from pathlib import Path

# Paths & Settings
HOST = "127.0.0.1"
PORT = 0  # Dynamic port binding
BASE_URL = ""
SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
CLIENT = os.path.join(SCRIPT_DIR, "test_client.py")
BRIDGE_COMMAND = os.environ.get("CHROME_BRIDGE_CLIENT")
QUIET_MODE = False


UPLOAD_FIXTURE = "/tmp/chrome-bridge-live-upload.txt"
SHOT_PATH = "/tmp/chrome-bridge-live.png"
PDF_PATH = "/tmp/chrome-bridge-live.pdf"
HTML_PATH = "/tmp/chrome-bridge-live.html"
STATE_PATH = "/tmp/chrome-bridge-state.json"
SCREENCAST_DIR = "/tmp/chrome-bridge-screencast"
DOWNLOAD_NAME = "chrome-bridge-smoke-download.json"
LAST_SUMMARY = {}
PAGE = b"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Chrome Bridge Live Test</title>
  <style>
    body { font-family: system-ui, sans-serif; min-height: 1600px; }
    #from, #to { width: 80px; height: 40px; margin: 20px; padding: 8px; border: 1px solid #333; }
    #to { margin-top: 300px; }
    #panel { height: 120px; overflow: auto; border: 1px solid #999; }
    #spacer { height: 600px; }
  </style>
</head>
<body>
  <h1>Chrome Bridge Live Test</h1>
  <label for="q">Search query</label>
  <input id="q" name="q" value="">
  <button id="btn">Click me</button>
  <button id="log">Log</button>
  <button id="fetch">Fetch</button>
  <button id="alert">Alert</button>
  <button id="mapped">Mapped error</button>
  <button id="mapped-cross">Cross map</button>
  <select id="kind" name="kind"><option value="alpha">Alpha</option><option value="beta">Beta</option></select>
  <input id="file" type="file">
  <div id="status">ready</div>
  <div id="from" draggable="true">from</div>
  <div id="to">to</div>
  <div id="panel"><div id="spacer">scroll panel</div></div>
  <div id="shadow-host"></div>
  <iframe id="frame" srcdoc="&lt;input id=&quot;frame-input&quot; aria-label=&quot;Frame input&quot;&gt;&lt;button id=&quot;frame-button&quot;&gt;Frame click&lt;/button&gt;&lt;select id=&quot;frame-select&quot;&gt;&lt;option value=&quot;one&quot;&gt;One&lt;/option&gt;&lt;option value=&quot;two&quot;&gt;Two&lt;/option&gt;&lt;/select&gt;&lt;input id=&quot;frame-file&quot; type=&quot;file&quot;&gt;&lt;script&gt;document.getElementById(&quot;frame-input&quot;).addEventListener(&quot;input&quot;, function () { parent.postMessage({type: &quot;frame-value&quot;, value: this.value}, &quot;*&quot;); }); document.getElementById(&quot;frame-button&quot;).addEventListener(&quot;click&quot;, function () { parent.postMessage({type: &quot;frame-click&quot;}, &quot;*&quot;); }); document.getElementById(&quot;frame-select&quot;).addEventListener(&quot;change&quot;, function () { parent.postMessage({type: &quot;frame-select&quot;, value: this.value}, &quot;*&quot;); }); document.getElementById(&quot;frame-file&quot;).addEventListener(&quot;change&quot;, function () { parent.postMessage({type: &quot;frame-file&quot;, count: this.files.length}, &quot;*&quot;); });&lt;/script&gt;"></iframe>
  <script>
    window.__shadowClicks = 0;
    window.__frameValue = '';
    window.__frameClicks = 0;
    window.__frameSelect = '';
    window.__frameFileCount = 0;
    window.__dragDropped = false;
    const shadowRoot = document.querySelector('#shadow-host').attachShadow({mode: 'open'});
    shadowRoot.innerHTML = '<button id="shadow-btn">Shadow click</button><label>Shadow input<input id="shadow-input"></label><select id="shadow-kind"><option value="alpha">Alpha</option><option value="beta">Beta</option></select>';
    shadowRoot.querySelector('#shadow-btn').addEventListener('click', () => { window.__shadowClicks += 1; });
    window.addEventListener('message', event => { if (event.data && event.data.type === 'frame-value') window.__frameValue = event.data.value; if (event.data && event.data.type === 'frame-click') window.__frameClicks += 1; if (event.data && event.data.type === 'frame-select') window.__frameSelect = event.data.value; if (event.data && event.data.type === 'frame-file') window.__frameFileCount = event.data.count; });
    document.querySelector('#btn').addEventListener('click', () => {
      document.querySelector('#status').textContent = 'clicked:' + document.querySelector('#q').value;
    });
    document.querySelector('#log').addEventListener('click', () => console.log('bridge fixture console message'));
    document.querySelector('#fetch').addEventListener('click', () => fetch('/data.json?secret=redact-me').then(r => r.json()).then(d => console.log('fetch', d.ok)));
    document.querySelector('#alert').addEventListener('click', () => alert('hello dialog'));
    document.querySelector('#to').addEventListener('dragover', event => event.preventDefault());
    document.querySelector('#to').addEventListener('drop', event => { event.preventDefault(); window.__dragDropped = true; document.querySelector('#status').textContent = 'dropped'; });
  </script>
  <script src="/mapped.js"></script>
  <script src="/crossmap.js"></script>
</body>
</html>"""

DATA = b'{"ok": true}'

# HI7 fixture: a "minified" script with an INLINE source map. `console.error`
# starts at generated line 0, column 16 (after `function boom(){`), and the map
# has a single segment there pointing at src/fixture-original.js line 3,
# column 2 (0-based), name `boom`. VLQ "gBAGEA" == [16, 0, 3, 2, 0].
MAPPED_SOURCE = "src/fixture-original.js"
MAPPED_ORIGINAL_LINE = 3
MAPPED_SOURCE_MAP = json.dumps({
    "version": 3,
    "file": "mapped.js",
    "sources": [MAPPED_SOURCE],
    "names": ["boom"],
    "mappings": "gBAGEA;",
}).encode("utf-8")
MAPPED_SCRIPT = (
    'function boom(){console.error("bridge fixture mapped error")}\n'
    'document.querySelector("#mapped").addEventListener("click",boom);\n'
    "//# sourceMappingURL=data:application/json;base64,"
    + base64.b64encode(MAPPED_SOURCE_MAP).decode("ascii")
    + "\n"
).encode("utf-8")

# Same shape, but the map lives on a third-party origin: resolution must refuse
# it outright rather than fetch it.
CROSS_MAPPED_SCRIPT = (
    'function crossBoom(){console.error("bridge fixture cross-origin map")}\n'
    'document.querySelector("#mapped-cross").addEventListener("click",crossBoom);\n'
    "//# sourceMappingURL=https://example.invalid/crossmap.js.map\n"
).encode("utf-8")

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/data.json"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(DATA)
            return
        if self.path.startswith("/mapped.js") or self.path.startswith("/crossmap.js"):
            body = MAPPED_SCRIPT if self.path.startswith("/mapped.js") else CROSS_MAPPED_SCRIPT
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, _format, *_args):
        return

class ReusableThreadingHTTPServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True

def start_server():
    global BASE_URL
    server = ReusableThreadingHTTPServer((HOST, PORT), Handler)
    derived_port = server.server_address[1]
    BASE_URL = f"http://{HOST}:{derived_port}/"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server

def bridge_command():
    token_file = os.environ.get("BRIDGE_TOKEN_FILE", os.path.join(SCRIPT_DIR, "bridge_token.txt"))
    if not BRIDGE_COMMAND and not os.path.exists(token_file):
        raise RuntimeError(
            "Missing bridge token. Run ./setup.sh <extension-id> first, set BRIDGE_TOKEN_FILE, "
            "or set CHROME_BRIDGE_CLIENT=chrome-bridge to use an installed launcher."
        )
    return [BRIDGE_COMMAND] if BRIDGE_COMMAND else [sys.executable, CLIENT]
def resolve_policy_path():
    p_host = None
    resolved_from_host = False
    try:
        proc = subprocess.run([*bridge_command(), "policy", "info"], text=True, capture_output=True, timeout=5)
        if proc.returncode == 0:
            data = json.loads(proc.stdout)
            p_file = (data.get("result") or {}).get("policyFile")
            if p_file:
                p_host = Path(p_file)
                resolved_from_host = True
    except Exception as e:
        sys.stderr.write(f"RESOLVER WARNING: failed to query host policy path: {e}\n")

    p_env = os.environ.get("BRIDGE_POLICY_FILE")
    if p_env:
        p_env_path = Path(p_env)
        if p_host and p_host.resolve() != p_env_path.resolve():
            raise AssertionError(
                f"Mismatch between environment BRIDGE_POLICY_FILE ({p_env_path}) "
                f"and active host policy file ({p_host})"
            )
        return p_env_path, resolved_from_host

    if p_host:
        sys.stderr.write(f"RESOLVED ACTIVE POLICY FILE PATH FROM HOST: {p_host}\n")
        return p_host, True

    return Path(os.path.join(SCRIPT_DIR, "bridge_policy.json")), False



def restore_policy(backup, policy_path, backup_mode=None):
    if backup is None:
        with contextlib.suppress(FileNotFoundError):
            policy_path.unlink()
    else:
        policy_path.write_bytes(backup)
        if backup_mode is not None:
            try:
                os.chmod(policy_path, backup_mode)
            except OSError:
                pass


def run_bridge(*args, timeout=20):
    if args and args[0] in {"waitForLoad", "waitForSelector"} and isinstance(args[-1], int) and args[-1] > 1000:
        timeout = max(timeout, int(args[-1] / 1000) + 15)
    proc = subprocess.run([*bridge_command(), *map(str, args)], text=True, capture_output=True, timeout=timeout)
    parsed = None
    if proc.stdout:
        try:
            parsed = json.loads(proc.stdout)
        except Exception:
            pass
    return {
        "exit": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "json": parsed
    }

def result(call):
    data = call.get("json") or {}
    item = data.get("result")
    if item is not None:
        return item
    return data

def record(summary, name, call, extra=None):
    global LAST_SUMMARY
    entry = {"exit": call["exit"]}
    if extra:
        entry.update(extra)
    summary[name] = entry
    LAST_SUMMARY = summary
    return call

def require(condition, message, call=None):
    if not condition:
        err = f"\nSTDERR: {call.get('stderr')}" if isinstance(call, dict) and call.get("stderr") else ""
        out = f"\nSTDOUT: {call.get('stdout')}" if isinstance(call, dict) and call.get("stdout") else ""
        raise AssertionError(f"{message}{err}{out}")


def target_origin_unresolved(call):
    data = call.get("json") or {}
    denial = data.get("policyDenial") if isinstance(data, dict) else None
    return isinstance(denial, dict) and denial.get("kind") == "target"


def wait_for_tab_origin(tab_id, timeout=5):
    deadline = time.monotonic() + timeout
    last_call = None
    while time.monotonic() <= deadline:
        last_call = run_bridge("getCurrentState", tab_id, timeout=5)
        if last_call["exit"] == 0:
            return
        if not target_origin_unresolved(last_call):
            require(False, "tab origin resolution failed", last_call)
        time.sleep(0.2)
    require(False, "tab origin stayed unresolved after navigate", last_call)

def main(quiet=False):
    global QUIET_MODE
    QUIET_MODE = quiet
    Path(UPLOAD_FIXTURE).write_text("upload fixture\n", encoding="utf-8")
    for path in [SHOT_PATH, PDF_PATH, HTML_PATH, STATE_PATH]:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(path)
    # A stale frame directory would make the frame-count assertions meaningless.
    with contextlib.suppress(Exception):
        shutil.rmtree(SCREENCAST_DIR)
    policy_backup = None
    backup_mode = None
    policy_path = None
    policy_installed = False
    server = None
    tab_id = None
    monitoring_started = False
    interception_started = False
    screencast_started = False
    try:
        p_path, resolved_from_host = resolve_policy_path()
        require(resolved_from_host or "BRIDGE_POLICY_FILE" in os.environ, "Expected policy path to be resolved from host via 'policy info'")
        policy_path = p_path
        if policy_path.exists():
            policy_backup = policy_path.read_bytes()
            try:
                backup_mode = os.stat(policy_path).st_mode & 0o777
            except OSError:
                pass
        policy = {
            "default": {
                "allowedActions": [
                    "ping", "navigate", "waitForLoad", "waitForSelector", "click", "fill",
                    "select", "uploadFile", "screenshot", "extractText", "getHTML", "type", "drag",
                    "scroll", "press", "hover", "startMonitoring", "consoleMessages",
                    "setViewport", "setUserAgent", "setNetworkConditions", "clearNetworkConditions",
                    "setCpuThrottling", "setColorScheme", "networkRequests", "executeScriptCDP",
                    "handleDialog", "stopMonitoring", "getCurrentState", "startInterception",
                    "interceptedRequests", "stopInterception", "downloadUrl", "storageState",
                    "setGeolocation", "clearGeolocation", "performanceMetrics", "closeTab",
                    "printToPDF", "clickAt", "windowControl", "batch", "waitForText",
                    "setCookie", "deleteCookie", "setStorageItem", "removeStorageItem",
                    "clearStorage", "searchHistory", "searchBookmarks", "searchTabs",
                    "startScreencast", "screencastFrames", "stopScreencast"
                ],
                "allowedOrigins": ["*"],
                "deniedActions": [],
                "deniedOrigins": [],
                "requireConfirmation": [],
                "redact": True,
                "audit": False,
            }
        }
        policy_path.write_text(json.dumps(policy, separators=(",", ":")), encoding="utf-8")
        policy_installed = True
        try:
            os.chmod(policy_path, 0o600)
        except OSError:
            pass
        time.sleep(1.1)  # let policy file mtime advance for host hot-reload
        server = start_server()
        summary = {}
        # 1. Ping
        call = run_bridge("ping")
        record(summary, "ping", call, {"pong": result(call) == "pong"})
        require(call["exit"] == 0 and result(call) == "pong", "ping failed")

        # 2. Navigate
        call = run_bridge("navigate", BASE_URL, "--background") if QUIET_MODE else run_bridge("navigate", BASE_URL)
        nav = result(call) or {}
        tab_id = nav.get("tabId")
        record(summary, "navigate", call, {"tabId": tab_id})
        require(call["exit"] == 0 and tab_id is not None, "navigate did not return tabId")
        wait_for_tab_origin(tab_id)
        if QUIET_MODE:
            state = run_bridge("getCurrentState", tab_id)
            active = ((result(state) or {}).get("tab") or {}).get("active")
            record(summary, "quietNavigateInactive", state, {"active": active})
            require(state["exit"] == 0 and active is False, "quiet navigate created an active tab")

        # 3. Wait For Load
        call = run_bridge("waitForLoad", tab_id, 20000)
        record(summary, "waitForLoad", call)
        require(call["exit"] == 0, "waitForLoad failed", call)

        # 4. Wait For Selector
        call = run_bridge("waitForSelector", tab_id, "#q", 20000)
        record(summary, "waitForSelector", call)
        require(call["exit"] == 0, "waitForSelector failed", call)
        # 5. Fill
        call = run_bridge("fill", tab_id, "#q", "hello")
        record(summary, "fill", call)
        require(call["exit"] == 0, "fill failed")

        # 6. Select
        call = run_bridge("select", tab_id, "#kind", "beta")
        record(summary, "select", call)
        require(call["exit"] == 0, "select failed")

        # 7. Hover
        call = run_bridge("hover", tab_id, "#btn")
        record(summary, "hover", call)
        require(call["exit"] == 0, "hover failed")


        # 9. Upload File
        call = run_bridge("uploadFile", tab_id, "#file", UPLOAD_FIXTURE)
        record(summary, "uploadFile", call)
        require(call["exit"] == 0, "uploadFile failed")

        # 10. Execute Script CDP (verification)
        call = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#q').value")
        val = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_fill", call, {"value": val})
        require(call["exit"] == 0 and val == "hello", "fill did not set value properly")

        call = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#file').files.length")
        file_count = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_upload", call, {"files": file_count})
        require(call["exit"] == 0 and file_count == 1, "uploadFile did not set file input properly")

        # 11. Click
        call = run_bridge("click", tab_id, "#btn")
        record(summary, "click", call)
        require(call["exit"] == 0, "click failed")
        time.sleep(0.2)
        call = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#status').textContent")
        status = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_click", call, {"status": status})
        require(call["exit"] == 0 and status == "clicked:hello", "click did not update status")

        # 12. Drag
        call = run_bridge("drag", tab_id, "#from", "#to")
        dropped = run_bridge("executeScriptCDP", tab_id, "window.__dragDropped")
        drag_ok = (result(dropped) or {}).get("val") is True
        record(summary, "drag", call, {"dropped": drag_ok})
        require(call["exit"] == 0 and drag_ok, "drag failed")

        # 13. Press
        call = run_bridge("press", tab_id, "Enter")
        record(summary, "press", call)
        require(call["exit"] == 0, "press failed")

        # 13b. Scroll
        call = run_bridge("scroll", tab_id, 0, 300)
        record(summary, "scroll", call)
        require(call["exit"] == 0, "scroll failed")

        # 14. Screenshot
        call = run_bridge("screenshot", tab_id, SHOT_PATH, "--quiet") if QUIET_MODE else run_bridge("screenshot", tab_id, SHOT_PATH)
        shot = call.get("json") or {}
        record(summary, "screenshot", call, {
            "bytes": shot.get("bytes"),
            "mimeType": shot.get("mimeType"),
            "path": SHOT_PATH
        })
        require(call["exit"] == 0 and shot.get("bytes", 0) > 1000 and Path(SHOT_PATH).is_file(), "screenshot failed")
        if QUIET_MODE:
            state = run_bridge("getCurrentState", tab_id)
            active = ((result(state) or {}).get("tab") or {}).get("active")
            record(summary, "quietScreenshotInactive", state, {"active": active})
            require(state["exit"] == 0 and active is False, "quiet screenshot activated the tab")

        # 15. Get HTML
        call = run_bridge("getHTML", tab_id, HTML_PATH)
        html = call.get("json") or {}
        record(summary, "getHTML", call, {
            "bytes": html.get("bytes"),
            "path": HTML_PATH
        })
        require(call["exit"] == 0 and "Chrome Bridge Live Test" in Path(HTML_PATH).read_text(encoding="utf-8"), "getHTML failed")

        # 16. Extract Text
        call = run_bridge("extractText", tab_id, 2000)
        text = (result(call) or {}).get("text", "")
        record(summary, "extractText", call, {
            "containsTitle": "Chrome Bridge Live Test" in text,
            "chars": len(text)
        })
        require(call["exit"] == 0 and "Chrome Bridge Live Test" in text, "extractText failed")

        # 17. Set Viewport
        call = run_bridge("setViewport", tab_id, 800, 600, 1)
        viewport = result(call) or {}
        record(summary, "setViewport", call, {
            "width": viewport.get("width"),
            "height": viewport.get("height")
        })
        require(call["exit"] == 0 and viewport.get("width") == 800 and viewport.get("height") == 600, "setViewport failed")

        # 17a. Set CPU Throttling
        call = run_bridge("setCpuThrottling", tab_id, 4)
        cpu = result(call) or {}
        record(summary, "setCpuThrottling", call, {"rate": cpu.get("rate")})
        require(call["exit"] == 0 and cpu.get("rate") == 4, "setCpuThrottling failed")

        # 17b. Set Network Conditions
        call = run_bridge("setNetworkConditions", tab_id, 0, 50, 100000, 50000)
        record(summary, "setNetworkConditions", call)
        require(call["exit"] == 0, "setNetworkConditions failed")

        # 17c. Clear Network Conditions
        call = run_bridge("clearNetworkConditions", tab_id)
        record(summary, "clearNetworkConditions", call)
        require(call["exit"] == 0, "clearNetworkConditions failed")

        # 17d. Set Color Scheme
        call = run_bridge("setColorScheme", tab_id, "dark")
        color_scheme = result(call) or {}
        record(summary, "setColorScheme", call, {"scheme": color_scheme.get("scheme")})
        require(call["exit"] == 0 and color_scheme.get("scheme") == "dark", "setColorScheme failed")

        # 17e. Set User Agent
        call = run_bridge("setUserAgent", tab_id, "BenchUA/1.0")
        record(summary, "setUserAgent", call)
        require(call["exit"] == 0, "setUserAgent failed")

        # 18. Monitoring Start
        call = run_bridge("startMonitoring", tab_id)
        record(summary, "startMonitoring", call)
        require(call["exit"] == 0, "startMonitoring failed")
        monitoring_started = True

        # 19. Console Messages
        run_bridge("click", tab_id, "#log")
        time.sleep(0.5)
        call = run_bridge("consoleMessages", tab_id)
        messages = (result(call) or {}).get("messages", [])
        record(summary, "consoleMessages", call, {"count": len(messages)})
        require(call["exit"] == 0 and len(messages) >= 1, "consoleMessages failed")
        # Backward compatibility: the default response must stay stack-only, with
        # no source-map fields on any frame.
        default_frames = [frame for message in messages if isinstance(message, dict)
                          for frame in (message.get("stack") or []) if isinstance(frame, dict)]
        require(
            all("originalLocation" not in frame and "sourceMapStatus" not in frame for frame in default_frames),
            "consoleMessages resolved source maps without --source-maps",
        )

        # 19b. Source-Mapped Console Stacks (HI7)
        run_bridge("click", tab_id, "#mapped")
        run_bridge("click", tab_id, "#mapped-cross")
        time.sleep(0.5)
        call = run_bridge("consoleMessages", tab_id, "--source-maps")
        mapped_result = result(call) or {}
        mapped_frames = [frame for message in mapped_result.get("messages", []) if isinstance(message, dict)
                         for frame in (message.get("stack") or []) if isinstance(frame, dict)]
        resolved = [frame for frame in mapped_frames
                    if isinstance(frame.get("originalLocation"), dict)
                    and str(frame["originalLocation"].get("source", "")).endswith(MAPPED_SOURCE)
                    and frame["originalLocation"].get("lineNumber") == MAPPED_ORIGINAL_LINE]
        refused = [frame for frame in mapped_frames
                   if "crossmap.js" in str(frame.get("url", ""))
                   and frame.get("sourceMapStatus") == "crossOriginRefused"]
        # The map body must never come back through the response.
        leaked = "sourcesContent" in json.dumps(mapped_result)
        record(summary, "consoleMessagesSourceMaps", call, {
            "resolved": len(resolved),
            "crossOriginRefused": len(refused),
            "sourceMapsResolved": mapped_result.get("sourceMapsResolved"),
        })
        require(
            call["exit"] == 0
            and mapped_result.get("sourceMapsResolved") is True
            and len(resolved) >= 1
            and len(refused) >= 1
            and not leaked,
            "consoleMessages --source-maps did not resolve the inline map or refuse the cross-origin map",
            call,
        )

        # 20. Network Requests
        run_bridge("click", tab_id, "#fetch")
        time.sleep(0.5)
        call = run_bridge("networkRequests", tab_id)
        requests = (result(call) or {}).get("requests", [])
        has_query_in_url = any("secret=redact-me" in req.get("url", "") for req in requests if isinstance(req, dict))
        record(summary, "networkRequests", call, {
            "count": len(requests),
            "redacted": not has_query_in_url
        })
        require(call["exit"] == 0 and len(requests) >= 1 and not has_query_in_url, "networkRequests failed")

        # 21. Handle Dialog
        run_bridge("executeScriptCDP", tab_id, "setTimeout(() => alert('hello dialog'), 0); 'scheduled'")
        time.sleep(0.2)
        call = run_bridge("handleDialog", tab_id, "accept")
        record(summary, "handleDialog", call)
        require(call["exit"] == 0, "handleDialog failed")

        # 22. Monitoring Stop
        call = run_bridge("stopMonitoring", tab_id)
        record(summary, "stopMonitoring", call)
        require(call["exit"] == 0, "stopMonitoring failed")
        monitoring_started = False

        # 23. Get Current State & Observe
        call = run_bridge("getCurrentState", tab_id)
        res = result(call) or {}
        obs_list = res.get("observe", [])
        obs_ok = isinstance(obs_list, list) and len(obs_list) > 0 and any(
            "Chrome Bridge Live Test" in str(node.get("name", "")) or "ready" in str(node.get("name", ""))
            for node in obs_list if isinstance(node, dict)
        )
        record(summary, "getCurrentState", call, {"observe_ok": obs_ok})
        require(call["exit"] == 0 and obs_ok, "getCurrentState failed or observe did not contain fixture text")

        call = run_bridge("click", tab_id, "#shadow-host >>> #shadow-btn")
        record(summary, "shadowDomClick", call)
        require(call["exit"] == 0, "shadow DOM click failed")
        call = run_bridge("executeScriptCDP", tab_id, "window.__shadowClicks >= 1")
        shadow_clicked = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_shadow_click", call, {"clicked": shadow_clicked})
        require(call["exit"] == 0 and shadow_clicked is True, "shadow DOM click did not update counter")

        call = run_bridge("fill", tab_id, "frame=#frame >> #frame-input", "framed")
        record(summary, "iframeFill", call)
        require(call["exit"] == 0, "iframe fill failed")
        call = run_bridge("executeScriptCDP", tab_id, "window.__frameValue === 'framed'")
        frame_filled = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_iframe_fill", call, {"filled": frame_filled})
        require(call["exit"] == 0 and frame_filled is True, "iframe fill did not update frame value")
        before = run_bridge("executeScriptCDP", tab_id, "window.__frameClicks")
        before_count = (result(before) or {}).get("val") or 0
        call = run_bridge("click", tab_id, "frame=#frame >> #frame-button")
        after = run_bridge("executeScriptCDP", tab_id, "window.__frameClicks")
        after_count = (result(after) or {}).get("val") or 0
        record(summary, "iframeClick", call, {"before": before_count, "after": after_count})
        require(call["exit"] == 0 and after_count == before_count + 1, "iframe click fired zero or multiple times")
        call = run_bridge("select", tab_id, "frame=#frame >> #frame-select", "two")
        record(summary, "iframeSelect", call)
        require(call["exit"] == 0, "iframe select failed")
        call = run_bridge("executeScriptCDP", tab_id, "window.__frameSelect === 'two'")
        frame_selected = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_iframe_select", call, {"selected": frame_selected})
        require(call["exit"] == 0 and frame_selected is True, "iframe select did not update frame value")
        call = run_bridge("uploadFile", tab_id, "frame=#frame >> #frame-file", UPLOAD_FIXTURE)
        record(summary, "iframeUpload", call)
        require(call["exit"] == 0, "iframe upload failed")
        call = run_bridge("executeScriptCDP", tab_id, "window.__frameFileCount === 1")
        frame_uploaded = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_iframe_upload", call, {"uploaded": frame_uploaded})
        require(call["exit"] == 0 and frame_uploaded is True, "iframe upload did not update frame file count")
        call = run_bridge("fill", tab_id, "#shadow-host >>> #shadow-input", "shadowed")
        record(summary, "shadowFill", call)
        require(call["exit"] == 0, "shadow fill failed")
        call = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-input').value === 'shadowed'")
        shadow_filled = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_shadow_fill", call, {"filled": shadow_filled})
        require(call["exit"] == 0 and shadow_filled is True, "shadow fill did not update value")
        call = run_bridge("executeScriptCDP", tab_id, "const raw = document.createElement('input'); raw.id = 'raw-css-token'; raw.setAttribute('aria-label', 'Search >> query'); document.body.appendChild(raw); true")
        record(summary, "executeScriptCDP_setup_raw_css_token", call)
        require(call["exit"] == 0, "raw CSS token fixture setup failed")
        call = run_bridge("fill", tab_id, '[aria-label="Search >> query"]', "raw-css")
        record(summary, "rawCssQuotedSeparatorFill", call)
        require(call["exit"] == 0, "raw CSS with quoted separator failed")
        call = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#raw-css-token').value === 'raw-css'")
        raw_css_filled = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_raw_css_token_fill", call, {"filled": raw_css_filled})
        require(call["exit"] == 0 and raw_css_filled is True, "raw CSS with quoted separator did not update value")
        call = run_bridge("fill", tab_id, "label=Search query", "by-label")
        record(summary, "semanticLabelFill", call)
        require(call["exit"] == 0, "semantic label fill failed")
        call = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#q').value === 'by-label'")
        label_filled = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_semantic_label_fill", call, {"filled": label_filled})
        require(call["exit"] == 0 and label_filled is True, "semantic label fill did not update value")
        before = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#status').textContent")
        call = run_bridge("click", tab_id, "role=button[name=Click me]")
        after = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#status').textContent")
        role_status = (result(after) or {}).get("val")
        record(summary, "semanticRoleClick", call, {"before": (result(before) or {}).get("val"), "after": role_status})
        require(call["exit"] == 0 and role_status == "clicked:by-label", "semantic role click did not update status")
        before = run_bridge("executeScriptCDP", tab_id, "window.__frameClicks")
        before_count = (result(before) or {}).get("val") or 0
        call = run_bridge("click", tab_id, "frame=#frame >> text=Frame click")
        after = run_bridge("executeScriptCDP", tab_id, "window.__frameClicks")
        after_count = (result(after) or {}).get("val") or 0
        record(summary, "semanticFrameTextClick", call, {"before": before_count, "after": after_count})
        require(call["exit"] == 0 and after_count == before_count + 1, "semantic frame text click fired zero or multiple times")
        call = run_bridge("fill", tab_id, "css=#q", "by-css-prefix")
        record(summary, "semanticCssFill", call)
        require(call["exit"] == 0, "semantic css fill failed")
        call = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#q').value === 'by-css-prefix'")
        css_filled = (result(call) or {}).get("val")
        record(summary, "executeScriptCDP_verify_semantic_css_fill", call, {"filled": css_filled})
        require(call["exit"] == 0 and css_filled is True, "semantic css fill did not update value")

        malformed_locators = [
            (">>>> #bad", "Unsupported selector token"),
            ("frame= >> #q", "Missing frame selector"),
            ("frame=#frame >>", "Missing final selector"),
            ("#shadow-host >>>", "Missing final selector"),
            ("role=button[name=]", "Invalid role locator"),
            ("role=[name=Submit]", "Invalid role locator"),
        ]
        rejected = {}
        for locator, expected_error in malformed_locators:
            call = run_bridge("click", tab_id, locator)
            semantic_error = result(call) or {}
            message = semantic_error.get("err") or semantic_error.get("error") or ""
            rejected[locator] = call["exit"] != 0 and expected_error in message
        summary["semanticSyntaxRejected"] = rejected
        require(all(rejected.values()), "semantic syntax error was not preserved")

        # 24. Start Interception
        call = run_bridge("startInterception", tab_id, "*data.json*", "fulfill", 200, '{"ok":true,"intercepted":true}')
        record(summary, "startInterception", call)
        require(call["exit"] == 0, "startInterception failed")
        interception_started = True

        # 25. Intercepted Requests
        call = run_bridge("executeScriptCDP", tab_id, "fetch('/data.json?secret=intercept-me').then(r => r.text()).then(t => { window.__interceptedBody = t; return t; })")
        body = (result(call) or {}).get("val", "")
        record(summary, "interceptedFetchBody", call, {"fulfilled": '"intercepted":true' in body})
        require(call["exit"] == 0 and '"intercepted":true' in body, "interception did not fulfill mocked response body")
        time.sleep(0.5)
        call = run_bridge("interceptedRequests", tab_id)
        interception = result(call) or {}
        reqs = interception.get("requests", []) if isinstance(interception, dict) else []
        intercepted_url_leak = any("?" in req.get("url", "") for req in reqs if isinstance(req, dict))
        intercepted_has_query = any(req.get("hasQuery") is True for req in reqs if isinstance(req, dict))
        record(summary, "interceptedRequests", call, {"count": len(reqs), "redacted": not intercepted_url_leak, "hasQuery": intercepted_has_query})
        require(call["exit"] == 0 and len(reqs) >= 1 and not intercepted_url_leak and intercepted_has_query, "interceptedRequests failed redaction/query check")

        # 26. Stop Interception
        call = run_bridge("stopInterception", tab_id)
        record(summary, "stopInterception", call)
        require(call["exit"] == 0, "stopInterception failed")
        interception_started = False

        # 27. Download URL
        if os.environ.get("CHROME_BRIDGE_TEST_DOWNLOAD") != "1":
            sys.stderr.write("Skipping downloadUrl check (opt-in only for live profiles).\n")
            summary["downloadUrl"] = {"exit": 0, "skipped": True}
        else:
            call = run_bridge("downloadUrl", BASE_URL + "data.json", DOWNLOAD_NAME)
            res = result(call) or {}
            record(summary, "downloadUrl", call, {"downloadId": res.get("downloadId")})
            require(call["exit"] == 0 and res.get("downloadId") is not None, "downloadUrl failed")

        # 28. Storage State
        call = run_bridge("storageState", tab_id, STATE_PATH)
        state_meta = call.get("json") or {}
        record(summary, "storageState", call, {
            "cookieCount": state_meta.get("cookieCount"),
            "bytes": state_meta.get("bytes"),
            "path": STATE_PATH
        })
        require(call["exit"] == 0 and Path(STATE_PATH).is_file(), "storageState failed")

        # 29. Geolocation
        call = run_bridge("setGeolocation", tab_id, 37.7749, -122.4194, 100)
        geo_set = result(call) or {}
        record(summary, "setGeolocation", call, {"grantError": geo_set.get("grantError")})
        require(call["exit"] == 0, "setGeolocation failed")

        geo_expr = """new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ok: true, latitude: pos.coords.latitude, longitude: pos.coords.longitude}),
            (err) => resolve({ok: false, code: err.code, message: err.message}),
            {maximumAge: 0, timeout: 3000}
          );
        })"""
        call = run_bridge("executeScriptCDP", tab_id, geo_expr)
        geo = (result(call) or {}).get("val") or {}
        geo_ok = (
            call["exit"] == 0
            and geo.get("ok") is True
            and abs(float(geo.get("latitude")) - 37.7749) < 0.01
            and abs(float(geo.get("longitude")) - (-122.4194)) < 0.01
        )
        record(summary, "geolocationRead", call, {"ok": geo.get("ok"), "code": geo.get("code"), "message": geo.get("message")})
        require(geo_ok, "geolocation read did not return overridden coordinates")

        call = run_bridge("clearGeolocation", tab_id)
        record(summary, "clearGeolocation", call)
        require(call["exit"] == 0, "clearGeolocation failed")

        # 30. Performance Metrics
        call = run_bridge("performanceMetrics", tab_id)
        perf = result(call) or {}
        metrics = perf.get("metrics", {}) if isinstance(perf, dict) else {}
        record(summary, "performanceMetrics", call, {"metricCount": len(metrics)})
        require(call["exit"] == 0 and len(metrics) > 0, "performanceMetrics failed or returned no metrics")

        # 31. Audit viewer (local read of the host's audit log; no browser action)
        call = run_bridge("audit", "tail", 5)
        lines = [line for line in call["stdout"].splitlines() if line.strip()]
        header_ok = bool(lines) and lines[0].split()[:3] == ["TIMESTAMP", "CLIENT", "ACTION"]
        record(summary, "auditTail", call, {"lines": len(lines), "header": header_ok})
        require(call["exit"] == 0, "audit tail failed")

        call = run_bridge("audit", "summary", "--since", "1d")
        summary_text = call["stdout"]
        record(summary, "auditSummary", call, {"hasDecisions": "Decisions:" in summary_text})
        require(call["exit"] == 0, "audit summary failed")

        # 32. PDF export (background-safe debugger path; metadata only)
        call = run_bridge("printToPDF", tab_id, PDF_PATH)
        pdf = call.get("json") or {}
        pdf_file = Path(PDF_PATH)
        record(summary, "printToPDF", call, {
            "bytes": pdf.get("bytes"),
            "mimeType": pdf.get("mimeType"),
            "path": PDF_PATH
        })
        require(
            call["exit"] == 0
            and pdf.get("mimeType") == "application/pdf"
            and pdf.get("bytes", 0) > 1000
            and pdf_file.is_file()
            and pdf_file.read_bytes()[:5] == b"%PDF-",
            "printToPDF failed"
        )

        # 33. Coordinate click: no selector is resolved, so verify by page effect
        box = run_bridge("executeScriptCDP", tab_id, "(() => { const r = document.querySelector('#btn').getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()")
        point = (result(box) or {}).get("val") or {}
        require(box["exit"] == 0 and "x" in point and "y" in point, "could not resolve fixture button coordinates for clickAt", box)
        run_bridge("fill", tab_id, "#q", "coordinate")
        call = run_bridge("clickAt", tab_id, point["x"], point["y"])
        clicked = result(call) or {}
        status = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#status').textContent")
        status_text = (result(status) or {}).get("val")
        record(summary, "clickAt", call, {"x": clicked.get("x"), "y": clicked.get("y"), "status": status_text})
        # CDP input targets the tab directly, but an inactive tab may not receive
        # synthesized mouse input, so only require the page effect when the
        # fixture tab is the active one.
        if QUIET_MODE:
            require(call["exit"] == 0 and clicked.get("x") == point["x"], "clickAt failed", call)
        else:
            require(call["exit"] == 0 and status_text == "clicked:coordinate", "clickAt did not activate the fixture button", call)

        # 34. Window management: list stays structural, create is unfocused, close works
        call = run_bridge("windowControl", "list")
        windows = (result(call) or {}).get("windows") or []
        leaked = [w for w in windows if not isinstance(w, dict) or {"url", "title", "tabs"} & set(w)]
        record(summary, "windowControlList", call, {"windowCount": len(windows), "leakedFields": len(leaked)})
        require(call["exit"] == 0 and len(windows) > 0 and not leaked, "windowControl list failed or leaked tab detail", call)

        call = run_bridge("windowControl", "create", BASE_URL)
        created = result(call) or {}
        new_window_id = created.get("windowId")
        record(summary, "windowControlCreate", call, {"focused": created.get("focused"), "tabCount": created.get("tabCount")})
        require(
            call["exit"] == 0 and isinstance(new_window_id, int) and created.get("focused") is False,
            "windowControl create failed or focused the new window",
            call
        )

        call = run_bridge("windowControl", "setState", new_window_id, "minimized")
        record(summary, "windowControlSetState", call, {"state": (result(call) or {}).get("state")})
        require(call["exit"] == 0 and (result(call) or {}).get("state") == "minimized", "windowControl setState failed", call)

        call = run_bridge("windowControl", "close", new_window_id)
        record(summary, "windowControlClose", call, {"closed": (result(call) or {}).get("closed")})
        require(call["exit"] == 0 and (result(call) or {}).get("closed") is True, "windowControl close failed", call)

        # 35. Batch: waits interleaved with mutations, then continue-on-error
        batch_steps = json.dumps([
            {"action": "fill", "payload": {"selector": "#q", "text": "batched"}},
            {"action": "waitForSelector", "timeoutMs": 5000, "payload": {"selector": "#btn"}},
            {"action": "click", "payload": {"selector": "#btn"}},
            {"action": "waitForText", "timeoutMs": 5000, "payload": {"text": "clicked:batched"}}
        ])
        call = run_bridge("batch", batch_steps, tab_id, timeout=40)
        batch_out = result(call)
        record(summary, "batchWithWaits", call, {"stepCount": len(batch_out) if isinstance(batch_out, list) else None})
        require(
            call["exit"] == 0 and isinstance(batch_out, list) and len(batch_out) == 4,
            "batch with interleaved waits failed",
            call
        )

        failing_steps = json.dumps([
            {"action": "waitForSelector", "timeoutMs": 1000, "payload": {"selector": "#definitely-absent"}},
            {"action": "fill", "payload": {"selector": "#q", "text": "after-failure"}}
        ])
        call = run_bridge("batch", failing_steps, tab_id, "--continue-on-error", timeout=40)
        batch_out = result(call)
        continued = (
            isinstance(batch_out, list)
            and len(batch_out) == 2
            and isinstance(batch_out[0], dict)
            and batch_out[0].get("success") is False
        )
        record(summary, "batchContinueOnError", call, {"continued": continued})
        require(call["exit"] == 0 and continued, "batch --continue-on-error did not record the failed step and continue", call)

        # 36. Cookie writes (identifier-only responses)
        cookie_name = "chromeBridgeLive"
        cookie_value = "live-cookie-secret"
        call = run_bridge("setCookie", BASE_URL, cookie_name, cookie_value)
        set_cookie = result(call) or {}
        value_leaked = cookie_value in call["stdout"]
        record(summary, "setCookie", call, {
            "name": set_cookie.get("name"),
            "hasDomain": bool(set_cookie.get("domain")),
            "valueEchoed": value_leaked,
        })
        require(
            call["exit"] == 0 and set_cookie.get("name") == cookie_name and not value_leaked,
            "setCookie failed or echoed the cookie value",
            call
        )

        call = run_bridge("deleteCookie", BASE_URL, cookie_name)
        deleted = result(call) or {}
        record(summary, "deleteCookie", call, {"name": deleted.get("name"), "removed": deleted.get("removed")})
        require(call["exit"] == 0 and deleted.get("removed") is True, "deleteCookie failed", call)

        # 37. Storage writes (identifier-only responses)
        storage_value = "live-storage-secret"
        call = run_bridge("setStorageItem", tab_id, "local", "bridgeLiveKey", storage_value)
        set_item = result(call) or {}
        record(summary, "setStorageItem", call, {
            "scope": set_item.get("scope"),
            "key": set_item.get("key"),
            "valueEchoed": storage_value in call["stdout"],
        })
        require(
            call["exit"] == 0 and set_item.get("key") == "bridgeLiveKey" and storage_value not in call["stdout"],
            "setStorageItem failed or echoed the stored value",
            call
        )

        call = run_bridge("executeScriptCDP", tab_id, "localStorage.getItem('bridgeLiveKey')")
        stored = (result(call) or {}).get("val")
        record(summary, "storageItemReadBack", call, {"matched": stored == storage_value})
        require(call["exit"] == 0 and stored == storage_value, "setStorageItem did not write the value into the tab", call)

        call = run_bridge("removeStorageItem", tab_id, "local", "bridgeLiveKey")
        removed_item = result(call) or {}
        record(summary, "removeStorageItem", call, {"key": removed_item.get("key"), "existed": removed_item.get("existed")})
        require(call["exit"] == 0 and removed_item.get("existed") is True, "removeStorageItem failed", call)

        call = run_bridge("clearStorage", tab_id, "both")
        cleared = result(call) or {}
        scopes_cleared = [entry.get("scope") for entry in cleared.get("cleared", []) if isinstance(entry, dict)]
        record(summary, "clearStorage", call, {"scopes": scopes_cleared})
        require(call["exit"] == 0 and scopes_cleared == ["local", "session"], "clearStorage did not clear both scopes", call)

        # 38. History and bookmarks search (profile-dependent counts)
        call = run_bridge("searchHistory", "chrome-bridge-live", 5)
        history = result(call) or {}
        record(summary, "searchHistory", call, {"count": history.get("count")})
        require(call["exit"] == 0 and isinstance(history.get("items"), list), "searchHistory failed", call)

        call = run_bridge("searchBookmarks", "chrome-bridge-live")
        bookmarks = result(call) or {}
        record(summary, "searchBookmarks", call, {"count": bookmarks.get("count")})
        require(call["exit"] == 0 and isinstance(bookmarks.get("items"), list), "searchBookmarks failed", call)

        # 39. Cross-tab text search (origin host only, bounded snippets)
        call = run_bridge("searchTabs", "Chrome Bridge Live Test", "--max-per-tab", 3)
        tab_search = result(call) or {}
        hits = tab_search.get("matches", []) if isinstance(tab_search, dict) else []
        fixture_hit = next((hit for hit in hits if isinstance(hit, dict) and hit.get("tabId") == tab_id), None)
        domain_only = fixture_hit is not None and "/" not in str(fixture_hit.get("domain", "/"))
        record(summary, "searchTabs", call, {
            "matchingTabs": tab_search.get("matchingTabs"),
            "skippedTabs": tab_search.get("skippedTabs"),
            "fixtureMatched": fixture_hit is not None,
            "domainOnly": domain_only,
        })
        require(
            call["exit"] == 0 and fixture_hit is not None and domain_only
            and len(fixture_hit.get("snippets", [])) <= 3,
            "searchTabs did not match the fixture tab with a host-only domain and capped snippets",
            call
        )

        # 40. Screencast recording: background-safe capture, frames to disk, metadata-only stdout
        call = run_bridge("startScreencast", tab_id, "--quality", 40, "--max-width", 640)
        started = result(call) or {}
        record(summary, "startScreencast", call, {"recording": started.get("recording")})
        require(call["exit"] == 0 and started.get("recording") is True, "startScreencast did not report recording", call)
        screencast_started = True
        # Screencast frames are emitted on repaint; scroll the fixture to force some.
        run_bridge("scroll", tab_id, 0, 400)
        time.sleep(0.5)
        run_bridge("scroll", tab_id, 0, -400)
        time.sleep(0.5)
        call = run_bridge("screencastSave", tab_id, SCREENCAST_DIR, "--fps", 8)
        saved = call.get("json") or {}
        screencast_path = Path(SCREENCAST_DIR)
        frame_files = sorted(screencast_path.glob("frame-*"))
        manifest_file = screencast_path / "frames.json"
        manifest = json.loads(manifest_file.read_text()) if manifest_file.exists() else {}
        # Metadata only: base64 frame payloads must never reach stdout.
        leaked = "base64" in call["stdout"] or any(len(line) > 400 for line in call["stdout"].splitlines())
        record(summary, "screencastSave", call, {
            "frames": saved.get("frames"),
            "dropped": saved.get("dropped"),
            "bytes": saved.get("bytes"),
            "frameFiles": len(frame_files),
            "manifestWritten": manifest_file.exists(),
            "leakedFrameData": leaked,
        })
        require(
            call["exit"] == 0 and len(frame_files) >= 1 and manifest_file.exists()
            and manifest.get("count") == len(frame_files) and not leaked,
            "screencastSave did not write frames plus a manifest with metadata-only stdout",
            call
        )
        if QUIET_MODE:
            state = run_bridge("getCurrentState", tab_id)
            active = ((result(state) or {}).get("tab") or {}).get("active")
            record(summary, "screencastQuietInactive", state, {"active": active})
            require(state["exit"] == 0 and active is False, "screencast activated the fixture tab", state)
        call = run_bridge("stopScreencast", tab_id)
        stopped = result(call) or {}
        record(summary, "stopScreencast", call, {
            "remainingFrames": stopped.get("remainingFrames"),
            "droppedFrames": stopped.get("droppedFrames"),
        })
        require(call["exit"] == 0 and stopped.get("recording") is False, "stopScreencast failed", call)
        screencast_started = False

        # 41. Observe element refs: every node is addressable, and ref=eN clicks it
        run_bridge("fill", tab_id, "#q", "refclick")
        run_bridge("executeScriptCDP", tab_id, "document.querySelector('#status').textContent = 'ready'; 'reset'")
        call = run_bridge("observe", tab_id, "--role", "button", "--limit", 50)
        observed = result(call) or []
        nodes = observed if isinstance(observed, list) else []
        refs_present = bool(nodes) and all(
            isinstance(node, dict) and str(node.get("ref", "")).startswith("e") for node in nodes
        )
        button = next((node for node in nodes if isinstance(node, dict) and node.get("name") == "Click me"), None)
        record(summary, "observeRefs", call, {
            "nodes": len(nodes),
            "refsPresent": refs_present,
            "buttonRef": (button or {}).get("ref"),
        })
        require(
            call["exit"] == 0 and refs_present and button is not None,
            "observe did not return a ref for the fixture button",
            call
        )
        button_ref = button["ref"]
        call = run_bridge("click", tab_id, f"ref={button_ref}")
        status = run_bridge("executeScriptCDP", tab_id, "document.querySelector('#status').textContent")
        clicked = (result(status) or {}).get("val")
        record(summary, "clickByRef", call, {"ref": button_ref, "status": clicked})
        require(
            call["exit"] == 0 and clicked == "clicked:refclick",
            "click by observe ref did not reach the fixture button",
            call
        )

        # 42. Observe diff: a DOM mutation shows up as an added node against the prior epoch
        call = run_bridge("observe", tab_id, "--diff")
        baseline = result(call) or {}
        require(call["exit"] == 0, "observe --diff baseline failed", call)
        run_bridge(
            "executeScriptCDP",
            tab_id,
            "(() => { const b = document.createElement('button'); b.id = 'diff-btn'; b.textContent = 'Diff added'; document.body.appendChild(b); return 'added'; })()"
        )
        call = run_bridge("observe", tab_id, "--diff")
        diff = result(call) or {}
        added_names = [node.get("name") for node in diff.get("added", []) if isinstance(node, dict)]
        epochs_chained = (
            diff.get("baseEpoch") == baseline.get("epoch")
            and isinstance(diff.get("epoch"), int)
            and diff.get("epoch") > diff.get("baseEpoch", 0)
        )
        record(summary, "observeDiff", call, {
            "baseEpoch": diff.get("baseEpoch"),
            "epoch": diff.get("epoch"),
            "added": len(diff.get("added", [])),
            "removed": len(diff.get("removed", [])),
            "changed": len(diff.get("changed", [])),
        })
        require(
            call["exit"] == 0 and "Diff added" in added_names and epochs_chained,
            "observe --diff did not report the injected button against the previous epoch",
            call
        )

        # 43. Stale refs fail loudly: a navigation invalidates every ref for the tab
        call = run_bridge("reload", tab_id)
        require(call["exit"] == 0, "reload before stale-ref check failed", call)
        call = run_bridge("waitForLoad", tab_id, 20000)
        require(call["exit"] == 0, "waitForLoad after reload failed", call)
        call = run_bridge("click", tab_id, f"ref={button_ref}")
        stale = result(call) or {}
        record(summary, "staleRefRejected", call, {
            "ref": button_ref,
            "error": stale.get("error"),
        })
        require(
            call["exit"] != 0 and stale.get("error") == "staleRef",
            "a ref from before the navigation was not rejected with staleRef",
            call
        )

        if QUIET_MODE:
            state = run_bridge("getCurrentState", tab_id)
            active = ((result(state) or {}).get("tab") or {}).get("active")
            record(summary, "quietFinalInactive", state, {"active": active})
            require(state["exit"] == 0 and active is False, "quiet run ended with active tab")


        # Compact JSON output on success
        print(json.dumps(summary, separators=(",", ":")))

    finally:
        # Best effort cleanup
        if tab_id is not None:
            if monitoring_started:
                with contextlib.suppress(Exception):
                    run_bridge("stopMonitoring", tab_id)
            if interception_started:
                with contextlib.suppress(Exception):
                    run_bridge("stopInterception", tab_id)
            if screencast_started:
                with contextlib.suppress(Exception):
                    run_bridge("stopScreencast", tab_id)
            with contextlib.suppress(Exception):
                run_bridge("closeTab", tab_id)

        if policy_installed and policy_path is not None:
            restore_policy(policy_backup, policy_path, backup_mode)
        if server is not None:
            server.shutdown()

        with contextlib.suppress(Exception):
            shutil.rmtree(SCREENCAST_DIR)

        for path in [UPLOAD_FIXTURE, SHOT_PATH, PDF_PATH, HTML_PATH, STATE_PATH]:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(path)

if __name__ == "__main__":
    try:
        parser = argparse.ArgumentParser(description="Run the live Chrome Native Bridge capability matrix")
        parser.add_argument("--quiet", action="store_true", help="Open the fixture tab inactive and capture screenshots through CDP")
        args = parser.parse_args()
        main(quiet=args.quiet)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        if LAST_SUMMARY:
            print(json.dumps(LAST_SUMMARY, sort_keys=True, separators=(",", ":")), file=sys.stderr)
        sys.exit(1)