#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import http.server
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from xml.etree import ElementTree

SCRIPT_DIR = Path(__file__).resolve().parent
CLIENT = SCRIPT_DIR / "test_client.py"
BRIDGE_COMMAND = os.environ.get("CHROME_BRIDGE_CLIENT")
BENCHMARK_QUIET = False


COMPARISON_METADATA = {
    "tools": {
        "chrome-native-bridge": {
            "name": "Chrome Native Bridge",
            "strengths": "Runs in real-profile Chrome using extension/native host, allows CDP-backed interactions, supports storage, geolocation, performance metrics, and console/network monitoring.",
            "limits": "No isolated contexts/profiles, no native trace/video capture, and limited interactive policy approvals.",
            "capability_status": "pass",
            "scores": {"speed": 4, "capability": 4, "authReuse": 5, "ergonomics": 3},
        },
        "playwright": {
            "name": "Playwright",
            "strengths": "Multiple browser engines, isolated browser contexts, rich locator semantics, tracing, video recording, and test-runner integration.",
            "limits": "Runs in custom automation profiles by default, so existing user-profile cookies, extensions, and local state require explicit setup.",
            "capability_status": "pass",
            "scores": {"speed": 4, "capability": 5, "authReuse": 2, "ergonomics": 5},
        },
        "claude-in-chrome": {
            "name": "Claude in Chrome",
            "strengths": "Agentic natural-language driving of a real browser session.",
            "limits": "Manual/agentic interaction is slower than API-driven tools and lacks low-level interception/performance primitives.",
            "capability_status": "manual",
            "scores": {"speed": 1, "capability": 3, "authReuse": 5, "ergonomics": 4},
        },
        "codex-chrome-extension": {
            "name": "Codex Chrome Extension",
            "strengths": "In-browser assistant and script executor that can reuse a signed-in browser profile.",
            "limits": "No dedicated native host channel and fewer low-level browser diagnostics than CDP-backed harnesses.",
            "capability_status": "manual",
            "scores": {"speed": 2, "capability": 3, "authReuse": 5, "ergonomics": 4},
        },
        "puppeteer": {
            "name": "Puppeteer",
            "strengths": "Direct Chromium/CDP control with a lightweight API and broad scraping/automation ecosystem.",
            "limits": "Cross-browser support is narrower than Playwright and test-runner/trace ergonomics are less integrated.",
            "capability_status": "pass",
            "scores": {"speed": 5, "capability": 4, "authReuse": 2, "ergonomics": 4},
        },
        "chrome-devtools-mcp": {
            "name": "Chrome DevTools MCP",
            "strengths": "Standardized MCP surface for controlling Chrome DevTools from agents.",
            "limits": "Depends on a separate MCP server and lacks the native-host file/profile conveniences of this bridge.",
            "capability_status": "measured-adapter",
            "scores": {"speed": 3, "capability": 4, "authReuse": 4, "ergonomics": 3},
        },
    },
    "gaps": [
        {
            "id": "BENCH-001",
            "gap": "isolated contexts and profiles",
            "description": "Launch isolated/ephemeral browser profiles within one benchmark run while preserving the real-profile mode.",
            "surface": "benchmark_harness.py adapter lifecycle and extension/background.js session model",
            "acceptance": "A benchmark run can create two isolated sessions with separate cookies and report both as pass.",
        },
        {
            "id": "BENCH-002",
            "gap": "multi-browser support",
            "description": "Add non-Chrome browser targets or explicit parity adapters for Firefox/WebKit.",
            "surface": "benchmark_harness.py adapter registry",
            "acceptance": "The scorecard includes measured Firefox or WebKit timings for navigate, click, fill, screenshot, and storage.",
        },
        {
            "id": "BENCH-003",
            "gap": "trace and video recording",
            "description": "Capture replayable traces or video artifacts for browser operations.",
            "surface": "extension/background.js debugger commands and benchmark_harness.py artifact fields",
            "acceptance": "A live Chrome Bridge run writes a trace or video artifact path and the report links it without exposing private content.",
        },
        {
            "id": "BENCH-005",
            "gap": "interactive destructive approval",
            "description": "Provide an interactive approve/deny path for actions the policy marks requireConfirmation, instead of failing closed with confirmationRequired.",
            "surface": "bridge.py, host-rs/src/main.rs, mcp/chrome_bridge_mcp/server.py",
            "acceptance": "A confirmation-required action can be approved through an explicit client prompt and then proceeds, while denial blocks it, with the decision audited.",
        },
    ],
}

OPERATIONS = [
    "ping",
    "navigate",
    "wait-load",
    "wait-selector",
    "click",
    "fill",
    "select",
    "upload",
    "screenshot",
    "extract-text",
    "get-html",
    "observe-state",
    "shadow-dom-click",
    "iframe-fill",
    "role-click",
    "label-fill",
    "text-click",
    "frame-select",
    "frame-upload",
    "shadow-fill",
    "console-monitoring",
    "network-monitoring",
    "dialog-handling",
    "storage-state",
    "geolocation",
    "performance-metrics",
]

FIXTURE_PAGE = b"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Benchmark Fixture</title>
  <style>
    body { font-family: sans-serif; min-height: 1600px; margin: 24px; }
    #workflow { display: grid; gap: 12px; max-width: 760px; padding: 20px; border: 1px solid #ccc; }
    #workflow label { display: grid; gap: 4px; }
    #workflow-body, .section-body { min-height: 88px; }
    #workflow-catalog { max-height: 320px; overflow: auto; border: 1px solid #ddd; }
    .catalog-row { display: grid; grid-template-columns: 50px 1fr 100px; padding: 4px 8px; }
  </style>
</head>
<body>
  <h1>Benchmark Fixture</h1>
  <label for="q">Search query</label>
  <input id="q" value="">
  <select id="kind">
    <option value="alpha">Alpha</option>
    <option value="beta">Beta</option>
  </select>
  <button id="btn">Click me</button>
  <input id="file" type="file">
  <button id="log">Log</button>
  <button id="fetch">Fetch</button>
  <button id="alert">Alert</button>
  <div id="status">ready</div>
  <main id="workflow" aria-label="Complex workflow fixture">
    <h2>Article workspace</h2>
    <label for="workflow-title">Article title</label>
    <input id="workflow-title" autocomplete="off">
    <label for="workflow-body">Article body</label>
    <textarea id="workflow-body"></textarea>
    <label for="workflow-category">Category</label>
    <select id="workflow-category">
      <option value="engineering">Engineering</option>
      <option value="research">Research</option>
      <option value="design">Design</option>
    </select>
    <div>
      <button id="workflow-add-section" type="button">Add section</button>
      <button id="workflow-save" type="button">Save draft</button>
    </div>
    <div id="workflow-sections" aria-live="polite"></div>
    <output id="workflow-result" aria-live="polite">Draft not saved</output>
    <div id="workflow-catalog" aria-label="Large result catalog"></div>
  </main>
  <div id="shadow-host"></div>
  <iframe id="frame" srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;&lt;input id=&quot;frame-input&quot; aria-label=&quot;Frame input&quot;&gt;&lt;button id=&quot;frame-button&quot;&gt;Frame click&lt;/button&gt;&lt;select id=&quot;frame-select&quot;&gt;&lt;option value=&quot;one&quot;&gt;One&lt;/option&gt;&lt;option value=&quot;two&quot;&gt;Two&lt;/option&gt;&lt;/select&gt;&lt;input id=&quot;frame-file&quot; type=&quot;file&quot;&gt;&lt;script&gt;document.getElementById(&quot;frame-input&quot;).addEventListener(&quot;input&quot;, function () { parent.postMessage({type: &quot;frame-value&quot;, value: this.value}, &quot;*&quot;); }); document.getElementById(&quot;frame-button&quot;).addEventListener(&quot;click&quot;, function () { parent.postMessage({type: &quot;frame-click&quot;}, &quot;*&quot;); }); document.getElementById(&quot;frame-select&quot;).addEventListener(&quot;change&quot;, function () { parent.postMessage({type: &quot;frame-select&quot;, value: this.value}, &quot;*&quot;); }); document.getElementById(&quot;frame-file&quot;).addEventListener(&quot;change&quot;, function () { parent.postMessage({type: &quot;frame-file&quot;, count: this.files.length}, &quot;*&quot;); });&lt;/script&gt;&lt;/body&gt;&lt;/html&gt;"></iframe>
  <script>
    window.__shadowClicks = 0;
    window.__frameValue = '';
    window.__frameClicks = 0;
    window.__frameSelect = '';
    window.__frameFileCount = 0;
    const shadowRoot = document.getElementById('shadow-host').attachShadow({mode: 'open'});
    shadowRoot.innerHTML = '<button id="shadow-btn">Shadow click</button><label>Shadow input<input id="shadow-input"></label><select id="shadow-kind"><option value="alpha">Alpha</option><option value="beta">Beta</option></select>';
    shadowRoot.getElementById('shadow-btn').addEventListener('click', () => { window.__shadowClicks += 1; });
    window.addEventListener('message', event => { if (event.data && event.data.type === 'frame-value') window.__frameValue = event.data.value; if (event.data && event.data.type === 'frame-click') window.__frameClicks += 1; if (event.data && event.data.type === 'frame-select') window.__frameSelect = event.data.value; if (event.data && event.data.type === 'frame-file') window.__frameFileCount = event.data.count; });
    const catalog = document.getElementById('workflow-catalog');
    catalog.innerHTML = Array.from({length: 150}, (_, index) =>
      '<div class="catalog-row" data-row="' + index + '"><span>' + index +
      '</span><span>Benchmark catalog item ' + index + '</span><button type="button">Inspect ' +
      index + '</button></div>').join('');
    let workflowSectionCount = 0;
    document.getElementById('workflow-add-section').addEventListener('click', () => {
      workflowSectionCount += 1;
      const label = document.createElement('label');
      label.textContent = 'Section ' + workflowSectionCount;
      const textarea = document.createElement('textarea');
      textarea.className = 'section-body';
      textarea.setAttribute('aria-label', 'Section ' + workflowSectionCount);
      label.appendChild(textarea);
      document.getElementById('workflow-sections').appendChild(label);
    });
    document.getElementById('workflow-category').addEventListener('change', event => {
      catalog.dataset.category = event.target.value;
      catalog.prepend(...Array.from(catalog.children).reverse());
    });
    document.getElementById('workflow-save').addEventListener('click', () => {
      const title = document.getElementById('workflow-title').value;
      const body = document.getElementById('workflow-body').value;
      const category = document.getElementById('workflow-category').value;
      const sections = document.querySelectorAll('.section-body');
      const sectionText = Array.from(sections).map(node => node.value).join('|');
      const result = document.getElementById('workflow-result');
      result.dataset.saved = 'true';
      result.textContent = 'Saved ' + title + ' | ' + body.length + ' chars | ' +
        category + ' | ' + sections.length + ' sections | ' + sectionText;
    });
    document.getElementById('btn').addEventListener('click', () => {
      document.getElementById('status').textContent = 'clicked:' + document.getElementById('q').value;
    });
    document.getElementById('log').addEventListener('click', () => console.log('bridge fixture console message'));
    document.getElementById('fetch').addEventListener('click', () => fetch('/data.json?secret=redact-me'));
    document.getElementById('alert').addEventListener('click', () => alert('hello dialog'));
  </script>
