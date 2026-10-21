#!/usr/bin/env python3
"""Live end-to-end smoke for AgentTab challenge detection (ADR 0002).

Launches a disposable Chrome for Testing profile with the built extension and the
real host, enables the optional scripting permission through the popup, serves
local fixtures, and drives the Python SDK through the detection, act guard,
challenge_cleared wait, and handoff paths. Optionally measures the scan cost
(`--measure N`). Writes a JSON report and exits nonzero when any scenario fails.

Usage:
    bun run --cwd packages/extension build
    cargo build --manifest-path host-rs/Cargo.toml -p agenttab-host
    uv run --python 3.12 python scripts/challenge_live_smoke.py --chrome-binary \
        "/path/to/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

Vendor widgets load from the vendors' CDNs; their scenarios are reported as
`skipped` when the vendor script cannot load. macOS only, like
`background_reliability.py`, whose launch helpers this script reuses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "packages" / "sdk-python"))
sys.path.insert(0, str(REPO))

from agenttab import AgentTabClient  # noqa: E402
from background_reliability import LaunchedChrome, launch_isolated_chrome  # noqa: E402
from tests.architecture.verify_permissions import DevToolsSocket  # noqa: E402

SCHEMA = REPO / "schemas" / "rpc" / "v1" / "challenge.schema.json"
# Google's documented public reCAPTCHA v2 test key, not a credential.
RECAPTCHA_SITEKEY = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"  # gitleaks:allow
HCAPTCHA_SITEKEY = "10000000-ffff-ffff-ffff-000000000001"  # hCaptcha's public test key
CHALLENGE_ID_PATTERN = r"^chl_[0-9a-z]{20}$"
WARMUP_ITERATIONS = 3


# --------------------------------------------------------------------------- fixtures


def _vendor_page(script_url: str, widget: str, vendor: str) -> bytes:
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head>
<body>
<h1>Fixture</h1>
{widget}
<button id="outside" type="button"
  onclick="fetch('/__clicked?page={vendor}')">Outside</button>
<script>function beacon(s) {{ fetch('/__vendor?name={vendor}&state=' + s); }}</script>
<script src="{script_url}" async defer onload="beacon('loaded')" onerror="beacon('error')"></script>
</body></html>
""".encode()