</body>
</html>
"""


class UnsupportedAdapter(RuntimeError):
    pass

class BrowserRssLimitExceeded(RuntimeError):
    pass

BROWSER_PROCESS_MARKERS = (
    "Google Chrome for Testing.app/",
    "chrome-mac-arm64/Google Chrome for Testing",
    "chrome-headless-shell",
    "Chromium.app/",
)
DEFAULT_BROWSER_RSS_LIMIT_MB = 4096


def browser_rss_mb_from_ps(ps_output):
    total_kb = 0
    for line in ps_output.splitlines():
        if not any(marker in line for marker in BROWSER_PROCESS_MARKERS):
            continue
        fields = line.split(None, 2)
        if len(fields) < 2 or not fields[1].isdigit():
            continue
        total_kb += int(fields[1])
    return (total_kb + 1023) // 1024


def current_browser_rss_mb():
    override = os.environ.get("CHROME_BRIDGE_BENCHMARK_PS_OUTPUT")
    if override is not None:
        return browser_rss_mb_from_ps(override)
    proc = subprocess.run(
        ["ps", "-axo", "pid,rss,args"],
        text=True,
        capture_output=True,
        timeout=5,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"could not sample browser RSS: {proc.stderr.strip() or proc.stdout.strip()}")
    return browser_rss_mb_from_ps(proc.stdout)


def enforce_browser_rss_limit(limit_mb, ps_output=None):
    if limit_mb <= 0:
        return
    rss_mb = browser_rss_mb_from_ps(ps_output) if ps_output is not None else current_browser_rss_mb()
    if rss_mb > limit_mb:
        raise BrowserRssLimitExceeded(f"browser RSS {rss_mb} MB exceeds limit {limit_mb} MB")


def chrome_for_testing_executable():
    candidates = [
        Path("/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    ]
    for root in [
        Path.home() / "Library" / "Caches" / "ms-playwright",
        Path.home() / ".cache" / "puppeteer" / "chrome",
    ]:
        if root.exists():
            candidates.extend(sorted(root.glob("**/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")))
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/data.json"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(FIXTURE_PAGE)

    def log_message(self, format, *args):
        pass


def start_fixture_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{port}/"


def calculate_median(values):
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    if n % 2 == 1:
        return float(sorted_vals[n // 2])
    return float((sorted_vals[n // 2 - 1] + sorted_vals[n // 2]) / 2.0)


def get_bridge_command():
    token_file = os.environ.get("BRIDGE_TOKEN_FILE", SCRIPT_DIR / "bridge_token.txt")
    if not BRIDGE_COMMAND and not Path(token_file).exists():
        raise RuntimeError(
            "Missing bridge token. Run ./setup.sh <extension-id> first, set BRIDGE_TOKEN_FILE, "
            "or set CHROME_BRIDGE_CLIENT=chrome-bridge to use an installed launcher."
        )
    return [BRIDGE_COMMAND] if BRIDGE_COMMAND else [sys.executable, str(CLIENT)]


def _load_bridge_token():
    token_file = os.environ.get("BRIDGE_TOKEN_FILE", str(SCRIPT_DIR / "bridge_token.txt"))
    with open(token_file) as f:
        return f.read().strip()


# Maps the harness's CLI-style verbs to (bridge action, payload-builder). This
# mirrors test_client.py's argument handling so an in-process socket client can
# speak the bridge protocol directly, without spawning python3 per operation.
def _build_bridge_payload(verb, args):
    if verb == "ping":
        return "ping", {}
    if verb == "navigate":
        payload = {"url": args[0]}
        if BENCHMARK_QUIET:
            payload["active"] = False
        return "navigate", payload
    if verb == "createTaskSession":
        return "createTaskSession", {"name": args[0]}
    if verb == "navigateTaskSession":
        return "navigateTaskSession", {
            "sessionId": args[0],
            "url": args[1],
            "active": False,
            "reuse": True,
        }
    if verb == "closeTaskSession":
        return "closeTaskSession", {"sessionId": args[0]}
    if verb == "observe":
        payload = {"tabId": int(args[0]), "compact": True}
        if len(args) > 1 and args[1] == "diff":
            payload["diff"] = True
        return "observe", payload
    if verb == "waitForLoad":
        return "waitForLoad", {"tabId": int(args[0]), "timeoutMs": int(args[1])}
    if verb == "waitForSelector":
        return "waitForSelector", {"tabId": int(args[0]), "selector": args[1], "timeoutMs": int(args[2])}
    if verb == "waitForText":
        return "waitForText", {"tabId": int(args[0]), "text": args[1], "timeoutMs": int(args[2])}
    if verb == "click":
        return "click", {"tabId": int(args[0]), "selector": args[1]}
    if verb == "fill":
        return "fill", {"tabId": int(args[0]), "selector": args[1], "text": args[2]}
    if verb == "select":
        return "select", {"tabId": int(args[0]), "selector": args[1], "value": args[2]}
    if verb == "uploadFile":
        return "uploadFile", {"tabId": int(args[0]), "selector": args[1], "files": [os.path.abspath(p) for p in args[2:]]}
    if verb == "screenshot":
        payload = {"tabId": int(args[0]), "format": "png"}
        if BENCHMARK_QUIET:
            payload["quiet"] = True
        return "screenshot", payload
    if verb == "extractText":
        return "extractText", {"tabId": int(args[0]), "maxChars": int(args[1])}
    if verb == "getHTML":
        return "getHTML", {"tabId": int(args[0])}
    if verb == "executeScriptCDP":
        return "executeScriptCDP", {"tabId": int(args[0]), "code": args[1]}
    if verb == "getCurrentState":
        return "getCurrentState", {"tabId": int(args[0])}
    if verb == "storageState":
        return "storageState", {"tabId": int(args[0])}
    if verb == "setGeolocation":
        accuracy = float(args[3]) if len(args) > 3 else None
        return "setGeolocation", {"tabId": int(args[0]), "latitude": float(args[1]), "longitude": float(args[2]), "accuracy": accuracy}
    if verb == "clearGeolocation":
        return "clearGeolocation", {"tabId": int(args[0])}
    if verb in {"performanceMetrics", "closeTab", "startMonitoring", "stopMonitoring", "consoleMessages", "networkRequests"}:
        return verb, {"tabId": int(args[0])}
    if verb == "handleDialog":
        return "handleDialog", {"tabId": int(args[0]), "accept": args[1] == "accept", "promptText": args[2] if len(args) > 2 else None}
    if verb == "batch":
        payload = {"steps": json.loads(args[0])}
        if len(args) > 1:
            payload["tabId"] = int(args[1])
        return "batch", payload
    raise ValueError(f"Unmapped bridge verb: {verb}")


class BridgeClient:
    """Persistent in-process bridge client.

    Holds one keep-alive TCP connection to the native host and reuses it for
    every request, eliminating the per-operation python3 subprocess spawn and
    TCP handshake that dominated Chrome Bridge latency.
    """

    def __init__(self, timeout=20):
        self._token = _load_bridge_token()
        self._port = int(os.environ.get("BRIDGE_PORT", 9223))
        self._timeout = timeout
        self._sock = None
        self._buffer = b""
        self.connections = 0
        self.requests = 0
        self.reconnects = 0
        self.bytes_sent = 0
        self.bytes_received = 0

    def _connect(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(self._timeout)
        sock.connect(("127.0.0.1", self._port))
        self._sock = sock
        self.connections += 1
        self._buffer = b""

    def _recv_line(self):
        while b"\n" not in self._buffer:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise ConnectionError("bridge closed the connection")
            self.bytes_received += len(chunk)
            self._buffer += chunk
        line, self._buffer = self._buffer.split(b"\n", 1)
        return line

    def request(self, action, payload):
        cmd = json.dumps({"action": action, "payload": payload, "token": self._token}) + "\n"
        self.requests += 1
        # One transparent reconnect: the host may have idled the socket shut.
        for attempt in range(2):
            try:
                if self._sock is None:
                    self._connect()
                self._sock.sendall(cmd.encode("utf-8"))
                self.bytes_sent += len(cmd)
                line = self._recv_line()
                return json.loads(line.decode("utf-8"))
            except (OSError, ConnectionError) as exc:
                self.close()
                if attempt == 1:
                    raise RuntimeError(f"bridge request failed: {exc}")
                self.reconnects += 1
        raise RuntimeError("bridge request failed")

    def close(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
            self._buffer = b""


# Lazily-created shared client so run_chrome_bridge_op need not change shape.
_bridge_client = None


def get_bridge_client():
    global _bridge_client
    if _bridge_client is None:
        _bridge_client = BridgeClient()
    return _bridge_client


def reset_bridge_client():
    global _bridge_client
    if _bridge_client is not None:
        _bridge_client.close()
        _bridge_client = None


def run_bridge_cmd(*args, timeout=20):
    # If an external launcher is configured, preserve the subprocess path so
    # CHROME_BRIDGE_CLIENT still works; otherwise use the persistent client.
    if BRIDGE_COMMAND:
        proc = subprocess.run([BRIDGE_COMMAND, *map(str, args)], text=True, capture_output=True, timeout=timeout)
        parsed = None
        if proc.stdout:
            try:
                parsed = json.loads(proc.stdout)
            except Exception:
                pass
        return {"exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr, "json": parsed}

    verb = args[0]
    rest = [str(a) for a in args[1:]]
    try:
        action, payload = _build_bridge_payload(verb, rest)
        response = get_bridge_client().request(action, payload)
    except Exception as exc:
        return {"exit": 1, "stdout": "", "stderr": str(exc), "json": None}
    exit_code = 0 if response.get("success") is True else 1
    result = response.get("result")
    if isinstance(result, dict) and result.get("success") is False:
        exit_code = 1
    return {"exit": exit_code, "stdout": json.dumps(response), "stderr": "", "json": response}


def get_result(call):
    data = call.get("json") or {}
    return data.get("result") if data.get("result") is not None else data

def monitored_items(call):
    result = get_result(call)
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        for key in ("messages", "requests", "events"):
            value = result.get(key)
            if isinstance(value, list):
                return value
    return []


def monitored_item_count(call):
    result = get_result(call)
    if isinstance(result, dict):
        count = result.get("count")
        if isinstance(count, int):
            return count
    return len(monitored_items(call))


def sanitize_error(message):
    text = str(message)
    text = text.replace(str(SCRIPT_DIR), "<repo>")
    home = str(Path.home())
    if home:
        text = text.replace(home, "~")
    return text


def mark_all(results, capability, reason):
    sanitized = sanitize_error(reason)
    for op in OPERATIONS:
        results[op]["capability"] = capability
        results[op]["errors"].append(sanitized)


def finish_results(adapter, iterations, results):
    operations = []
    for op in OPERATIONS:
        durations = results[op]["durationsMs"]
        operations.append(
            {
                "name": op,
                "capability": results[op]["capability"],
                "durationsMs": durations,
                "medianMs": calculate_median(durations),
                "errors": results[op]["errors"],
            }
        )
    return {
        "schemaVersion": 1,
        "adapter": adapter,
        "iterations": iterations,
        "quiet": BENCHMARK_QUIET,
        "operations": operations,
        "comparison": COMPARISON_METADATA,
        "scorecard": build_scorecard(adapter, operations),
    }

RUNTIME_IDENTITY_FILES = (
    "benchmark_harness.py",
    "bridge.py",
    "broker.py",
    "test_client.py",
    "background.js",
    "mcp/chrome_bridge_mcp/transport.py",
    "mcp/chrome_bridge_mcp/server.py",
)


def _runtime_hash():
    digest = hashlib.sha256()
    for relative in RUNTIME_IDENTITY_FILES:
        path = SCRIPT_DIR / relative
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _git_output(*args):
    try:
        proc = subprocess.run(
            ["git", "-C", str(SCRIPT_DIR), *args],
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def _artifact_path(path):
    resolved = Path(path).resolve()
    try:
        return str(resolved.relative_to(SCRIPT_DIR))
    except ValueError:
        return sanitize_error(resolved)


def build_run_metadata(args, started_at, duration_ms):
    status = _git_output("status", "--porcelain", "--untracked-files=no")
    return {
        "runId": args.run_id or uuid.uuid4().hex,
        "startedAt": started_at,
        "sourceHash": _git_output("rev-parse", "HEAD") or "unknown",
        "sourceDirty": bool(status),
        "builtHash": _runtime_hash(),
        "buildMode": "python-source+unpacked-extension",
        "buildReuse": False,
        "scenario": args.scenario,
        "adapter": args.adapter,
        "iterations": args.iterations,
        "warmups": args.warmups,
        "timeoutSeconds": args.timeout_seconds,
        "artifactPath": _artifact_path(args.output),
        "durationMs": round(duration_ms, 3),
        "machine": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "browser": os.environ.get("CHROME_BRIDGE_BROWSER_VERSION", "unknown"),
        },
        "claimBoundary": "end-to-end local browser workflow",
    }


def _require_bridge_result(response, action):
    if not isinstance(response, dict) or response.get("success") is not True:
        error = response.get("error") if isinstance(response, dict) else response
        raise RuntimeError(f"{action} failed: {error or 'no successful response'}")
    result = response.get("result")
    if isinstance(result, dict) and result.get("success") is False:
        raise RuntimeError(f"{action} failed: {result.get('err') or result.get('error') or 'extension error'}")
    return result


def _timed_request(step_timings, action, payload):
    started = time.perf_counter()
    result = _require_bridge_result(get_bridge_client().request(action, payload), action)
    step_timings.append({"name": action, "durationMs": round((time.perf_counter() - started) * 1000, 3)})
    return result

def _timed_navigation_settle(step_timings):
    started = time.perf_counter()
    time.sleep(0.2)
    step_timings.append({
        "name": "navigationSettle",
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    })


def _snapshot_nodes(snapshot, key=None):
    if isinstance(snapshot, list):
        return snapshot
    if not isinstance(snapshot, dict):
        return []
    if key and isinstance(snapshot.get(key), list):
        return snapshot[key]
    for candidate in ("nodes", "added"):
        if isinstance(snapshot.get(candidate), list):
            return snapshot[candidate]
    return []


def _find_ref(snapshot, role, name, key=None):
    for node in _snapshot_nodes(snapshot, key=key):
        if not isinstance(node, dict):
            continue
        if str(node.get("role", "")).lower() == role.lower() and node.get("name") == name:
            ref = node.get("ref")
            if ref:
                return f"ref={ref}"
    raise RuntimeError(f"observe did not return ref for {role} {name!r}")


def _transport_counters():
    client = get_bridge_client()
    return {
        "requests": client.requests,
        "connections": client.connections,
        "reconnects": client.reconnects,
        "bytesSent": client.bytes_sent,
        "bytesReceived": client.bytes_received,
    }


def _counter_delta(before, after):
    return {key: after[key] - before[key] for key in before}


def _run_primitive_workflow(base_url, timeout_ms):
    timings = []
    before = _transport_counters()
    tab_id = None
    started = time.perf_counter()
    try:
        navigation = _timed_request(timings, "navigate", {"url": base_url, "active": False})
        tab_id = navigation["tabId"]
        _timed_navigation_settle(timings)
        _timed_request(timings, "waitForSelector", {
            "tabId": tab_id, "selector": "#workflow-title", "timeoutMs": timeout_ms,
        })
        _timed_request(timings, "fill", {
            "tabId": tab_id, "selector": "#workflow-title", "text": "Benchmark Article",
        })
        _timed_request(timings, "fill", {
            "tabId": tab_id,
            "selector": "#workflow-body",
            "text": "A repeatable multi-field article workflow with deterministic content.",
        })
        _timed_request(timings, "select", {
            "tabId": tab_id, "selector": "#workflow-category", "value": "research",
        })
        _timed_request(timings, "click", {"tabId": tab_id, "selector": "#workflow-add-section"})
        _timed_request(timings, "waitForSelector", {
            "tabId": tab_id, "selector": ".section-body", "timeoutMs": timeout_ms,
        })
        _timed_request(timings, "fill", {
            "tabId": tab_id, "selector": ".section-body", "text": "Measured section",
        })
        _timed_request(timings, "click", {"tabId": tab_id, "selector": "#workflow-save"})
        _timed_request(timings, "waitForText", {
            "tabId": tab_id, "text": "Saved Benchmark Article", "timeoutMs": timeout_ms,
        })
        extracted = _timed_request(timings, "extractText", {"tabId": tab_id, "maxChars": 4000})
        text = extracted.get("text", "") if isinstance(extracted, dict) else str(extracted or "")
        if "Saved Benchmark Article" not in text or "Measured section" not in text:
            raise RuntimeError("primitive workflow verification text was incomplete")
    finally:
        if tab_id is not None:
            with contextlib_suppress():
                _timed_request(timings, "closeTab", {"tabId": tab_id})
    after = _transport_counters()
    return {
        "success": True,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
        "steps": timings,
        "transport": _counter_delta(before, after),
    }


def _run_task_batch_workflow(base_url, timeout_ms):
    timings = []
    before = _transport_counters()
    session_id = None
    started = time.perf_counter()
    try:
        session = _timed_request(timings, "createTaskSession", {"name": "Complex workflow benchmark"})
        session_id = session["sessionId"]
        navigation = _timed_request(timings, "navigateTaskSession", {
            "sessionId": session_id, "url": base_url, "active": False, "reuse": True,
        })
        tab_id = navigation["tabId"]
        _timed_navigation_settle(timings)
        _timed_request(timings, "waitForSelector", {
            "tabId": tab_id, "selector": "#workflow-title", "timeoutMs": timeout_ms,
        })
        snapshot_options = {
            "tabId": tab_id,
            "compact": True,
            "roles": ["textbox", "combobox", "button"],
            "limit": 100,
        }
        snapshot = _timed_request(timings, "observe", snapshot_options)
        title_ref = _find_ref(snapshot, "textbox", "Article title")
        body_ref = _find_ref(snapshot, "textbox", "Article body")
        category_ref = _find_ref(snapshot, "combobox", "Category")
        add_ref = _find_ref(snapshot, "button", "Add section")
        save_ref = _find_ref(snapshot, "button", "Save draft")
        first_steps = [
            {"action": "fill", "payload": {"selector": title_ref, "text": "Benchmark Article"}},
            {
                "action": "fill",
                "payload": {
                    "selector": body_ref,
                    "text": "A repeatable multi-field article workflow with deterministic content.",
                },
            },
            {"action": "select", "payload": {"selector": category_ref, "value": "research"}},
            {"action": "click", "payload": {"selector": add_ref}},
            {
                "action": "waitForSelector",
                "timeoutMs": timeout_ms,
                "payload": {"selector": ".section-body"},
            },
        ]
        _timed_request(timings, "batch", {
            "tabId": tab_id, "steps": first_steps, "stopOnError": True,
        })
        diff = _timed_request(timings, "observe", {**snapshot_options, "diff": True})
        section_ref = _find_ref(diff, "textbox", "Section 1", key="added")
        second_steps = [
            {"action": "fill", "payload": {"selector": section_ref, "text": "Measured section"}},
            {"action": "click", "payload": {"selector": save_ref}},
            {
                "action": "waitForText",
                "timeoutMs": timeout_ms,
                "payload": {"text": "Saved Benchmark Article"},
            },
        ]
        _timed_request(timings, "batch", {
            "tabId": tab_id, "steps": second_steps, "stopOnError": True,
        })
        extracted = _timed_request(timings, "extractText", {"tabId": tab_id, "maxChars": 4000})
        text = extracted.get("text", "") if isinstance(extracted, dict) else str(extracted or "")
        if "Saved Benchmark Article" not in text or "Measured section" not in text:
            raise RuntimeError("task-batch workflow verification text was incomplete")
    finally:
        if session_id is not None:
            with contextlib_suppress():
                _timed_request(timings, "closeTaskSession", {"sessionId": session_id})
    after = _transport_counters()
    return {
        "success": True,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
        "steps": timings,
        "transport": _counter_delta(before, after),
    }


def _workflow_summary(mode, cold, warmups, measured):
    durations = [run["durationMs"] for run in measured]
    requests = [run["transport"]["requests"] for run in measured]
    return {
        "mode": mode,
        "cold": cold,
        "discardedWarmups": warmups,
        "warm": measured,
        "warmMedianMs": calculate_median(durations),
        "warmMedianRequests": calculate_median(requests),
        "coldDefinition": "first workflow after benchmark process start",
        "warmDefinition": "measured workflows after the cold run and discarded warmups",
    }


def run_complex_workflow(args, base_url):
    runner = _run_primitive_workflow if args.workflow_mode == "primitive" else _run_task_batch_workflow
    timeout_ms = int(args.timeout_seconds * 1000)
    if args.iterations <= 0:
        return _workflow_summary(args.workflow_mode, None, [], [])
    cold = runner(base_url, timeout_ms)
    discarded = [runner(base_url, timeout_ms) for _ in range(args.warmups)]
    measured = [runner(base_url, timeout_ms) for _ in range(args.iterations)]
    return _workflow_summary(args.workflow_mode, cold, discarded, measured)


def _unused_local_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def run_broker_diagnostic(args):
    frontend_port = _unused_local_port()
    backend_port = _unused_local_port()
    with tempfile.TemporaryDirectory(prefix="bridge-broker-benchmark-") as tmp:
        env = os.environ.copy()
        env.update({
            "BRIDGE_BROKER_PORT": str(frontend_port),
            "BRIDGE_BACKEND_PORT": str(backend_port),
            "BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS": "45",
            "BRIDGE_BROKER_LOG_FILE": str(Path(tmp) / "broker.log"),
            "BRIDGE_PORT": str(frontend_port),
            "BRIDGE_CONNECT_TIMEOUT_SECONDS": "1",
        })
        broker = subprocess.Popen(
            [sys.executable, str(SCRIPT_DIR / "broker.py")],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    probe = socket.create_connection(("127.0.0.1", frontend_port), timeout=0.1)
                    probe.close()
                    break
                except OSError:
                    time.sleep(0.05)
            started = time.perf_counter()
            proc = subprocess.run(
                [sys.executable, str(CLIENT), "ping"],
                env=env,
                text=True,
                capture_output=True,
                timeout=args.timeout_seconds,
                check=False,
            )
            duration_ms = (time.perf_counter() - started) * 1000
            combined = f"{proc.stdout}\n{proc.stderr}"
            classification = (
                "browser_unavailable"
                if "browser unavailable" in combined or "backend unavailable" in combined
                else "client_timeout"
                if "timed out waiting" in combined
                else "other"
            )
            return {
                "durationMs": round(duration_ms, 3),
                "exitCode": proc.returncode,
                "classification": classification,
                "expectedBackendWaitSeconds": 45,
                "clientTimeoutSeconds": 15,
            }
        finally:
            broker.terminate()
            with contextlib_suppress():
                broker.wait(timeout=3)
            if broker.poll() is None:
                broker.kill()


def record_op(results, op_name, capability, duration_ms, error=None):
    results[op_name]["durationsMs"].append(duration_ms)
    if capability != "pass":
        results[op_name]["capability"] = capability
    if error:
        results[op_name]["errors"].append(sanitize_error(error))


def run_chrome_bridge_op(op_name, context, base_url):
    t0 = time.perf_counter()
    tab_id = context.get("tab_id")
    if op_name == "ping":
        res = run_bridge_cmd("ping")
        if res["exit"] == 0 and get_result(res) == "pong":
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("ping failed")
    if op_name == "navigate":
        res = run_bridge_cmd("navigate", base_url, "--background") if BENCHMARK_QUIET else run_bridge_cmd("navigate", base_url)
        nav = get_result(res) or {}
        if res["exit"] == 0 and nav.get("tabId") is not None:
            context["tab_id"] = nav["tabId"]
            duration_ms = (time.perf_counter() - t0) * 1000
            time.sleep(0.1)
            return "pass", duration_ms
        raise RuntimeError("navigate failed")
    if tab_id is None:
        raise RuntimeError("no active tab")
    if op_name == "wait-load":
        res = run_bridge_cmd("waitForLoad", tab_id, 10000)
    elif op_name == "wait-selector":
        res = run_bridge_cmd("waitForSelector", tab_id, "#q", 10000)
    elif op_name == "click":
        res = run_bridge_cmd("click", tab_id, "#btn")
    elif op_name == "fill":
        res = run_bridge_cmd("fill", tab_id, "#q", "hello")
    elif op_name == "select":
        res = run_bridge_cmd("select", tab_id, "#kind", "beta")
    elif op_name == "upload":
        with tempfile.NamedTemporaryFile(prefix="upload-", suffix=".txt", delete=False) as f:
            f.write(b"upload fixture\n")
            temp_path = f.name
        try:
            res = run_bridge_cmd("uploadFile", tab_id, "#file", temp_path)
        finally:
            with contextlib_suppress():
                os.unlink(temp_path)
    elif op_name == "screenshot":
        with tempfile.NamedTemporaryFile(prefix="shot-", suffix=".png", delete=False) as f:
            temp_path = f.name
        try:
            res = run_bridge_cmd("screenshot", tab_id, temp_path, "--quiet") if BENCHMARK_QUIET else run_bridge_cmd("screenshot", tab_id, temp_path)
        finally:
            with contextlib_suppress():
                os.unlink(temp_path)
    elif op_name == "extract-text":
        res = run_bridge_cmd("extractText", tab_id, 2000)
    elif op_name == "get-html":
        with tempfile.NamedTemporaryFile(prefix="html-", suffix=".html", delete=False) as f:
            temp_path = f.name
        try:
            res = run_bridge_cmd("getHTML", tab_id, temp_path)
        finally:
            with contextlib_suppress():
                os.unlink(temp_path)
    elif op_name == "observe-state":
        res = run_bridge_cmd("getCurrentState", tab_id)
    elif op_name == "shadow-dom-click":
        res = run_bridge_cmd("click", tab_id, "#shadow-host >>> #shadow-btn")
        if res["exit"] != 0:
            raise RuntimeError("shadow-dom-click failed")
        verify = run_bridge_cmd("executeScriptCDP", tab_id, "window.__shadowClicks >= 1")
        if verify["exit"] == 0 and (get_result(verify) or {}).get("val") is True:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("shadow-dom-click did not update window.__shadowClicks")
    elif op_name == "iframe-fill":
        res = run_bridge_cmd("fill", tab_id, "frame=#frame >> #frame-input", "framed")
        if res["exit"] != 0:
            raise RuntimeError("iframe-fill failed")
        verify = run_bridge_cmd("executeScriptCDP", tab_id, "window.__frameValue === 'framed'")
        if verify["exit"] != 0 or (get_result(verify) or {}).get("val") is not True:
            raise RuntimeError("iframe-fill did not update window.__frameValue")
        click = run_bridge_cmd("click", tab_id, "frame=#frame >> #frame-button")
        if click["exit"] != 0:
            raise RuntimeError("iframe frame-button click failed")
        click_verify = run_bridge_cmd("executeScriptCDP", tab_id, "window.__frameClicks >= 1")
        if click_verify["exit"] == 0 and (get_result(click_verify) or {}).get("val") is True:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("iframe frame-button click did not update window.__frameClicks")
    elif op_name == "role-click":
        unique = "role-click-bridge"
        seed = run_bridge_cmd("fill", tab_id, "#q", unique)
        if seed["exit"] != 0:
            raise RuntimeError("role-click setup failed")
        res = run_bridge_cmd("click", tab_id, "role=button[name=Click me]")
        if res["exit"] != 0:
            raise RuntimeError("role-click failed")
        verify = run_bridge_cmd("executeScriptCDP", tab_id, f"document.querySelector('#status').textContent === 'clicked:{unique}'")
        if verify["exit"] == 0 and (get_result(verify) or {}).get("val") is True:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("role-click did not update status with seeded value")
    elif op_name == "label-fill":
        res = run_bridge_cmd("fill", tab_id, "label=Search query", "by-label")
        if res["exit"] != 0:
            raise RuntimeError("label-fill failed")
        verify = run_bridge_cmd("executeScriptCDP", tab_id, "document.querySelector('#q').value === 'by-label'")
        if verify["exit"] == 0 and (get_result(verify) or {}).get("val") is True:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("label-fill did not update #q")
    elif op_name == "text-click":
        before = run_bridge_cmd("executeScriptCDP", tab_id, "window.__frameClicks")
        before_count = ((get_result(before) or {}).get("val") or 0) if before["exit"] == 0 else 0
        res = run_bridge_cmd("click", tab_id, "frame=#frame >> text=Frame click")
        if res["exit"] != 0:
            raise RuntimeError("text-click failed")
        verify = run_bridge_cmd("executeScriptCDP", tab_id, f"window.__frameClicks === {before_count + 1}")
        if verify["exit"] == 0 and (get_result(verify) or {}).get("val") is True:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("text-click did not update frame clicks once")
    elif op_name == "frame-select":
        res = run_bridge_cmd("select", tab_id, "frame=#frame >> #frame-select", "two")
        if res["exit"] != 0:
            raise RuntimeError("frame-select failed")
        verify = run_bridge_cmd("executeScriptCDP", tab_id, "window.__frameSelect === 'two'")
        if verify["exit"] == 0 and (get_result(verify) or {}).get("val") is True:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("frame-select did not update window.__frameSelect")
    elif op_name == "frame-upload":
        with tempfile.NamedTemporaryFile(prefix="frame-upload-", suffix=".txt", delete=False) as f:
            f.write(b"frame upload fixture\n")
            temp_path = f.name
        try:
            res = run_bridge_cmd("uploadFile", tab_id, "frame=#frame >> #frame-file", temp_path)
        finally:
            with contextlib_suppress():
                os.unlink(temp_path)
        if res["exit"] != 0:
            raise RuntimeError("frame-upload failed")
        verify = run_bridge_cmd("executeScriptCDP", tab_id, "window.__frameFileCount === 1")
        if verify["exit"] == 0 and (get_result(verify) or {}).get("val") is True:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("frame-upload did not update window.__frameFileCount")
    elif op_name == "shadow-fill":
        res = run_bridge_cmd("fill", tab_id, "#shadow-host >>> #shadow-input", "shadowed")
        if res["exit"] != 0:
            raise RuntimeError("shadow-fill failed")
        verify = run_bridge_cmd("executeScriptCDP", tab_id, "document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-input').value === 'shadowed'")
        if verify["exit"] == 0 and (get_result(verify) or {}).get("val") is True:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("shadow-fill did not update shadow input")
    elif op_name == "console-monitoring":
        start = run_bridge_cmd("startMonitoring", tab_id)
        if start["exit"] != 0:
            raise RuntimeError("console-monitoring start failed")
        res = run_bridge_cmd("click", tab_id, "#log")
        if res["exit"] != 0:
            raise RuntimeError("console-monitoring click failed")
        time.sleep(0.1)
        messages = run_bridge_cmd("consoleMessages", tab_id)
        if messages["exit"] == 0 and monitored_item_count(messages) >= 1:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("console-monitoring captured no messages")
    elif op_name == "network-monitoring":
        start = run_bridge_cmd("startMonitoring", tab_id)
        if start["exit"] != 0:
            raise RuntimeError("network-monitoring start failed")
        before = run_bridge_cmd("networkRequests", tab_id)
        before_count = monitored_item_count(before) if before["exit"] == 0 else 0
        res = run_bridge_cmd("click", tab_id, "#fetch")
        if res["exit"] != 0:
            raise RuntimeError("network-monitoring click failed")
        time.sleep(0.1)
        requests = run_bridge_cmd("networkRequests", tab_id)
        after_count = monitored_item_count(requests)
        request_items = monitored_items(requests)
        has_unredacted_query = any("secret=redact-me" in item.get("url", "") for item in request_items if isinstance(item, dict))
        if requests["exit"] == 0 and after_count > before_count and not has_unredacted_query:
            return "pass", (time.perf_counter() - t0) * 1000
        raise RuntimeError("network-monitoring captured no new redacted requests")
    elif op_name == "dialog-handling":
        scheduled = run_bridge_cmd("executeScriptCDP", tab_id, "setTimeout(() => alert('hello dialog'), 0); 'scheduled'")
        if scheduled["exit"] != 0:
            raise RuntimeError("dialog-handling schedule failed")
        time.sleep(0.1)
        res = run_bridge_cmd("handleDialog", tab_id, "accept")
    elif op_name == "storage-state":
        with tempfile.NamedTemporaryFile(prefix="state-", suffix=".json", delete=False) as f:
            temp_path = f.name
        try:
            res = run_bridge_cmd("storageState", tab_id, temp_path)
        finally:
            with contextlib_suppress():
                os.unlink(temp_path)
    elif op_name == "geolocation":
        res = run_bridge_cmd("setGeolocation", tab_id, 37.7749, -122.4194, 100)
        run_bridge_cmd("clearGeolocation", tab_id)
    elif op_name == "performance-metrics":
        res = run_bridge_cmd("performanceMetrics", tab_id)
    else:
        raise ValueError(f"Unknown operation: {op_name}")
    if res["exit"] == 0:
        return "pass", (time.perf_counter() - t0) * 1000
    raise RuntimeError(f"{op_name} failed")


class contextlib_suppress:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return True


def run_noop(results):
    for op in OPERATIONS:
        t0 = time.perf_counter()
        value = 0
        for i in range(1000):
            value += i
        time.sleep(0.0001)
        record_op(results, op, "pass", (time.perf_counter() - t0) * 1000.0)


def run_chrome_bridge_iteration(results, base_url):
    context = {"tab_id": None}
    try:
        for op in OPERATIONS:
            try:
                capability, duration = run_chrome_bridge_op(op, context, base_url)
                record_op(results, op, capability, duration)
            except UnsupportedAdapter as exc:
                record_op(results, op, "unsupported", 0.0, exc)
            except Exception as exc:
                record_op(results, op, "fail", 0.0, exc)
    finally:
        if context.get("tab_id") is not None:
            with contextlib_suppress():
                run_bridge_cmd("closeTab", context["tab_id"])


def run_playwright_iteration(results, state, base_url):
    page = state["browser"].new_page(geolocation={"latitude": 37.7749, "longitude": -122.4194})
    page.context.grant_permissions(["geolocation"])
    console_messages = []
    requests = []
    page.on("console", lambda msg: console_messages.append(msg.text))
    page.on("request", lambda req: requests.append(req.url))
    try:
        for op in OPERATIONS:
            enforce_browser_rss_limit(state.get("browser_rss_limit_mb", DEFAULT_BROWSER_RSS_LIMIT_MB))
            t0 = time.perf_counter()
            try:
                if op == "ping":
                    page.evaluate("1 + 1")
                elif op == "navigate":
                    page.goto(base_url, wait_until="domcontentloaded")
                elif op == "wait-load":
                    page.wait_for_load_state("load")
                elif op == "wait-selector":
                    page.wait_for_selector("#q")
                elif op == "click":
                    page.click("#btn")
                elif op == "fill":
                    page.fill("#q", "hello")
                elif op == "select":
                    page.select_option("#kind", "beta")
                elif op == "upload":
                    with tempfile.NamedTemporaryFile(prefix="upload-", suffix=".txt", delete=False) as f:
                        f.write(b"upload fixture\n")
                        temp_path = f.name
                    try:
                        page.set_input_files("#file", temp_path)
                    finally:
                        with contextlib_suppress():
                            os.unlink(temp_path)
                elif op == "screenshot":
                    page.screenshot()
                elif op == "extract-text":
                    page.locator("body").inner_text()
                elif op == "get-html":
                    page.content()
                elif op == "observe-state":
                    page.locator("body").inner_text()
                elif op == "shadow-dom-click":
                    page.locator("#shadow-btn").click()
                    clicks = page.evaluate("window.__shadowClicks")
                    if clicks < 1:
                        raise RuntimeError("shadow click did not register")
                elif op == "iframe-fill":
                    page.frame_locator("#frame").locator("#frame-input").fill("framed")
                    page.wait_for_function("window.__frameValue === 'framed'")
                elif op == "role-click":
                    page.get_by_label("Search query").fill("role-click-playwright")
                    page.get_by_role("button", name="Click me").click()
                    page.wait_for_function("document.querySelector('#status').textContent === 'clicked:role-click-playwright'")
                elif op == "label-fill":
                    page.get_by_label("Search query").fill("by-label")
                    page.wait_for_function("document.querySelector('#q').value === 'by-label'")
                elif op == "text-click":
                    before = page.evaluate("window.__frameClicks")
                    page.frame_locator("#frame").get_by_text("Frame click", exact=True).click()
                    page.wait_for_function(f"window.__frameClicks === {before + 1}")
                elif op == "frame-select":
                    page.frame_locator("#frame").locator("#frame-select").select_option("two")
                    page.wait_for_function("window.__frameSelect === 'two'")
                elif op == "frame-upload":
                    with tempfile.NamedTemporaryFile(prefix="frame-upload-", suffix=".txt", delete=False) as f:
                        f.write(b"frame upload fixture\n")
                        temp_path = f.name
                    try:
                        page.frame_locator("#frame").locator("#frame-file").set_input_files(temp_path)
                    finally:
                        with contextlib_suppress():
                            os.unlink(temp_path)
                    page.wait_for_function("window.__frameFileCount === 1")
                elif op == "shadow-fill":
                    page.locator("#shadow-host").evaluate("(host, value) => { const input = host.shadowRoot.querySelector('#shadow-input'); input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); }", "shadowed")
                    page.wait_for_function("document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-input').value === 'shadowed'")
                elif op == "console-monitoring":
                    page.click("#log")
                    page.wait_for_timeout(50)
                    if not console_messages:
                        raise RuntimeError("no console messages captured")
                elif op == "network-monitoring":
                    before = len(requests)
                    page.click("#fetch")
                    page.wait_for_timeout(50)
                    if len(requests) <= before:
                        raise RuntimeError("no network requests captured")
                elif op == "dialog-handling":
                    page.once("dialog", lambda dialog: dialog.accept())
                    page.click("#alert")
                elif op == "storage-state":
                    page.context.storage_state()
                elif op == "geolocation":
                    latitude = page.evaluate(
                        "new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition("
                        "pos => resolve(pos.coords.latitude), err => reject(new Error(err.message)), {timeout: 1000}))"
                    )
                    if abs(float(latitude) - 37.7749) > 0.01:
                        raise RuntimeError(f"unexpected latitude {latitude}")
                elif op == "performance-metrics":
                    page.evaluate("JSON.stringify(performance.timing)")
                else:
                    raise UnsupportedAdapter(f"unsupported operation {op}")
                record_op(results, op, "pass", (time.perf_counter() - t0) * 1000)
            except UnsupportedAdapter as exc:
                record_op(results, op, "unsupported", (time.perf_counter() - t0) * 1000, exc)
            except Exception as exc:
                record_op(results, op, "fail", (time.perf_counter() - t0) * 1000, exc)
    finally:
        page.close()


def run_playwright(args, results, base_url):
    if args.iterations == 0:
        return
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        mark_all(results, "unsupported", f"Playwright Python is not installed: {exc}")
        return
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            state = {"browser": browser, "browser_rss_limit_mb": args.browser_rss_limit_mb}
            try:
                for _ in range(args.iterations):
                    run_playwright_iteration(results, state, base_url)
            finally:
                browser.close()
    except BrowserRssLimitExceeded:
        raise
    except Exception as exc:
        mark_all(results, "unsupported", f"Playwright browser launch failed: {exc}")


def puppeteer_script():
    return r'''
import fs from 'node:fs';
const baseUrl = process.argv[2];
const iterations = Number(process.argv[3]);
const output = process.argv[4];
const operations = JSON.parse(process.argv[5]);
function median(values) { return 0; }
function createResults() {
  const results = {};
  for (const op of operations) results[op] = {capability: 'pass', durationsMs: [], errors: []};
  return results;
}
function record(results, op, capability, started, error) {
  results[op].durationsMs.push(Number(process.hrtime.bigint() - started) / 1000000);
  if (capability !== 'pass') results[op].capability = capability;
  if (error) results[op].errors.push(String(error && error.message ? error.message : error));
}
const results = createResults();
let puppeteer;
try {
  puppeteer = (await import('puppeteer')).default;
} catch (error) {
  for (const op of operations) {
    results[op].capability = 'unsupported';
    results[op].errors.push(`Puppeteer is not installed: ${error.message}`);
  }
  fs.writeFileSync(output, JSON.stringify(results));
  process.exit(0);
}
let browser;
try {
  try {
    browser = await puppeteer.launch({headless: 'new'});
  } catch (launchError) {
    // Bundled Chrome may be absent; fall back to the system Chrome stable
    // channel (this is also how chrome-devtools-mcp launches Chrome).
    browser = await puppeteer.launch({channel: 'chrome', headless: 'new'});
  }
  await browser.defaultBrowserContext().overridePermissions(baseUrl, ['geolocation']);
  for (let i = 0; i < iterations; i++) {
    const page = await browser.newPage();
    const consoleMessages = [];
    const requests = [];
    page.on('console', msg => consoleMessages.push(msg.text()));
    page.on('request', req => requests.push(req.url()));
    await page.setGeolocation({latitude: 37.7749, longitude: -122.4194});
    for (const op of operations) {
      const started = process.hrtime.bigint();
      try {
        if (op === 'ping') await page.evaluate(() => 1 + 1);
        else if (op === 'navigate') await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
        else if (op === 'wait-load') await page.waitForFunction(() => document.readyState === 'complete');
        else if (op === 'wait-selector') await page.waitForSelector('#q');
        else if (op === 'click') await page.click('#btn');
        else if (op === 'fill') await page.$eval('#q', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', {bubbles: true})); }, 'hello');
        else if (op === 'select') await page.select('#kind', 'beta');
        else if (op === 'upload') {
          const tmp = `/tmp/chrome-bridge-puppeteer-upload-${Date.now()}-${i}.txt`;
          fs.writeFileSync(tmp, 'upload fixture\n');
          const handle = await page.$('#file');
          await handle.uploadFile(tmp);
          fs.unlinkSync(tmp);
        }
        else if (op === 'screenshot') await page.screenshot();
        else if (op === 'extract-text') await page.$eval('body', el => el.innerText);
        else if (op === 'get-html') await page.content();
        else if (op === 'observe-state') await page.$eval('body', el => el.innerText);
        else if (op === 'shadow-dom-click') { const clicked = await page.$eval('#shadow-host', host => { const btn = host.shadowRoot && host.shadowRoot.querySelector('#shadow-btn'); if (!btn) throw new Error('shadow button missing'); btn.click(); return window.__shadowClicks; }); if (clicked < 1) throw new Error('shadow click did not register'); }
        else if (op === 'iframe-fill') { const frameHandle = await page.$('#frame'); const frame = await frameHandle.contentFrame(); await frame.$eval('#frame-input', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', {bubbles: true})); }, 'framed'); await page.waitForFunction(() => window.__frameValue === 'framed'); }
        else if (op === 'role-click') { await page.$eval('#q', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', {bubbles: true})); }, 'role-click-puppeteer'); await page.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Click me'); if (!btn) throw new Error('role button missing'); btn.click(); }); await page.waitForFunction(() => document.querySelector('#status').textContent === 'clicked:role-click-puppeteer'); }
        else if (op === 'label-fill') { await page.$eval('#q', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', {bubbles: true})); }, 'by-label'); await page.waitForFunction(() => document.querySelector('#q').value === 'by-label'); }
        else if (op === 'text-click') { const before = await page.evaluate(() => window.__frameClicks); const frameHandle = await page.$('#frame'); const frame = await frameHandle.contentFrame(); await frame.evaluate(() => { const btn = [...document.querySelectorAll('*')].find(el => el.textContent.trim() === 'Frame click'); if (!btn) throw new Error('frame text target missing'); btn.click(); }); await page.waitForFunction(expected => window.__frameClicks === expected, {}, before + 1); }
        else if (op === 'frame-select') { const frameHandle = await page.$('#frame'); const frame = await frameHandle.contentFrame(); await frame.select('#frame-select', 'two'); await page.waitForFunction(() => window.__frameSelect === 'two'); }
        else if (op === 'frame-upload') { const tmp = `/tmp/chrome-bridge-puppeteer-frame-upload-${Date.now()}-${i}.txt`; fs.writeFileSync(tmp, 'frame upload fixture\n'); const frameHandle = await page.$('#frame'); const frame = await frameHandle.contentFrame(); const input = await frame.$('#frame-file'); await input.uploadFile(tmp); fs.unlinkSync(tmp); await page.waitForFunction(() => window.__frameFileCount === 1); }
        else if (op === 'shadow-fill') { await page.$eval('#shadow-host', (host, value) => { const input = host.shadowRoot.querySelector('#shadow-input'); if (!input) throw new Error('shadow input missing'); input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); }, 'shadowed'); await page.waitForFunction(() => document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-input').value === 'shadowed'); }
        else if (op === 'console-monitoring') { await page.click('#log'); await new Promise(r => setTimeout(r, 50)); if (!consoleMessages.length) throw new Error('no console messages captured'); }
        else if (op === 'network-monitoring') { const before = requests.length; await page.click('#fetch'); await new Promise(r => setTimeout(r, 50)); if (requests.length <= before) throw new Error('no network requests captured'); }
        else if (op === 'dialog-handling') { page.once('dialog', dialog => dialog.accept()); await page.click('#alert'); }
        else if (op === 'storage-state') await page.cookies();
        else if (op === 'geolocation') { const latitude = await page.evaluate(() => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(pos => resolve(pos.coords.latitude), err => reject(new Error(err.message)), {timeout: 1000}))); if (Math.abs(Number(latitude) - 37.7749) > 0.01) throw new Error(`unexpected latitude ${latitude}`); }
        else if (op === 'performance-metrics') await page.metrics();
        else { const error = new Error(`unsupported operation ${op}`); error.unsupported = true; throw error; }
        record(results, op, 'pass', started);
      } catch (error) {
        record(results, op, error && error.unsupported ? 'unsupported' : 'fail', started, error);
      }
    }
    await page.close();
  }
} catch (error) {
  for (const op of operations) {
    results[op].capability = 'unsupported';
    results[op].errors.push(`Puppeteer browser launch failed: ${error.message}`);
  }
} finally {
  if (browser) await browser.close();
}
fs.writeFileSync(output, JSON.stringify(results));
'''


def npm_root():
    if not shutil.which("npm"):
        return None
    proc = subprocess.run(["npm", "root"], cwd=SCRIPT_DIR, text=True, capture_output=True, timeout=10)
    if proc.returncode != 0:
        return None
    root = proc.stdout.strip()
    return root if root else None


def run_puppeteer_runner(args, results, base_url, runner_name, temp_prefix):
    if args.iterations == 0:
        return
    if not shutil.which("node"):
        mark_all(results, "unsupported", "node executable is not available")
        return
    with tempfile.TemporaryDirectory(prefix=temp_prefix, dir=SCRIPT_DIR) as tmp:
        script_path = Path(tmp) / "bench.mjs"
        output_path = Path(tmp) / "results.json"
        script_path.write_text(puppeteer_script(), encoding="utf-8")
        env = os.environ.copy()
        root = npm_root()
        if root:
            env["NODE_PATH"] = root if not env.get("NODE_PATH") else f"{root}{os.pathsep}{env['NODE_PATH']}"
        proc = subprocess.Popen(
            ["node", str(script_path), base_url, str(args.iterations), str(output_path), json.dumps(OPERATIONS)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        deadline = time.monotonic() + max(30, args.iterations * 20)
        while proc.poll() is None:
            if time.monotonic() > deadline:
                proc.kill()
                stdout, stderr = proc.communicate()
                raise subprocess.TimeoutExpired(proc.args, max(30, args.iterations * 20), output=stdout, stderr=stderr)
            try:
                enforce_browser_rss_limit(args.browser_rss_limit_mb)
            except BrowserRssLimitExceeded:
                proc.terminate()
                with contextlib_suppress():
                    proc.wait(timeout=5)
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                raise
            time.sleep(0.5)
        proc_stdout, proc_stderr = proc.communicate()
        if proc.returncode != 0:
            mark_all(results, "unsupported", f"{runner_name} runner failed: {proc_stderr.strip() or proc_stdout.strip()}")
            return
        payload = json.loads(output_path.read_text(encoding="utf-8"))
        for op in OPERATIONS:
            item = payload.get(op, {})
            results[op]["capability"] = item.get("capability", "unsupported")
            results[op]["durationsMs"].extend(item.get("durationsMs", []))
            results[op]["errors"].extend(sanitize_error(error) for error in item.get("errors", []))


def run_puppeteer(args, results, base_url):
    run_puppeteer_runner(args, results, base_url, "Puppeteer", ".chrome-bridge-puppeteer-")


def _cdt_mcp_text(result):
    parts = []
    for item in getattr(result, "content", []) or []:
        if hasattr(item, "text"):
            parts.append(item.text)
        elif hasattr(item, "model_dump_json"):
            parts.append(item.model_dump_json())
        else:
            parts.append(str(item))
    if not parts and hasattr(result, "structuredContent"):
        parts.append(json.dumps(getattr(result, "structuredContent")))
    return "\n".join(parts)


async def _cdt_mcp_call(session, name, arguments=None):
    result = await session.call_tool(name, arguments or {})
    if getattr(result, "isError", False):
        detail = _cdt_mcp_text(result) or "tool returned an error"
        raise RuntimeError(f"{name} failed: {detail}")
    return result


def _cdt_mcp_uid_from_snapshot(snapshot, needles):
    uid_patterns = [
        r"\buid[=:]\s*[\"']?([^\"'\]\s,}]+)",
        r"\[uid=[\"']?([^\"'\]]+)[\"']?\]",
        r"\buid\s+[\"']([^\"']+)[\"']",
    ]
    lines = snapshot.splitlines()
    lowered_needles = [needle.lower() for needle in needles]
    for line in lines:
        haystack = line.lower()
        if not any(needle in haystack for needle in lowered_needles):
            continue
        for pattern in uid_patterns:
            match = re.search(pattern, line)
            if match:
                return match.group(1).rstrip(".,")
    for index, line in enumerate(lines):
        haystack = line.lower()
        if not any(needle in haystack for needle in lowered_needles):
            continue
        nearby = "\n".join(lines[index: index + 2])
        for pattern in uid_patterns:
            match = re.search(pattern, nearby)
            if match:
                return match.group(1).rstrip(".,")
    return None


async def _cdt_mcp_snapshot(session):
    return _cdt_mcp_text(await _cdt_mcp_call(session, "take_snapshot"))


async def _cdt_mcp_uid(session, *needles):
    snapshot = await _cdt_mcp_snapshot(session)
    uid = _cdt_mcp_uid_from_snapshot(snapshot, needles)
    if not uid:
        raise UnsupportedAdapter(f"could not find uid for {', '.join(needles)} in take_snapshot output")
    return uid


async def _run_chrome_devtools_mcp_op(session, context, op_name, base_url):
    if op_name == "ping":
        await _cdt_mcp_call(session, "list_pages")
    elif op_name == "navigate":
        if context.get("page_opened"):
            await _cdt_mcp_call(session, "navigate_page", {"url": base_url})
        else:
            await _cdt_mcp_call(session, "new_page", {"url": base_url})
            context["page_opened"] = True
    elif op_name == "wait-load":
        await _cdt_mcp_call(session, "wait_for", {"text": ["Benchmark Fixture"]})
    elif op_name == "wait-selector":
        await _cdt_mcp_call(session, "wait_for", {"text": ["ready"]})
    elif op_name == "click":
        uid = await _cdt_mcp_uid(session, "Click me")
        await _cdt_mcp_call(session, "click", {"uid": uid})
    elif op_name == "fill":
        uid = await _cdt_mcp_uid(session, "textbox", "input")
        await _cdt_mcp_call(session, "fill", {"uid": uid, "value": "hello"})
    elif op_name == "select":
        uid = await _cdt_mcp_uid(session, "combobox", "select", "Alpha", "Beta")
        try:
            await _cdt_mcp_call(session, "fill", {"uid": uid, "value": "Beta"})
        except Exception as exc:
            raise UnsupportedAdapter(f"select via fill is unsupported: {exc}") from exc
    elif op_name == "upload":
        uid = await _cdt_mcp_uid(session, "file")
        with tempfile.NamedTemporaryFile(prefix="upload-", suffix=".txt", delete=False) as f:
            f.write(b"upload fixture\n")
            temp_path = f.name
        try:
            await _cdt_mcp_call(session, "upload_file", {"uid": uid, "filePath": temp_path})
        finally:
            with contextlib_suppress():
                os.unlink(temp_path)
    elif op_name == "screenshot":
        await _cdt_mcp_call(session, "take_screenshot")
    elif op_name == "extract-text":
        snapshot = await _cdt_mcp_snapshot(session)
        if "Benchmark Fixture" not in snapshot:
            raise RuntimeError("snapshot did not include fixture text")
    elif op_name == "get-html":
        await _cdt_mcp_call(session, "evaluate_script", {"function": "() => document.documentElement.outerHTML"})
    elif op_name == "observe-state":
        await _cdt_mcp_call(session, "take_snapshot")
    elif op_name == "shadow-dom-click":
        uid = await _cdt_mcp_uid(session, "Shadow click")
        await _cdt_mcp_call(session, "click", {"uid": uid})
        result = await _cdt_mcp_call(session, "evaluate_script", {"function": "() => window.__shadowClicks"})
        if "1" not in _cdt_mcp_text(result):
            raise UnsupportedAdapter("shadow click UID did not update page state")
    elif op_name == "iframe-fill":
        uid = await _cdt_mcp_uid(session, "Frame input")
        await _cdt_mcp_call(session, "fill", {"uid": uid, "value": "framed"})
        result = await _cdt_mcp_call(session, "evaluate_script", {"function": "() => window.__frameValue"})
        if "framed" not in _cdt_mcp_text(result):
            raise UnsupportedAdapter("iframe fill UID did not update page state")
    elif op_name in {"role-click", "label-fill", "text-click", "frame-select", "frame-upload", "shadow-fill"}:
        raise UnsupportedAdapter(f"chrome-devtools-mcp adapter does not expose reliable {op_name} semantics")
    elif op_name == "console-monitoring":
        await _cdt_mcp_call(
            session,
            "evaluate_script",
            {"function": "() => new Promise(resolve => { document.querySelector('#log').click(); setTimeout(resolve, 100); })"},
        )
        messages = _cdt_mcp_text(await _cdt_mcp_call(session, "list_console_messages"))
        if "bridge fixture console message" not in messages:
            raise RuntimeError("no console messages captured")
    elif op_name == "network-monitoring":
        await _cdt_mcp_call(
            session,
            "evaluate_script",
            {"function": "() => new Promise(resolve => { document.querySelector('#fetch').click(); setTimeout(resolve, 100); })"},
        )
        requests = _cdt_mcp_text(await _cdt_mcp_call(session, "list_network_requests"))
        if "data.json" not in requests:
            raise RuntimeError("no network requests captured")
    elif op_name == "dialog-handling":
        await _cdt_mcp_call(
            session,
            "evaluate_script",
            {"function": "() => { setTimeout(() => alert('hello dialog'), 0); return 'scheduled'; }"},
        )
        await _cdt_mcp_call(session, "handle_dialog", {"action": "accept"})
    elif op_name == "storage-state":
        await _cdt_mcp_call(
            session,
            "evaluate_script",
            {"function": "() => ({cookies: document.cookie, localStorage: {...localStorage}, sessionStorage: {...sessionStorage}})"},
        )
    elif op_name == "geolocation":
        try:
            await _cdt_mcp_call(session, "emulate", {"geolocation": "37.7749,-122.4194"})
        except Exception as exc:
            raise UnsupportedAdapter(f"emulate geolocation is unsupported: {exc}") from exc
        await _cdt_mcp_call(session, "evaluate_script", {"function": "() => Boolean(navigator.geolocation)"})
    elif op_name == "performance-metrics":
        await _cdt_mcp_call(session, "evaluate_script", {"function": "() => JSON.stringify(performance.timing)"})
    else:
        raise UnsupportedAdapter(f"unsupported operation {op_name}")


async def _run_chrome_devtools_mcp_async(args, results, base_url):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    base_args = ["-y", "chrome-devtools-mcp@1.2.0", "--headless=true", "--isolated=true"]
    if args.browser_rss_limit_mb > 0:
        # Pin to Chrome for Testing so the RSS guard counts this adapter's browser.
        executable_path = chrome_for_testing_executable()
        if not executable_path:
            raise UnsupportedAdapter("Chrome for Testing executable is not available for guarded Chrome DevTools MCP run")
        launch_args = base_args + ["--executablePath", executable_path]
    else:
        launch_args = base_args + ["--channel=stable"]
    server_params = StdioServerParameters(command="npx", args=launch_args)
    async with stdio_client(server_params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            context = {"page_opened": False}
            for _ in range(args.iterations):
                for op in OPERATIONS:
                    enforce_browser_rss_limit(args.browser_rss_limit_mb)
                    t0 = time.perf_counter()
                    try:
                        await _run_chrome_devtools_mcp_op(session, context, op, base_url)
                        record_op(results, op, "pass", (time.perf_counter() - t0) * 1000)
                    except UnsupportedAdapter as exc:
                        record_op(results, op, "unsupported", (time.perf_counter() - t0) * 1000, exc)
                    except Exception as exc:
                        record_op(results, op, "fail", (time.perf_counter() - t0) * 1000, exc)
            if context.get("page_opened"):
                with contextlib_suppress():
                    await _cdt_mcp_call(session, "close_page")


def run_chrome_devtools_mcp(args, results, base_url):
    if args.iterations == 0:
        return
    if not shutil.which("node") or not shutil.which("npx"):
        mark_all(results, "unsupported", "node/npx executable is not available")
        return
    try:
        import asyncio
        import mcp  # noqa: F401
    except Exception as exc:
        mark_all(results, "unsupported", f"Python MCP SDK is not installed: {exc}")
        return
    try:
        asyncio.run(_run_chrome_devtools_mcp_async(args, results, base_url))
    except BrowserRssLimitExceeded:
        raise
    except Exception as exc:
        mark_all(results, "unsupported", f"Chrome DevTools MCP server launch failed: {exc}")


def score_from_median(operations):
    passed = [op for op in operations if op.get("capability") == "pass" and op.get("medianMs", 0) > 0]
    if not passed:
        return 0
    median = calculate_median([op["medianMs"] for op in passed])
    if median <= 50:
        return 5
    if median <= 100:
        return 4
    if median <= 250:
        return 3
    if median <= 500:
        return 2
    return 1


def build_scorecard(adapter, operations):
    scorecard = {}
    for key, tool in COMPARISON_METADATA["tools"].items():
        scores = dict(tool.get("scores", {}))
        if key == adapter or (adapter == "chrome-bridge" and key == "chrome-native-bridge"):
            scores["speed"] = score_from_median(operations)
            scores["capability"] = round(
                5 * sum(1 for op in operations if op.get("capability") == "pass") / max(1, len(operations)), 1
            )
            source = "measured"
        else:
            source = "metadata"
        overall = round((scores["speed"] + scores["capability"] + scores["authReuse"] + scores["ergonomics"]) / 4, 1)
        scorecard[key] = {**scores, "overall": overall, "source": source}
    return scorecard


def initial_results():
    return {op: {"capability": "pass", "durationsMs": [], "errors": []} for op in OPERATIONS}


def handle_run(args):
    global BENCHMARK_QUIET
    BENCHMARK_QUIET = bool(getattr(args, "quiet", False))
    for name, default in (
        ("scenario", "operations"),
        ("warmups", 0),
        ("workflow_mode", "task-batch"),
        ("timeout_seconds", 30),
        ("run_id", None),
    ):
        if not hasattr(args, name):
            setattr(args, name, default)
    started_clock = time.perf_counter()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    base_url = args.base_url
    server = None
    needs_fixture = args.scenario in {"operations", "complex-workflow"}
    if (
        needs_fixture
        and args.adapter in {"chrome-bridge", "playwright", "puppeteer", "chrome-devtools-mcp"}
        and args.iterations > 0
        and not base_url
    ):
        server, base_url = start_fixture_server()
    results = initial_results()
    try:
        if args.scenario == "complex-workflow":
            if args.adapter != "chrome-bridge":
                raise ValueError("complex-workflow currently requires --adapter chrome-bridge")
            output_data = {
                "schemaVersion": 2,
                "adapter": args.adapter,
                "scenario": args.scenario,
                "workflow": run_complex_workflow(args, base_url),
            }
        elif args.scenario == "broker-diagnostic":
            if args.adapter != "chrome-bridge":
                raise ValueError("broker-diagnostic requires --adapter chrome-bridge")
            output_data = {
                "schemaVersion": 2,
                "adapter": args.adapter,
                "scenario": args.scenario,
                "brokerDiagnostic": run_broker_diagnostic(args) if args.iterations > 0 else None,
            }
        elif args.scenario == "operations":
            if args.iterations > 0 and args.adapter in {"playwright", "puppeteer", "chrome-devtools-mcp"}:
                enforce_browser_rss_limit(args.browser_rss_limit_mb)
            if args.adapter == "noop":
                for _ in range(args.iterations):
                    run_noop(results)
            elif args.adapter == "chrome-bridge":
                for _ in range(args.iterations):
                    run_chrome_bridge_iteration(results, base_url)
            elif args.adapter == "playwright":
                run_playwright(args, results, base_url)
            elif args.adapter == "puppeteer":
                run_puppeteer(args, results, base_url)
                if args.iterations > 0:
                    enforce_browser_rss_limit(args.browser_rss_limit_mb)
            elif args.adapter == "chrome-devtools-mcp":
                run_chrome_devtools_mcp(args, results, base_url)
                if args.iterations > 0:
                    enforce_browser_rss_limit(args.browser_rss_limit_mb)
            else:
                raise ValueError(f"Unknown adapter: {args.adapter}")
            output_data = finish_results(args.adapter, args.iterations, results)
            output_data["scenario"] = args.scenario
        else:
            raise ValueError(f"Unknown scenario: {args.scenario}")
        duration_ms = (time.perf_counter() - started_clock) * 1000
        output_data["run"] = build_run_metadata(args, started_at, duration_ms)
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(output_data, indent=2), encoding="utf-8")
        print(f"Benchmark results successfully written to {args.output}")
    finally:
        reset_bridge_client()
        if server:
            server.shutdown()
            server.server_close()


def _load_compare_inputs(paths):
    by_adapter = {}
    for raw in paths:
        input_path = Path(raw)
        if not input_path.is_file():
            print(f"Error: input file {raw} does not exist", file=sys.stderr)
            sys.exit(1)
        data = json.loads(input_path.read_text(encoding="utf-8"))
        adapter = data.get("adapter", "unknown")
        if adapter in by_adapter:
            print(f"Error: duplicate benchmark adapter {adapter}", file=sys.stderr)
            sys.exit(1)
        by_adapter[adapter] = data
    return by_adapter


def _scorecard_for_inputs(inputs):
    measured_keys = {"chrome-native-bridge" if adapter == "chrome-bridge" else adapter: data
                     for adapter, data in inputs.items()}
    scorecard = {}
    for key, tool in COMPARISON_METADATA["tools"].items():
        scores = dict(tool.get("scores", {}))
        data = measured_keys.get(key)
        if data is not None:
            operations = data.get("operations", [])
            scores["speed"] = score_from_median(operations)
            scores["capability"] = round(
                5 * sum(1 for op in operations if op.get("capability") == "pass") / max(1, len(operations)), 1
            )
            source = "measured"
        else:
            source = "metadata"
        overall = round((scores["speed"] + scores["capability"] + scores["authReuse"] + scores["ergonomics"]) / 4, 1)
        scorecard[key] = {**scores, "overall": overall, "source": source}
    for adapter, data in inputs.items():
        key = "chrome-native-bridge" if adapter == "chrome-bridge" else adapter
        if key in scorecard:
            continue
        operations = data.get("operations", [])
        capability = round(5 * sum(1 for op in operations if op.get("capability") == "pass") / max(1, len(operations)), 1)
        speed = score_from_median(operations)
        scorecard[key] = {"speed": speed, "capability": capability, "authReuse": "", "ergonomics": "", "overall": "", "source": "measured"}
    return scorecard

def write_junit_report(path, inputs):
    suite = ElementTree.Element("testsuite", {"name": "browser-automation-benchmark"})
    tests = 0
    failures = 0
    skipped = 0
    for adapter, data in inputs.items():
        for op in data.get("operations", []):
            tests += 1
            name = f"{adapter}.{op.get('name', 'unknown')}"
            attrs = {
                "name": name,
                "classname": adapter,
                "time": f"{float(op.get('medianMs') or 0) / 1000:.6f}",
            }
            testcase = ElementTree.SubElement(suite, "testcase", attrs)
            status = op.get("capability")
            message = "; ".join(str(error) for error in op.get("errors", []) if error)
            if status == "fail":
                failures += 1
                failure = ElementTree.SubElement(testcase, "failure", {"message": message or "benchmark operation failed"})
                failure.text = message
            elif status in {"unsupported", "manual"}:
                skipped += 1
                skipped_node = ElementTree.SubElement(testcase, "skipped", {"message": message or str(status)})
                skipped_node.text = message or str(status)
    suite.set("tests", str(tests))
    suite.set("failures", str(failures))
    suite.set("skipped", str(skipped))
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ElementTree.ElementTree(suite).write(output_path, encoding="unicode", xml_declaration=True)


def write_github_step_summary(path, report_lines):
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    summary_lines = list(report_lines)
    if summary_lines and summary_lines[0].startswith("# "):
        summary_lines[0] = "## Browser Automation Benchmark"
    with output_path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(summary_lines) + "\n")



def handle_compare(args):
    inputs = _load_compare_inputs(args.input)
    first = next(iter(inputs.values()))
    comparison = first.get("comparison", {})
    tools = dict(comparison.get("tools", {}))
    gaps = comparison.get("gaps", [])
    scorecard = _scorecard_for_inputs(inputs)

    for adapter in inputs:
        key = "chrome-native-bridge" if adapter == "chrome-bridge" else adapter
        tools.setdefault(key, {"name": adapter, "strengths": "Measured adapter supplied by input JSON.", "limits": "No static metadata available.", "capability_status": "measured-adapter"})

    adapters = list(inputs.keys())
    op_names = []
    for data in inputs.values():
        for op in data.get("operations", []):
            name = op.get("name", "")
            if name and name not in op_names:
                op_names.append(name)

    lines = [
        "# Browser Automation Benchmark Report",
        "",
        "This report separates measured benchmark rows from static capability metadata.",
        "",
        "## Run Configuration",
        f"- **Measured adapters:** {', '.join(f'`{a}`' for a in adapters)}",
        "",
        "## Claim Discipline",
        "Only rows marked measured support speed or capability claims. Metadata rows describe expected strengths and limits but are not benchmark evidence.",
        "",
        "## Operation Timings",
        "",
    ]
    header = ["Operation"]
    for adapter in adapters:
        header.extend([f"{adapter} status", f"{adapter} median ms"])
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join(["---"] + ["---", "---:"] * len(adapters)) + " |")
    op_maps = {adapter: {op.get("name"): op for op in data.get("operations", [])} for adapter, data in inputs.items()}
    for op_name in op_names:
        row = [op_name]
        for adapter in adapters:
            op = op_maps[adapter].get(op_name, {})
            row.extend([op.get("capability", ""), f"{op.get('medianMs', 0.0):.2f}" if op else ""])
        lines.append("| " + " | ".join(row) + " |")

    lines.extend(["", "## Normalized Scorecard", "Scores are 1-5. Source marks measured rows versus static metadata rows.", ""])
    lines.append("| Tool | Speed | Capability | Auth Reuse | Ergonomics | Overall | Source |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    for tool_key, tool_info in tools.items():
        scores = scorecard.get(tool_key, {})
        lines.append(
            f"| **{tool_info.get('name', tool_key)}** | {scores.get('speed', '')} | {scores.get('capability', '')} | "
            f"{scores.get('authReuse', '')} | {scores.get('ergonomics', '')} | {scores.get('overall', '')} | {scores.get('source', 'metadata')} |"
        )
    for key, scores in scorecard.items():
        if key not in tools:
            lines.append(f"| **{key}** | {scores.get('speed', '')} | {scores.get('capability', '')} |  |  |  | measured |")

    lines.extend(["", "## Tool Capability Comparison Matrix", "", "| Tool | Strengths | Limits | Status |", "| --- | --- | --- | --- |"])
    for tool_key, tool_info in tools.items():
        lines.append(
            f"| **{tool_info.get('name', tool_key)}** | {tool_info.get('strengths', '')} | "
            f"{tool_info.get('limits', '')} | {tool_info.get('capability_status', '')} |"
        )
    lines.extend(["", "## Gap Backlog", "Key gaps between Chrome Native Bridge and established platforms like Playwright:", ""])
    for gap_item in gaps:
        lines.append(f"- **{gap_item.get('gap', '').capitalize()}**: {gap_item.get('description', '')}")
    lines.extend(["", "## Gap Tickets", ""])
    primary_adapter = adapters[0] if adapters else "unknown"
    for idx, gap_item in enumerate(gaps, start=1):
        title = gap_item.get("gap", "gap").capitalize()
        ticket_id = gap_item.get("id") or f"BENCH-{idx:03d}"
        lines.append(f"### {ticket_id}: {title}")
        lines.append(f"- Benchmark signal: `{primary_adapter}` report currently tracks this as a gap against stronger surfaces.")
        lines.append(f"- Acceptance target: {gap_item.get('acceptance', 'Measured pass in benchmark harness.')}")
        lines.append(f"- Likely surface: {gap_item.get('surface', 'benchmark_harness.py')}")
        lines.append("")
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")
    if getattr(args, "junit_output", None):
        write_junit_report(args.junit_output, inputs)
        print(f"Benchmark JUnit report successfully written to {args.junit_output}")
    if getattr(args, "github_step_summary", None):
        write_github_step_summary(args.github_step_summary, lines)
        print(f"Benchmark GitHub step summary successfully written to {args.github_step_summary}")
    print(f"Benchmark report successfully written to {args.output}")


def _ps_full():
    proc = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,rss=,args="],
        text=True,
        capture_output=True,
        timeout=5,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"could not list processes: {proc.stderr.strip() or proc.stdout.strip()}")
    rows = []
    for line in proc.stdout.splitlines():
        fields = line.split(None, 4)
        if len(fields) < 5 or not fields[3].isdigit():
            continue
        pid, ppid, pgid, rss, args = fields
        rows.append((int(pid), int(ppid), int(pgid), int(rss), args))
    return rows


def find_stale_browser_trees(rows):
    """Return process group ids whose members are benchmark-launched browsers.

    Matches headless-shell / Chrome-for-Testing browser processes and the
    browser-gateway parents that supervise them, grouped by process group so a
    whole tree is recycled together. The user's normal Google Chrome profile is
    never matched because it is not part of BROWSER_PROCESS_MARKERS.
    """
    own_pgid = os.getpgrp()
    groups = {}
    for pid, ppid, pgid, rss, args in rows:
        groups.setdefault(pgid, []).append((pid, ppid, rss, args))
    stale = {}
    for pgid, members in groups.items():
        if pgid == own_pgid:
            continue
        # Require at least one benchmark-launched browser process in the group;
        # the whole tree (including any browser-gateway parent) is then recycled
        # together. The user's normal Chrome is never matched because it is not
        # in BROWSER_PROCESS_MARKERS.
        has_browser = any(
            any(marker in args for marker in BROWSER_PROCESS_MARKERS)
            for _, _, _, args in members
        )
        if has_browser:
            stale[pgid] = members
    return stale


def _terminate(pid, sig):
    try:
        os.kill(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as exc:
        print(f"permission denied for pid {pid}: {exc}", file=sys.stderr)
        return False


def _live_profile_paths(rows):
    """Temp profile dirs still referenced by a live process command line."""
    live = set()
    for _, _, _, _, args in rows:
        match = re.search(r"--user-data-dir=(\S+)", args)
        if match:
            live.add(match.group(1))
    return live


def find_orphan_profiles():
    """Leftover puppeteer temp profile dirs under the repo working tree."""
    return sorted(p for p in SCRIPT_DIR.glob(".chrome-bridge-puppeteer-*") if p.is_dir())


def handle_cleanup(args):
    rows = _ps_full()

    # --- Section 1: stale browser process trees ---
    stale = find_stale_browser_trees(rows)
    print("== Stale browser process trees ==")
    if not stale:
        print("  none")
    else:
        for pgid in sorted(stale):
            total_mb = sum(rss for _, _, rss, _ in stale[pgid]) // 1024
            print(f"  pgid={pgid} processes={len(stale[pgid])} rss={total_mb}MB")
            for pid, ppid, rss, cmd in sorted(stale[pgid]):
                print(f"    pid={pid} ppid={ppid} rss={rss // 1024}MB {cmd[:100]}")

    # --- Section 2: orphaned temp profile directories ---
    live_profiles = _live_profile_paths(rows)
    orphans = [p for p in find_orphan_profiles() if str(p) not in live_profiles]
    skipped = [p for p in find_orphan_profiles() if str(p) in live_profiles]
    print("== Orphaned temp profile directories ==")
    if not orphans:
        print("  none")
    else:
        for path in orphans:
            print(f"  {path}")
    for path in skipped:
        print(f"  (skipped, still in use) {path}")

    if not args.kill:
        print("Dry-run only. Re-run with --kill to recycle trees and delete orphan profiles.")
        return

    # Recycle process trees: SIGTERM the whole group, then SIGKILL survivors.
    target_pids = [pid for members in stale.values() for pid, _, _, _ in members]
    for pid in target_pids:
        _terminate(pid, signal.SIGTERM)
    if target_pids:
        time.sleep(max(args.wait, 0.0))
        remaining = {pid for pid, *_ in _ps_full()} & set(target_pids)
        for pid in sorted(remaining):
            _terminate(pid, signal.SIGKILL)
        time.sleep(0.5)
        remaining = {pid for pid, *_ in _ps_full()} & set(target_pids)
        recycled = [pid for pid in target_pids if pid not in remaining]
        print(f"Recycled {len(recycled)} process(es): {', '.join(map(str, recycled)) or 'none'}")
        if remaining:
            print(f"Still running: {', '.join(map(str, sorted(remaining)))}", file=sys.stderr)

    # Delete orphan profile dirs (re-checking live args right before removal).
    fresh_live = _live_profile_paths(_ps_full())
    deleted = 0
    for path in orphans:
        if str(path) in fresh_live:
            print(f"  (skipped, became active) {path}")
            continue
        shutil.rmtree(path, ignore_errors=True)
        deleted += 1
    print(f"Deleted {deleted} orphan profile director(ies).")

def main():
    parser = argparse.ArgumentParser(description="Browser Automation Benchmark Harness")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run", help="Run benchmarks")
    run_parser.add_argument(
        "--adapter",
        choices=["noop", "chrome-bridge", "playwright", "puppeteer", "chrome-devtools-mcp"],
        default="noop",
        help="Harness adapter to use",
    )
    run_parser.add_argument(
        "--scenario",
        choices=["operations", "complex-workflow", "broker-diagnostic"],
        default="operations",
        help="Benchmark scenario to run",
    )
    run_parser.add_argument("--iterations", type=int, default=2, help="Number of benchmark iterations")
    run_parser.add_argument("--warmups", type=int, default=1, help="Discarded warm workflow iterations")
    run_parser.add_argument(
        "--workflow-mode",
        choices=["primitive", "task-batch"],
        default="task-batch",
        help="Automation strategy for the complex-workflow scenario",
    )
    run_parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=30,
        help="Per-step and outer benchmark timeout",
    )
    run_parser.add_argument("--run-id", help="Stable run identifier; generated when omitted")
    run_parser.add_argument("--output", required=True, help="Path to write JSON results")
    run_parser.add_argument("--base-url", help="Base URL of target page for live benchmarking")
    run_parser.add_argument(
        "--browser-rss-limit-mb",
        type=int,
        default=DEFAULT_BROWSER_RSS_LIMIT_MB,
        help="Abort live adapter runs when matching browser process RSS exceeds this many MB; use 0 to disable",
    )
    run_parser.add_argument(
        "--quiet",
        action="store_true",
        help="Avoid avoidable focus changes for chrome-bridge by opening benchmark tabs inactive and using CDP screenshots",
    )
    compare_parser = subparsers.add_parser("compare", help="Compare benchmark results and generate report")
    compare_parser.add_argument("--input", action="append", required=True, help="Path to JSON results file; may be provided multiple times")
    compare_parser.add_argument("--output", required=True, help="Path to write markdown report")
    compare_parser.add_argument("--junit-output", help="Optional path to write a JUnit XML report")
    compare_parser.add_argument("--github-step-summary", help="Optional path to write a GitHub Step Summary markdown report")
    cleanup_parser = subparsers.add_parser("cleanup", help="Recycle stale benchmark browser trees and orphan temp profiles")
    cleanup_parser.add_argument("--kill", action="store_true", help="Recycle process trees and delete orphan profiles. Omitted by default (dry-run).")
    cleanup_parser.add_argument("--wait", type=float, default=3.0, help="Seconds to wait after SIGTERM before SIGKILL")
    args = parser.parse_args()
    if args.command == "run":
        handle_run(args)
    elif args.command == "compare":
        handle_compare(args)
    elif args.command == "cleanup":
        handle_cleanup(args)


if __name__ == "__main__":
    try:
        main()
    except BrowserRssLimitExceeded as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