PAGES: dict[str, bytes] = {
    "/clean": b"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Clean</title></head>
<body><h1>Clean</h1>
<button id="outside" type="button" onclick="fetch('/__clicked?page=clean')">Outside</button>
</body></html>
""",
    "/recaptcha": _vendor_page(
        "https://www.google.com/recaptcha/api.js",
        f'<div class="g-recaptcha" data-sitekey="{RECAPTCHA_SITEKEY}"></div>',
        "recaptcha",
    ),
    "/hcaptcha": _vendor_page(
        "https://js.hcaptcha.com/1/api.js",
        f'<div class="h-captcha" data-sitekey="{HCAPTCHA_SITEKEY}"></div>',
        "hcaptcha",
    ),
}
BLOCKED_BODY = b"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Blocked</title></head>
<body><h1>Blocked</h1>
<button id="outside" type="button" onclick="fetch('/__clicked?page=blocked')">Outside</button>
</body></html>
"""
# A Cloudflare-style gate that reloads itself once the fixture marks it solved, as a cleared challenge page does.
SOLVABLE_BODY = b"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Blocked</title></head>
<body><h1>Blocked</h1>
<script>setInterval(() => fetch('/__solved').then((r) => { if (r.status === 200) location.reload(); }), 250);</script>
</body></html>
"""


class Fixtures:
    """Threaded loopback HTTP server that also counts vendor beacons and button clicks."""

    def __init__(self) -> None:
        self.vendor_state: dict[str, str] = {}
        self.clicks: dict[str, int] = {}
        self.solved = False
        self.lock = threading.Lock()
        fixtures = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: object) -> None:
                return

            def _send(self, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                query = parse_qs(parsed.query)
                if parsed.path in PAGES:
                    self._send(200, PAGES[parsed.path])
                elif parsed.path == "/cf":
                    self._send(403, BLOCKED_BODY, {"cf-mitigated": "challenge"})
                elif parsed.path == "/limited":
                    self._send(429, BLOCKED_BODY, {"Retry-After": "30"})
                elif parsed.path == "/cf-solvable":
                    with fixtures.lock:
                        solved = fixtures.solved
                    if solved:
                        self._send(200, PAGES["/clean"])
                    else:
                        self._send(403, SOLVABLE_BODY, {"cf-mitigated": "challenge"})
                elif parsed.path == "/__solved":
                    with fixtures.lock:
                        solved = fixtures.solved
                    self._send(200 if solved else 204, b"")
                elif parsed.path == "/__vendor":
                    with fixtures.lock:
                        fixtures.vendor_state[query.get("name", [""])[0]] = query.get("state", [""])[0]
                    self._send(204, b"")
                elif parsed.path == "/__clicked":
                    with fixtures.lock:
                        page = query.get("page", [""])[0]
                        fixtures.clicks[page] = fixtures.clicks.get(page, 0) + 1
                    self._send(204, b"")
                else:
                    self._send(404, b"not found")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def url(self, path: str) -> str:
        return f"http://localhost:{self.port}{path}"

    def clicked(self, page: str) -> int:
        with self.lock:
            return self.clicks.get(page, 0)

    def vendor(self, name: str) -> str | None:
        with self.lock:
            return self.vendor_state.get(name)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


# --------------------------------------------------------------------------- browser


def devtools_port(launched: LaunchedChrome) -> int:
    return int((launched.profile / "DevToolsActivePort").read_text(encoding="utf-8").split()[0])


def devtools_json(launched: LaunchedChrome, path: str, method: str = "GET") -> Any:
    request = Request(
        f"http://127.0.0.1:{devtools_port(launched)}{path}",
        method=method,
        headers={"Accept": "application/json"},
    )
    with urlopen(request, timeout=launched.timeout_seconds) as response:
        body = response.read()
    try:
        return json.loads(body) if body else None
    except json.JSONDecodeError:
        return body.decode("utf-8", "replace")  # /json/close answers with plain text


def wait_for_browser(launched: LaunchedChrome, timeout_seconds: float) -> None:
    """Wait for a page target and the host socket using only the HTTP target list.

    `wait_for_launched_chrome` evaluates inside the service worker while it is still
    starting, which on a cold profile can leave every later evaluate failing; the
    host socket only exists once the worker is up and connected.
    """
    socket_file = Path(os.environ["AGENTTAB_STATE_DIR"]) / "run" / "agenttab.sock"
    deadline = time.monotonic() + timeout_seconds
    problem = "browser process not found"
    while time.monotonic() < deadline:
        try:
            targets = devtools_json(launched, "/json/list")
            worker = f"chrome-extension://{launched.extension_id}/"
            has_page = any(t.get("type") == "page" for t in targets)
            has_worker = any(t.get("type") == "service_worker" and str(t.get("url", "")).startswith(worker) for t in targets)
            if has_page and has_worker and socket_file.exists():
                return
            problem = f"page={has_page} worker={has_worker} socket={socket_file.exists()}"
        except (OSError, ValueError, IndexError) as error:
            problem = str(error)
        time.sleep(0.25)
    raise RuntimeError(f"launched Chrome was not ready within {timeout_seconds:g} seconds: {problem}")


def page_target(launched: LaunchedChrome, url: str) -> dict[str, Any]:
    for _ in range(40):
        for target in devtools_json(launched, "/json/list"):
            if target.get("type") == "page" and str(target.get("url", "")).startswith(url):
                return target
        time.sleep(0.25)
    raise RuntimeError("DevTools did not list the requested page target")


def evaluate(channel: DevToolsSocket, expression: str) -> Any:
    result = channel.command(
        "Runtime.evaluate",
        {"expression": expression, "awaitPromise": True, "returnByValue": True},
        "Runtime.evaluate",
    )
    if "exceptionDetails" in result:
        raise RuntimeError(f"Runtime.evaluate threw: {json.dumps(result['exceptionDetails'])[:300]}")
    return result.get("result", {}).get("value")


def grant_scripting(launched: LaunchedChrome, timeout_seconds: float) -> None:
    """Click the popup's enable control with trusted input so Chrome grants the optional permission."""
    popup_url = f"chrome-extension://{launched.extension_id}/popup.html"
    target = devtools_json(launched, f"/json/new?{popup_url}", "PUT")
    channel = DevToolsSocket(target["webSocketDebuggerUrl"], timeout_seconds)
    try:
        has_scripting = (
            "new Promise(r => chrome.permissions.contains({permissions: ['scripting']}, r))"
        )
        deadline = time.monotonic() + timeout_seconds
        while evaluate(channel, "document.readyState === 'complete' && typeof chrome.permissions === 'object'") is not True:
            if time.monotonic() >= deadline:
                raise RuntimeError("the popup page never became an extension page")
            time.sleep(0.25)
        if evaluate(channel, has_scripting) is True:
            return
        channel.command("Emulation.setFocusEmulationEnabled", {"enabled": True}, "focus emulation")
        rect: dict[str, float] | None = None
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            rect = evaluate(
                channel,
                "(() => { const b = document.getElementById('enable');"
                " if (!b || b.closest('[hidden]')) return null;"
                " const r = b.getBoundingClientRect();"
                " return r.width > 0 ? {x: r.x + r.width / 2, y: r.y + r.height / 2} : null; })()",
            )
            if rect:
                break
            time.sleep(0.25)
        if not rect:
            raise RuntimeError("the popup never showed the Enable automation control")
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            channel.command(
                "Input.dispatchMouseEvent",
                {
                    "type": kind,
                    "x": rect["x"],
                    "y": rect["y"],
                    "button": "left",
                    "buttons": 1 if kind == "mousePressed" else 0,
                    "clickCount": 1,
                },
                f"mouse {kind}",
            )
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if evaluate(channel, has_scripting) is True:
                return
            time.sleep(0.25)
        detail = evaluate(
            channel,
            "(() => { const e = document.getElementById('permission-error');"
            " return e && !e.hidden ? e.textContent : '(no popup error shown)'; })()",
        )
        raise RuntimeError(
            "scripting permission was not granted after the trusted click; "
            f"popup error: {detail}. A Chrome permission dialog may be pending"
        )
    finally:
        channel.close()
        try:
            devtools_json(launched, f"/json/close/{target['id']}")
        except OSError:
            pass


# --------------------------------------------------------------------------- harness


class Skip(Exception):
    """Raised by a scenario when a precondition outside AgentTab is unavailable."""


class Scenario:
    def __init__(self, name: str) -> None:
        self.name = name
        self.checks: list[dict[str, Any]] = []
        self.observed: dict[str, Any] = {}
        self.status = "pass"
        self.reason: str | None = None

    def check(self, label: str, ok: bool, observed: Any = None) -> bool:
        self.checks.append({"check": label, "ok": bool(ok), "observed": observed})
        if not ok:
            self.status = "fail"
        return bool(ok)

    def report(self) -> dict[str, Any]:
        return {
            "scenario": self.name,
            "status": self.status,
            **({"reason": self.reason} if self.reason else {}),
            "observed": self.observed,
            "checks": self.checks,
        }


def event_fields(event: Any) -> dict[str, Any] | None:
    """Key challenge fields only; never page content."""
    if not isinstance(event, dict):
        return None
    keys = (
        "challenge_id", "vendor", "product", "kind", "interaction", "state", "confidence",
        "next", "wait_budget_ms", "retry_after_ms", "notice_id", "token_present",
    )
    fields: dict[str, Any] = {key: event[key] for key in keys if key in event}
    surface = event.get("surface")
    if isinstance(surface, dict):
        fields["surface"] = {key: surface[key] for key in ("scope", "visible") if key in surface}
    probe = (event.get("detector") or {}).get("probe") if isinstance(event.get("detector"), dict) else None
    if probe:
        fields["probe"] = probe
    return fields


class Rpc:
    """Core RPC wrapper that returns `(ok, body)` and keeps every challenge event it sees."""

    def __init__(self, client: AgentTabClient) -> None:
        self.client = client
        self.events: list[dict[str, Any]] = []
        self.label = "setup"

    def call(self, method: str, params: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        """Return `{ok, outcome, result?, error?, challenge?}`."""
        response = self.client.request(method, params, timeout=timeout)
        if self.client.pending_resume_capability is not None:
            # The smoke never resumes this task, so it needs no durable store; confirming keeps the connection usable.
            self.client.confirm_resume_capability()
        ok = bool(response.get("ok"))
        body: dict[str, Any] = {"ok": ok, "outcome": response.get("outcome")}
        if ok:
            result = response.get("result")
            body["result"] = result if isinstance(result, dict) else {}
            event = body["result"].get("challenge")
        else:
            error = response.get("error")
            body["error"] = error if isinstance(error, dict) else {}
            details = body["error"].get("details")
            event = details.get("challenge") if isinstance(details, dict) else None
        if isinstance(event, dict):
            body["challenge"] = event
            self.events.append({"scenario": self.label, "method": method, "event": event})
        return body


def revision(body: dict[str, Any], default: int) -> int:
    value = body.get("result", {}).get("page_revision")
    return value if isinstance(value, int) else default


def error_code(body: dict[str, Any]) -> str | None:
    return body.get("error", {}).get("code") if not body["ok"] else None


def result_status(body: dict[str, Any]) -> Any:
    return body.get("result", {}).get("status")


class Smoke:
    def __init__(self, rpc: Rpc, fixtures: Fixtures, launched: LaunchedChrome, args: argparse.Namespace) -> None:
        self.rpc = rpc
        self.fixtures = fixtures
        self.launched = launched
        self.args = args
        self.scenarios: list[Scenario] = []
        self.measurements: dict[str, Any] | None = None
        self.schema_report: dict[str, Any] | None = None

    # -- helpers

    def open_tab(self, path: str) -> tuple[int, int, dict[str, Any]]:
        body = self.rpc.call("browser_open", {"mode": "create", "url": self.fixtures.url(path), "background": True})
        if not body["ok"]:
            raise RuntimeError(f"browser_open {path} failed: {error_code(body)}")
        result = body["result"]
        return result["tab_id"], result["page_revision"], body

    def snapshot(self, tab_id: int, mode: str = "accessibility") -> dict[str, Any]:
        return self.rpc.call("browser_snapshot", {"tab_id": tab_id, "mode": mode})

    def poll_challenge(self, tab_id: int, timeout: float = 25.0) -> dict[str, Any] | None:
        """Snapshot until a `challenge` event appears; return that snapshot body."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            body = self.snapshot(tab_id)
            if body.get("challenge"):
                return body
            time.sleep(1.0)
        return None

    def vendor_gate(self, name: str, tab_id: int, timeout: float = 20.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = self.fixtures.vendor(name)
            if state == "loaded":
                return
            if state == "error":
                raise Skip(f"{name} vendor script failed to load in the browser")
            time.sleep(0.5)
        raise Skip(f"{name} vendor script did not load within {timeout:g} seconds")

    def run(self, name: str, fn: Callable[[Scenario], None]) -> Scenario:
        scenario = Scenario(name)
        self.rpc.label = name
        print(f"[{name}] running", flush=True)
        try:
            fn(scenario)
        except Skip as skip:
            scenario.status = "skip"
            scenario.reason = str(skip)
        except Exception as error:  # A live-path failure must stay in the report.
            scenario.status = "fail"
            scenario.reason = f"{type(error).__name__}: {error}"
        self.scenarios.append(scenario)
        print(f"[{name}] {scenario.status}" + (f" ({scenario.reason})" if scenario.reason else ""), flush=True)
        return scenario

    def frame_ref(self, tab_id: int, event: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
        """Return a ref inside the vendor iframe: snapshot that frame (named by the event surface)
        and prefer its checkbox, then a button, then any other node."""
        frame_id = event.get("surface", {}).get("frame_id")
        if not isinstance(frame_id, str):
            return None
        body = self.rpc.call("browser_snapshot", {"tab_id": tab_id, "mode": "accessibility", "frame_id": frame_id})
        if not body["ok"]:
            return None
        nodes = [
            node for node in body["result"].get("nodes", [])
            if isinstance(node.get("ref"), str) and node.get("frame_id") == frame_id
            and node.get("role") not in ("RootWebArea", "none", "InlineTextBox", "StaticText")
        ]
        for role in ("checkbox", "button"):
            for node in nodes:
                if node.get("role") == role:
                    return node["ref"], {"role": role, "in_surface_frame": True}
        return (nodes[0]["ref"], {"role": nodes[0].get("role"), "in_surface_frame": True}) if nodes else None

    # -- scenarios

    def scenario_clean(self, s: Scenario) -> None:
        tab_id, _, opened = self.open_tab("/clean")
        s.check("browser_open has no challenge", "challenge" not in opened["result"])
        snap = self.snapshot(tab_id)
        s.check("snapshot ok", snap["ok"], error_code(snap))
        s.check("snapshot has no challenge", "challenge" not in snap.get("result", {}))

    def scenario_widget(self, s: Scenario, path: str, vendor: str, product_vendor: str, act: bool) -> None:
        tab_id, rev, opened = self.open_tab(path)
        self.vendor_gate(vendor, tab_id)
        snap = self.poll_challenge(tab_id)
        if not s.check("snapshot carries a challenge event", snap is not None):
            return
        assert snap is not None
        event = snap["challenge"]
        s.observed["detected"] = event_fields(event)
        s.check("vendor", event.get("vendor") == product_vendor, event.get("vendor"))
        s.check("kind is widget", event.get("kind") == "widget", event.get("kind"))
        s.check("state active", event.get("state") == "active", event.get("state"))
        s.check("interaction human", event.get("interaction") == "human", event.get("interaction"))
        s.check("next handoff", event.get("next") == "handoff", event.get("next"))
        if not act:
            return
        rev = revision(snap, rev)
        located = self.frame_ref(tab_id, event)
        s.observed["frame_ref_found"] = located is not None
        if located is None:
            s.check("snapshot exposes a ref inside the vendor iframe", False)
        else:
            ref, info = located
            s.observed["frame_ref"] = info
            clicks_before = self.fixtures.clicked(vendor)
            guarded = self.rpc.call(
                "browser_act",
                {"tab_id": tab_id, "expected_page_revision": rev, "actions": [{"kind": "click", "ref": ref}]},
            )
            s.observed["frame_click"] = {
                "ok": guarded["ok"], "outcome": guarded.get("outcome"),
                "status": result_status(guarded), "error": error_code(guarded),
                "challenge": event_fields(guarded.get("challenge")),
            }
            s.check("iframe click outcome needs_user", guarded.get("outcome") == "needs_user", guarded.get("outcome"))
            s.check("iframe click status challenge_active", result_status(guarded) == "challenge_active", result_status(guarded))
            s.check(
                "iframe click carries the active episode",
                guarded.get("challenge", {}).get("challenge_id") == event.get("challenge_id"),
            )
            s.check("no click reached the page", self.fixtures.clicked(vendor) == clicks_before)
            rev = revision(guarded, rev)
        outside = self.rpc.call(
            "browser_act",
            {"tab_id": tab_id, "expected_page_revision": rev,
             "actions": [{"kind": "click", "selector": "#outside"}]},
        )
        s.observed["outside_click"] = {
            "ok": outside["ok"], "outcome": outside.get("outcome"), "error": error_code(outside),
            "status": result_status(outside),
        }
        s.check("outside click completed", outside["ok"] and outside.get("outcome") == "completed",
                {"outcome": outside.get("outcome"), "error": error_code(outside)})
        deadline = time.monotonic() + 5
        while self.fixtures.clicked(vendor) < 1 and time.monotonic() < deadline:
            time.sleep(0.1)
        s.check("outside button received exactly one click", self.fixtures.clicked(vendor) == 1,
                self.fixtures.clicked(vendor))
        waited = self.rpc.call(
            "browser_wait",
            {"tab_id": tab_id, "timeout_ms": 5000,
             "condition": {"kind": "challenge_cleared", "challenge_id": event["challenge_id"]}},
        )
        s.observed["wait"] = {
            "ok": waited["ok"], "outcome": waited.get("outcome"), "status": result_status(waited),
            "error": error_code(waited), "challenge": event_fields(waited.get("challenge")),
        }
        s.check("wait outcome needs_user", waited.get("outcome") == "needs_user", waited.get("outcome"))
        s.check("wait status challenge_needs_user", result_status(waited) == "challenge_needs_user", result_status(waited))

    def scenario_recaptcha(self, s: Scenario) -> None:
        self.scenario_widget(s, "/recaptcha", "recaptcha", "google_recaptcha", True)

    def scenario_hcaptcha(self, s: Scenario) -> None:
        self.scenario_widget(s, "/hcaptcha", "hcaptcha", "hcaptcha", False)

    def navigate(self, s: Scenario, tab_id: int, rev: int, path: str) -> tuple[dict[str, Any], dict[str, Any], int]:
        """Navigate through act, then wait for load. Act returns once the navigated page's load settles,
        so its result must already carry that page's revision, which the load wait then confirms.
        Returns (act, wait, new_revision)."""
        acted = self.rpc.call(
            "browser_act",
            {"tab_id": tab_id, "expected_page_revision": rev,
             "actions": [{"kind": "navigate", "url": self.fixtures.url(path)}]},
        )
        settled = self.rpc.call("browser_wait", {"tab_id": tab_id, "condition": {"kind": "load"}})
        new_rev = revision(acted, rev)
        s.check(f"act {path} reports the navigated revision", new_rev > rev and new_rev == revision(settled, -1),
                {"before": rev, "act": new_rev, "wait": revision(settled, -1)})
        return acted, settled, new_rev

    def scenario_headers(self, s: Scenario) -> None:
        tab_id, rev, _ = self.open_tab("/clean")
        clean = self.snapshot(tab_id)  # Attaches the debugger before the next document response.
        s.check("clean snapshot has no challenge", "challenge" not in clean.get("result", {}))
        rev = revision(clean, rev)

        cf, cf_wait, rev = self.navigate(s, tab_id, rev, "/cf")
        s.check("navigate /cf ok", cf["ok"], error_code(cf))
        event = cf.get("challenge", {})
        s.check("act result carries the /cf challenge", bool(event))
        s.observed["cf"] = event_fields(event)
        s.check("cloudflare interstitial", event.get("vendor") == "cloudflare" and event.get("kind") == "interstitial",
                {"vendor": event.get("vendor"), "kind": event.get("kind")})
        s.check("document scope", event.get("surface", {}).get("scope") == "document", event.get("surface"))
        s.check("state active", event.get("state") == "active", event.get("state"))
        s.check("same episode on the load wait", cf_wait.get("challenge", {}).get("challenge_id") == event.get("challenge_id"))

        clicked_before = self.fixtures.clicked("blocked")
        click = self.rpc.call(
            "browser_act",
            {"tab_id": tab_id, "expected_page_revision": rev,
             "actions": [{"kind": "click", "selector": "#outside"}]},
        )
        s.observed["cf_click"] = {
            "ok": click["ok"], "outcome": click.get("outcome"), "status": result_status(click),
            "error": error_code(click),
        }
        s.check("click refused needs_user", click.get("outcome") == "needs_user", click.get("outcome"))
        s.check("click status challenge_active", result_status(click) == "challenge_active", result_status(click))
        s.check("refused click did not reach the page", self.fixtures.clicked("blocked") == clicked_before)
        rev = revision(click, rev)

        limited, _, rev = self.navigate(s, tab_id, rev, "/limited")
        s.check("navigate /limited ok", limited["ok"], error_code(limited))
        lev = limited.get("challenge", {})
        s.check("act result carries the /limited challenge", bool(lev))
        s.observed["limited"] = event_fields(lev)
        s.check("rate_limit kind", lev.get("kind") == "rate_limit", lev.get("kind"))
        s.check("next retry_later", lev.get("next") == "retry_later", lev.get("next"))
        retry = lev.get("retry_after_ms")
        s.check("retry_after_ms about 30000", isinstance(retry, int) and 20000 <= retry <= 30000, retry)

        back, back_wait, rev = self.navigate(s, tab_id, rev, "/clean")
        after = self.snapshot(tab_id)
        s.check("navigate /clean ok", back["ok"], error_code(back))
        reports = [
            body["challenge"] for body in (back, back_wait, after)
            if isinstance(lev.get("challenge_id"), str)
            and body.get("challenge", {}).get("challenge_id") == lev["challenge_id"]
            and body["challenge"].get("state") != "active"
        ]
        terminal = reports[0] if reports else {}
        s.observed["terminal"] = event_fields(terminal)
        s.observed["terminal_reported_by"] = [
            name for name, body in (("act", back), ("wait", back_wait), ("snapshot", after))
            if body.get("challenge", {}).get("challenge_id") == lev.get("challenge_id")
        ]
        s.check("terminal event reported exactly once", len(reports) == 1, len(reports))
        s.check("terminal event on the act result", s.observed["terminal_reported_by"] == ["act"],
                s.observed["terminal_reported_by"])
        s.check("terminal state cleared", terminal.get("state") == "cleared", terminal.get("state"))
        s.check("terminal next none", terminal.get("next") == "none", terminal.get("next"))
        s.check("no event after the terminal", after.get("challenge") is None or after["challenge"] in reports)

    def scenario_handoff(self, s: Scenario) -> None:
        tab_id, rev, _ = self.open_tab("/recaptcha")
        self.vendor_gate("recaptcha", tab_id)
        snap = self.poll_challenge(tab_id)
        if not s.check("snapshot carries a challenge event", snap is not None):
            return
        assert snap is not None
        event = snap["challenge"]
        rev = revision(snap, rev)

        unknown = self.rpc.call(
            "browser_handoff",
            {"operation": "request", "tab_id": tab_id, "expected_page_revision": rev,
             "prompt": "Smoke test", "completion": {"kind": "challenge_cleared", "value": "chl_00000000000000000000"}},
        )
        s.observed["unknown_episode"] = {
            "error": error_code(unknown), "outcome": unknown.get("outcome"),
            "message": unknown.get("error", {}).get("message"),
        }
        s.check("unknown episode challenge_not_found", error_code(unknown) == "challenge_not_found", error_code(unknown))
        s.check("unknown episode outcome not_started", unknown.get("outcome") == "not_started", unknown.get("outcome"))

        requested = self.rpc.call(
            "browser_handoff",
            {"operation": "request", "tab_id": tab_id, "expected_page_revision": rev,
             "prompt": "Smoke test: complete the reCAPTCHA fixture",
             "completion": {"kind": "challenge_cleared", "value": event["challenge_id"]}},
        )
        s.observed["request"] = {"ok": requested["ok"], "outcome": requested.get("outcome"),
                                 "error": error_code(requested),
                                 "message": requested.get("error", {}).get("message")}
        if not s.check("handoff request ok", requested["ok"], error_code(requested)):
            return
        notice_id = requested["result"].get("notice_id")
        s.check("notice_id returned", isinstance(notice_id, str) and bool(notice_id))

        try:
            again = self.snapshot(tab_id)
            aev = again.get("challenge") or {}
            s.observed["snapshot_after_request"] = event_fields(aev)
            s.check("later snapshot event carries the notice_id", aev.get("notice_id") == notice_id, aev.get("notice_id"))
            s.check("same episode", aev.get("challenge_id") == event["challenge_id"])

            resolved = self.rpc.call("browser_handoff", {"operation": "resolve", "notice_id": notice_id})
            s.observed["resolve"] = {
                "ok": resolved["ok"], "outcome": resolved.get("outcome"), "error": error_code(resolved),
                "challenge": event_fields(resolved.get("challenge")),
            }
            s.check("resolve completion_not_met", error_code(resolved) == "completion_not_met", error_code(resolved))
            s.check("resolve details carry the active episode",
                    resolved.get("challenge", {}).get("challenge_id") == event["challenge_id"])
        finally:
            if isinstance(notice_id, str):
                dismissed = self.rpc.call("browser_handoff", {"operation": "dismiss", "notice_id": notice_id})
                s.observed["dismiss"] = {"ok": dismissed["ok"], "error": error_code(dismissed)}
                s.check("notice dismissed", dismissed["ok"], error_code(dismissed))

    def scenario_header_handoff(self, s: Scenario) -> None:
        """A handoff detaches the debugger, so only a scripting scan can see a header-only gate end."""
        tab_id, rev, _ = self.open_tab("/clean")
        rev = revision(self.snapshot(tab_id), rev)  # Attaches the debugger before the gate's response.
        gated, _, rev = self.navigate(s, tab_id, rev, "/cf-solvable")
        event = gated.get("challenge", {})
        s.observed["detected"] = event_fields(event)
        if not s.check("header-only gate detected by the debugger probe",
                       event.get("state") == "active" and event.get("detector", {}).get("probe") == "debugger",
                       event.get("detector")):
            return
        requested = self.rpc.call(
            "browser_handoff",
            {"operation": "request", "tab_id": tab_id, "expected_page_revision": rev,
             "prompt": "Smoke test: clear the header-only fixture gate",
             "completion": {"kind": "challenge_cleared", "value": event["challenge_id"]}},
        )
        if not s.check("handoff request ok", requested["ok"], error_code(requested)):
            return
        notice_id = requested["result"]["notice_id"]
        try:
            standing = self.rpc.call("browser_handoff", {"operation": "resolve", "notice_id": notice_id})
            s.observed["resolve_while_gated"] = {"error": error_code(standing),
                                                 "challenge": event_fields(standing.get("challenge"))}
            s.check("resolve while gated completion_not_met", error_code(standing) == "completion_not_met",
                    error_code(standing))

            with self.fixtures.lock:
                self.fixtures.solved = True
            deadline = time.monotonic() + 10
            resolved = standing
            while time.monotonic() < deadline:
                time.sleep(0.5)
                resolved = self.rpc.call("browser_handoff", {"operation": "resolve", "notice_id": notice_id})
                if error_code(resolved) != "completion_not_met":
                    break
            terminal = resolved.get("challenge", {})
            s.observed["resolve_after_clear"] = {"ok": resolved["ok"], "error": error_code(resolved),
                                                 "challenge": event_fields(terminal)}
            s.check("resolve succeeds once the gate clears", resolved["ok"], error_code(resolved))
            s.check("resolve reports the episode cleared",
                    terminal.get("challenge_id") == event["challenge_id"] and terminal.get("state") == "cleared",
                    terminal.get("state"))
            s.check("cleared by the scripting probe", terminal.get("detector", {}).get("probe") == "scripting",
                    terminal.get("detector"))
        finally:
            with self.fixtures.lock:
                self.fixtures.solved = False
            self.rpc.call("browser_handoff", {"operation": "dismiss", "notice_id": notice_id})

    def scenario_schema(self, s: Scenario) -> None:
        events = [entry["event"] for entry in self.rpc.events]
        s.observed["event_count"] = len(events)
        s.check("events were captured", len(events) > 0, len(events))
        if not events:
            return
        errors = validate_events(events)
        s.observed["invalid"] = errors
        s.check("every challenge event matches challenge.schema.json", not errors, errors[:5])

    # -- measurement

    def measure(self, iterations: int) -> dict[str, Any]:
        sources = json.loads(
            subprocess.run(
                [
                    "bun", "-e",
                    'import {collectChallengeFacts, catalogSelectors, catalogTokenSelectors} from "./src/challenge";'
                    'import {CHALLENGE_CATALOG} from "./src/challenge-catalog";'
                    "console.log(JSON.stringify({func: collectChallengeFacts.toString(),"
                    "selectors: catalogSelectors(CHALLENGE_CATALOG),"
                    "tokenSelectors: catalogTokenSelectors(CHALLENGE_CATALOG)}));",
                ],
                cwd=REPO / "packages" / "extension",
                text=True,
                capture_output=True,
                check=True,
            ).stdout
        )
        tabs: dict[str, int] = {}
        clean_tab, _, _ = self.open_tab("/clean")
        tabs["clean"] = clean_tab
        if self.fixtures.vendor("recaptcha") != "error":
            recaptcha_tab, _, _ = self.open_tab("/recaptcha")
            self.vendor_gate("recaptcha", recaptcha_tab)
            if self.poll_challenge(recaptcha_tab) is not None:
                tabs["recaptcha"] = recaptcha_tab
        worker = next(
            target for target in devtools_json(self.launched, "/json/list")
            if target.get("type") == "service_worker"
            and str(target.get("url", "")).startswith(f"chrome-extension://{self.launched.extension_id}/")
        )
        channel = DevToolsSocket(worker["webSocketDebuggerUrl"], 120)
        report: dict[str, Any] = {
            "iterations": iterations,
            "warmup_discarded": WARMUP_ITERATIONS,
            "warmup_note": f"the first {WARMUP_ITERATIONS} iterations of each series are discarded; "
                           "the timed series are warm (same tab, same injected function)",
            "pages": {},
        }
        try:
            for page, tab_id in tabs.items():
                expression = (
                    "(async () => {"
                    f"const tabId = {tab_id}; const n = {iterations + WARMUP_ITERATIONS};"
                    f"const selectors = {json.dumps(sources['selectors'])};"
                    f"const tokenSelectors = {json.dumps(sources['tokenSelectors'])};"
                    f"const probe = ({sources['func']});"
                    "const scan = [], store = [], total = [];"
                    "for (let i = 0; i < n; i++) {"
                    "  const t0 = performance.now();"
                    "  await chrome.scripting.executeScript({target: {tabId}, func: probe, args: [selectors, tokenSelectors]});"
                    "  const t1 = performance.now();"
                    "  await chrome.storage.session.get('agenttab.smoke.probe');"
                    "  await chrome.storage.session.set({'agenttab.smoke.probe': {i, at: Date.now()}});"
                    "  const t2 = performance.now();"
                    "  scan.push(t1 - t0); store.push(t2 - t1); total.push(t2 - t0);"
                    "}"
                    "await chrome.storage.session.remove('agenttab.smoke.probe');"
                    "const [{result}] = await chrome.scripting.executeScript({target: {tabId}, func: probe, args: [selectors, tokenSelectors]});"
                    "const counts = {};"
                    "for (const [key, value] of Object.entries(result ?? {})) if (Array.isArray(value)) counts[key] = value.length;"
                    "return {scan, store, total, counts};"
                    "})()"
                )
                series = evaluate(channel, expression)
                rpc_ms: list[float] = []
                for _ in range(iterations + WARMUP_ITERATIONS):
                    started = time.perf_counter()
                    body = self.snapshot(tab_id, "text")
                    rpc_ms.append((time.perf_counter() - started) * 1000)
                    if not body["ok"]:
                        raise RuntimeError(f"measurement snapshot failed: {error_code(body)}")
                report["pages"][page] = {
                    "probe_result_counts": series["counts"],
                    "raw_ms": {"scan": series["scan"], "store": series["store"], "scan_plus_store": series["total"],
                               "snapshot_text_rpc": rpc_ms},
                    "summary_ms": {
                        name: summarize(values[WARMUP_ITERATIONS:])
                        for name, values in (
                            ("scan", series["scan"]), ("store", series["store"]),
                            ("scan_plus_store", series["total"]), ("snapshot_text_rpc", rpc_ms),
                        )
                    },
                }
        finally:
            channel.close()
        if "recaptcha" not in tabs:
            report["recaptcha"] = "skipped: vendor widget did not load"
        return report


def machine_description() -> str:
    brand = subprocess.run(
        ["sysctl", "-n", "machdep.cpu.brand_string"], text=True, capture_output=True, check=False,
    ).stdout.strip()
    native = subprocess.run(
        ["sysctl", "-n", "hw.optional.arm64"], text=True, capture_output=True, check=False,
    ).stdout.strip()
    arch = "arm64" if native == "1" else platform.machine()
    return f"{platform.system()} {arch}" + (f" ({brand})" if brand else "")


def summarize(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)

    def rank(p: float) -> float:
        return ordered[max(0, math.ceil(p * len(ordered)) - 1)]

    return {"n": len(ordered), "p50": round(rank(0.50), 2), "p95": round(rank(0.95), 2), "max": round(ordered[-1], 2)}


VALIDATOR = """
import json, sys
from jsonschema import Draft202012Validator, FormatChecker
schema = json.load(open(sys.argv[1]))
events = json.load(open(sys.argv[2]))
validator = Draft202012Validator(schema, format_checker=FormatChecker())
out = []
for index, event in enumerate(events):
    for error in validator.iter_errors(event):
        out.append({"index": index, "path": "/".join(str(p) for p in error.absolute_path), "message": error.message[:200]})
print(json.dumps(out))
"""


def validate_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="agt-chl-") as directory:
        path = Path(directory) / "events.json"
        path.write_text(json.dumps(events), encoding="utf-8")
        completed = subprocess.run(
            ["uv", "run", "--quiet", "--with", "jsonschema,referencing,rfc3339-validator",
             "python", "-c", VALIDATOR, str(SCHEMA), str(path)],
            text=True, capture_output=True, check=False,
        )
    if completed.returncode != 0:
        raise RuntimeError(f"schema validation could not run: {completed.stderr.strip()[:300]}")
    return json.loads(completed.stdout)


# --------------------------------------------------------------------------- main


def connect_client(timeout_seconds: float) -> AgentTabClient:
    deadline = time.monotonic() + timeout_seconds
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            client = AgentTabClient.connect(connect_timeout=0.5, request_timeout=60)
            response = client.request("browser_tabs", {})
            if client.pending_resume_capability is not None:
                client.confirm_resume_capability()
            if response.get("ok") or response.get("error", {}).get("code") != "runtime_not_ready":
                return client
            client.close()
        except (OSError, TimeoutError, ConnectionError, RuntimeError) as error:
            last = error
        time.sleep(0.5)
    raise RuntimeError(f"AgentTab did not become ready within {timeout_seconds:g} seconds: {last}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live smoke for AgentTab challenge detection.")
    parser.add_argument(
        "--chrome-binary",
        default=os.environ.get("AGENTTAB_CHROME_BINARY"),
        help="Chrome for Testing executable inside its .app bundle (or set AGENTTAB_CHROME_BINARY)",
    )
    parser.add_argument("--profile-dir", help="existing Chrome user data directory; default is a disposable temp dir")
    parser.add_argument("--extension-dir", default=str(REPO / "packages" / "extension" / "dist"))
    parser.add_argument("--host-binary", default=str(REPO / "host-rs" / "target" / "debug" / "agenttab-host"))
    parser.add_argument("--output", default="/tmp/agenttab-challenge-live-smoke.json")
    parser.add_argument("--measure", type=int, default=0, metavar="N",
                        help="also record N timed scan iterations per page (after 3 warmup iterations)")
    parser.add_argument("--timeout-seconds", type=float, default=30)
    args = parser.parse_args()
    if not args.chrome_binary:
        parser.error("--chrome-binary (or AGENTTAB_CHROME_BINARY) is required")
    if args.measure < 0:
        parser.error("--measure must be non-negative")
    return args


def source_identity(args: argparse.Namespace) -> dict[str, Any]:
    """Source and build identity that docs/benchmarks.md requires beside every timing."""
    def git(*command: str) -> str | None:
        try:
            return subprocess.run(
                ["git", "-C", str(REPO), *command], capture_output=True, text=True, check=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    status = git("status", "--porcelain")
    manifest = json.loads((Path(args.extension_dir) / "manifest.json").read_text(encoding="utf-8"))
    host = Path(args.host_binary)
    return {
        "commit": git("rev-parse", "HEAD"),
        "dirty": None if status is None else status != "",
        "extensionVersion": manifest.get("version"),
        "hostBinarySha256": hashlib.sha256(host.read_bytes()).hexdigest(),
        "hostProfile": host.parent.name,
    }


def main() -> int:
    args = parse_args()
    for label, path in (("extension", Path(args.extension_dir) / "manifest.json"), ("host", Path(args.host_binary))):
        if not path.exists():
            print(f"missing {label} build at {path}; see the usage section of this script", file=sys.stderr)
            return 2
    started = time.time()
    fixtures = Fixtures()
    fixtures.start()
    temp_profile: Path | None = None
    if args.profile_dir:
        profile = args.profile_dir
    else:
        temp_profile = Path(tempfile.mkdtemp(prefix="agt-prof-", dir="/tmp")).resolve()
        profile = str(temp_profile)
    launched: LaunchedChrome | None = None
    client: AgentTabClient | None = None
    smoke: Smoke | None = None
    run_error: str | None = None
    chrome_version: str | None = None
    try:
        launched = launch_isolated_chrome(
            args.chrome_binary, profile, args.extension_dir, args.host_binary, args.timeout_seconds,
        )
        wait_for_browser(launched, args.timeout_seconds)
        chrome_version = (devtools_json(launched, "/json/version") or {}).get("Browser")
        grant_scripting(launched, args.timeout_seconds)
        client = connect_client(args.timeout_seconds)
        smoke = Smoke(Rpc(client), fixtures, launched, args)
        smoke.run("clean_page", smoke.scenario_clean)
        smoke.run("recaptcha", smoke.scenario_recaptcha)
        smoke.run("hcaptcha", smoke.scenario_hcaptcha)
        smoke.run("header_detection", smoke.scenario_headers)
        smoke.run("handoff", smoke.scenario_handoff)
        smoke.run("header_handoff", smoke.scenario_header_handoff)
        smoke.run("schema", smoke.scenario_schema)
        if args.measure:
            print(f"[measure] {args.measure} iterations", flush=True)
            smoke.measurements = smoke.measure(args.measure)
    except Exception as error:  # Retain the failure in the report; cleanup still runs.
        run_error = f"{type(error).__name__}: {error}"
    finally:
        if client is not None:
            try:
                client.finish_task(disposition="close")
            except Exception:
                client.close()
        if launched is not None:
            launched.close()
        fixtures.stop()
        if temp_profile is not None:
            shutil.rmtree(temp_profile, ignore_errors=True)

    scenarios = [scenario.report() for scenario in smoke.scenarios] if smoke else []
    counts = {status: sum(1 for s in scenarios if s["status"] == status) for status in ("pass", "fail", "skip")}
    success = run_error is None and counts["fail"] == 0 and bool(scenarios)
    report = {
        "success": success,
        "command": " ".join([Path(sys.argv[0]).name, *sys.argv[1:]]),
        "startedAt": started,
        "durationSeconds": round(time.time() - started, 1),
        "chromeVersion": chrome_version,
        "source": source_identity(args),
        "machine": machine_description(),
        "counts": counts,
        "runError": run_error,
        "scenarios": scenarios,
        "challengeEvents": smoke.rpc.events if smoke else [],
        "measurements": smoke.measurements if smoke else None,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("success", "counts", "runError", "chromeVersion")}, indent=2))
    print(f"report: {output}")
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
