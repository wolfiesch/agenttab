#!/usr/bin/env python3
"""Offline contract test for host-enforced guardrails (policy, audit, redaction).

Runs the same scenarios against the Python host (bridge.py) and, when built,
the Rust host (host-rs/target/release/bridge-host). Each scenario starts a fresh
host with its own policy file and audit log so behavior is deterministic and
isolated. A mock extension echoes forwarded requests so we can assert exactly
which actions reach the extension and what responses are redacted.

Usage:
    PYTHONDONTWRITEBYTECODE=1 ./verify_guardrails_contract.py
"""
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import tempfile
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 9233

failures = []


def expect(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"FAIL: {msg}")


# Forwarded actions seen by the mock extension, shared per running host.
forwarded = []
forwarded_lock = threading.Lock()

# Configurable origins the mock returns for the reserved __tabOrigin lookup.
# Keyed by the request's payload tabId (int) or None for the active tab.
tab_origins = {None: "https://github.com"}


def set_tab_origins(mapping):
    global tab_origins
    tab_origins = mapping


def mock_extension(proc, result_fn):
    """Echo each forwarded request. result_fn(action, payload) -> result dict.
    The reserved __tabOrigin action is answered from ``tab_origins`` so the host
    can resolve a tab's live origin for tab-scoped policy."""
    while True:
        raw_len = proc.stdout.read(4)
        if len(raw_len) < 4:
            return
        length = struct.unpack("@I", raw_len)[0]
        msg = json.loads(proc.stdout.read(length).decode("utf-8"))
        action = msg.get("action")
        payload = msg.get("payload") or {}
        with forwarded_lock:
            forwarded.append((action, payload))
        if action == "__tabOrigin":
            origin = tab_origins.get(payload.get("tabId"))
            url = None if origin is None else origin + "/some/path"
            result = {"tabId": payload.get("tabId"), "url": url, "origin": origin}
        else:
            result = result_fn(action, payload)
        resp = {"id": msg.get("id"), "success": True, "result": result}
        enc = json.dumps(resp).encode("utf-8")
        proc.stdin.write(struct.pack("@I", len(enc)))
        proc.stdin.write(enc)
        proc.stdin.flush()


class Client:
    def __init__(self, token):
        self.token = token
        self.buf = b""
        deadline = time.monotonic() + 3
        while True:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(10)
            try:
                self.sock.connect(("127.0.0.1", PORT))
                break
            except ConnectionRefusedError:
                self.sock.close()
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)

    def req(self, action, payload=None, confirmation_token=None, extra=None):
        cmd = {"action": action, "payload": payload or {}, "token": self.token}
        if confirmation_token:
            cmd["confirmationToken"] = confirmation_token
        if extra:
            cmd.update(extra)
        self.sock.sendall((json.dumps(cmd) + "\n").encode())
        while b"\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                return None
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line.decode())

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


TOKENS_FILE = "/tmp/chrome-bridge-guard-tokens.txt"
LEGACY_FILE = "/tmp/chrome-bridge-guard-legacy.txt"
POLICY_FILE = "/tmp/chrome-bridge-guard-policy.json"
AUDIT_FILE = "/tmp/chrome-bridge-guard-audit.jsonl"
SECRETS_FILE = "/tmp/chrome-bridge-guard-secrets.txt"


def write_policy(policy):
    with open(POLICY_FILE, "w") as f:
        json.dump(policy, f)


def make_env():
    with open(TOKENS_FILE, "w") as f:
        f.write("# name:token\nalpha:tok-alpha\n")
    with open(LEGACY_FILE, "w") as f:
        f.write("legacy-token\n")
    env = os.environ.copy()
    env["BRIDGE_PORT"] = str(PORT)
    env["BRIDGE_TOKENS_FILE"] = TOKENS_FILE
    env["BRIDGE_TOKEN_FILE"] = LEGACY_FILE
    env["BRIDGE_POLICY_FILE"] = POLICY_FILE
    env["BRIDGE_AUDIT_LOG_FILE"] = AUDIT_FILE
    env["BRIDGE_LOG_FILE"] = "/tmp/chrome-bridge-guard.log"
    env["BRIDGE_POLICY_APPROVAL_MODE"] = "off"
    return env


class Host:
    """A running host with a fresh policy + audit log."""

    def __init__(self, label, cmd, env, result_fn=None):
        self.label = label
        self.result_fn = result_fn or (lambda a, p: {"echo": a})
        with forwarded_lock:
            forwarded.clear()
        # Truncate the audit log for this scenario.
        open(AUDIT_FILE, "w").close()
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env,
        )
        threading.Thread(
            target=mock_extension, args=(self.proc, self.result_fn), daemon=True
        ).start()
        time.sleep(1)

    def stop(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.stop()


def audit_events():
    try:
        with open(AUDIT_FILE) as f:
            return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError:
        return []


def forwarded_actions():
    with forwarded_lock:
        return [a for a, _ in forwarded]


def make_approval_command():
    fd, path = tempfile.mkstemp(prefix="chrome-bridge-approval-", suffix=".py")
    os.close(fd)
    with open(path, "w") as f:
        f.write(
            "import os\n"
            "decision = os.environ.get('TEST_APPROVAL_DECISION', 'deny')\n"
            "with open(os.environ['TEST_APPROVAL_LOG'], 'a') as log:\n"
            "    log.write(os.environ.get('CHROME_BRIDGE_APPROVAL_ACTION', '') + '|' + "
            "os.environ.get('CHROME_BRIDGE_APPROVAL_ORIGIN', '') + '\\n')\n"
            "print(decision)\n"
        )
    os.chmod(path, 0o700)
    return path


PERMISSIVE = {"default": {"allowedActions": ["*"], "deniedActions": [],
                          "allowedOrigins": ["*"], "deniedOrigins": [],
                          "requireConfirmation": [], "redact": True, "audit": True}}


def permissive_with(**overrides):
    default = dict(PERMISSIVE["default"])
    default.update(overrides)
    return {"default": default}


def check_python_origin_approval(cmd, env):
    label = "python"
    approval_cmd = make_approval_command()
    approval_log = "/tmp/chrome-bridge-approval-log.txt"

    # Deny: denied origin remains denied and nothing forwards.
    write_policy(permissive_with(allowedActions=["navigate"], allowedOrigins=[]))
    try:
        os.remove(approval_log)
    except FileNotFoundError:
        pass
    deny_env = dict(env)
    deny_env.update({
        "BRIDGE_POLICY_APPROVAL_MODE": "command",
        "BRIDGE_POLICY_APPROVAL_COMMAND": f"{sys.executable} {approval_cmd}",
        "TEST_APPROVAL_DECISION": "deny",
        "TEST_APPROVAL_LOG": approval_log,
    })

    # Lease wins before approval UX: a non-owner must not trigger a prompt or
    # mutate policy for a request that will be rejected as leased by another client.
    write_policy(permissive_with(allowedActions=["navigate", "lease", "release", "leaseStatus"],
                                 allowedOrigins=[]))
    try:
        os.remove(approval_log)
    except FileNotFoundError:
        pass
    leased_env = dict(deny_env)
    leased_env["TEST_APPROVAL_DECISION"] = "always_allow"
    with Host(label, cmd, leased_env):
        owner = Client("tok-alpha")
        other = Client("legacy-token")
        lr = owner.req("lease", {"ttlMs": 5000})
        expect(lr and lr.get("success") is True, f"{label}: lease setup failed, got {lr}")
        r = other.req("navigate", {"url": "https://example.com/a"})
        expect(r and r.get("success") is False and r.get("error") == "leased by alpha",
               f"{label}: leased non-owner should be denied before approval, got {r}")
        owner.close()
        other.close()
    expect(not os.path.exists(approval_log) or os.path.getsize(approval_log) == 0,
           f"{label}: leased non-owner must not trigger approval prompt")
    with open(POLICY_FILE) as f:
        pol = json.load(f)
    expect("https://example.com" not in pol.get("default", {}).get("allowedOrigins", []),
           f"{label}: leased non-owner must not persist origin approval")
    with Host(label, cmd, deny_env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://example.com/a"})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: denied approval prompt should keep policy denial, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: denied approval prompt must not forward")
        c.close()
    deny_decisions = [e["decision"] for e in audit_events() if e["action"] == "navigate"]
    expect("origin_approval_denied" in deny_decisions,
           f"{label}: denied approval must be auditable, got {deny_decisions}")


    # Allow this time: current action forwards, policy file remains unchanged.
    write_policy(permissive_with(allowedActions=["navigate"], allowedOrigins=[]))
    once_env = dict(deny_env)
    once_env["TEST_APPROVAL_DECISION"] = "allow_once"
    with Host(label, cmd, once_env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://example.com/a"})
        expect(r and r.get("success") is True,
               f"{label}: allow_once approval should forward current action, got {r}")
        expect("navigate" in forwarded_actions(),
               f"{label}: allow_once approval should forward navigate")
        c.close()
    once_decisions = [e["decision"] for e in audit_events() if e["action"] == "navigate"]
    expect("origin_approval_once" in once_decisions,
           f"{label}: allow_once approval must be auditable, got {once_decisions}")

    with open(POLICY_FILE) as f:
        pol = json.load(f)
    expect("https://example.com" not in pol.get("default", {}).get("allowedOrigins", []),
           f"{label}: allow_once must not persist origin grants")

    # Allow this time also covers domain-pattern targets such as getCookies
    # (`*://example.com`), not only concrete http/https URL origins.
    write_policy(permissive_with(allowedActions=["getCookies"], allowedOrigins=[]))
    with Host(label, cmd, once_env):
        c = Client("tok-alpha")
        r = c.req("getCookies", {"domain": "example.com"})
        expect(r and r.get("success") is True,
               f"{label}: allow_once approval should forward getCookies domain target, got {r}")
        expect("getCookies" in forwarded_actions(),
               f"{label}: allow_once approval should forward getCookies")
        c.close()
    cookie_decisions = [e["decision"] for e in audit_events() if e["action"] == "getCookies"]
    expect("origin_approval_once" in cookie_decisions,
           f"{label}: getCookies allow_once approval must be auditable, got {cookie_decisions}")
    with open(POLICY_FILE) as f:
        pol = json.load(f)
    expect("*://example.com" not in pol.get("default", {}).get("allowedOrigins", []),
           f"{label}: getCookies allow_once must not persist wildcard origin grants")

    # Always allow: current action forwards and local policy gains the origin.
    write_policy(permissive_with(allowedActions=["navigate"], allowedOrigins=[]))
    always_env = dict(deny_env)
    always_env["TEST_APPROVAL_DECISION"] = "always_allow"
    with Host(label, cmd, always_env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://example.com/a"})
        expect(r and r.get("success") is True,
               f"{label}: always_allow approval should forward current action, got {r}")
        c.close()
    always_decisions = [e["decision"] for e in audit_events() if e["action"] == "navigate"]
    expect("origin_approval_persisted" in always_decisions,
           f"{label}: always_allow approval must be auditable, got {always_decisions}")

    with open(POLICY_FILE) as f:
        pol = json.load(f)
    expect("https://example.com" in pol.get("default", {}).get("allowedOrigins", []),
           f"{label}: always_allow must persist origin grant in local policy")

    # Site approval must not bypass destructive-action confirmation.
    write_policy(permissive_with(allowedActions=["executeScriptCDP"],
                                 allowedOrigins=[],
                                 requireConfirmation=["executeScriptCDP"]))
    set_tab_origins({7: "https://example.com"})
    with Host(label, cmd, once_env):
        c = Client("tok-alpha")
        r = c.req("executeScriptCDP", {"tabId": 7, "code": "1"})
        expect(r and r.get("confirmationRequired") is True and r.get("success") is False,
               f"{label}: origin approval must still require destructive confirmation, got {r}")
        expect("executeScriptCDP" not in forwarded_actions(),
               f"{label}: unconfirmed destructive action must not forward after origin approval")
        c.close()
    set_tab_origins({None: "https://github.com"})


EXAMPLE_DENIED_ORIGINS = [
    "file://*", "chrome://*", "chrome-extension://*",
    "*://localhost", "*://localhost:*",
    "*://127.0.0.1", "*://127.0.0.1:*",
    "*://0.0.0.0", "*://0.0.0.0:*",
    "*://*.local", "*://*.local:*",
    "*://[[]::1[]]", "*://[[]::1[]]:*",
]

AUDIT_KEYS = {"ts", "client", "action", "targets", "decision", "reason", "requestId"}


def run_against(label, cmd, env):
    print(f"\n=== host: {label} ===")

    # --- Missing policy file uses fail-closed built-in defaults ---
    try:
        os.remove(POLICY_FILE)
    except FileNotFoundError:
        pass
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is False and r.get("error") == "policy denied: action getTabs not allowed",
               f"{label}: missing policy should deny getTabs, got {r}")
        r = c.req("ping")
        expect(r and r.get("success") is True,
               f"{label}: missing policy should allow ping, got {r}")
        c.close()

    # --- Denied action ---
    write_policy(permissive_with(deniedActions=["getCookies"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getCookies", {"domain": "x.test"})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: denied action should return policy denied, got {r}")
        expect("getCookies" not in forwarded_actions(),
               f"{label}: denied action must not forward to extension")
        c.close()

    # --- Target deny for cookies ---
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getCookies", {"domain": "mail.google.com"})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: cookie target deny should be policy denied, got {r}")
        expect("getCookies" not in forwarded_actions(),
               f"{label}: cookie target deny must not forward")
        c.close()

    # --- Target deny for downloads ---
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("downloadUrl", {"url": "https://mail.google.com/a/file"})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: download target deny should be policy denied, got {r}")
        expect("downloadUrl" not in forwarded_actions(),
               f"{label}: download target deny must not forward")
        c.close()

    # --- Explicit default port preserved in targets (Python/Rust parity) ---
    write_policy(permissive_with(deniedOrigins=["*://example.com:443"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("downloadUrl", {"url": "https://example.com:443/file"})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: explicit default port should be denied, got {r}")
        expect("downloadUrl" not in forwarded_actions(),
               f"{label}: explicit default port deny must not forward")
        c.close()

    # --- Required target actions fail closed when payload target is unresolved ---
    write_policy(permissive_with(allowedActions=["*"], allowedOrigins=["*"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "file:///tmp/a.html"})
        expect(r and r.get("success") is False and "target unresolved" in str(r.get("error", "")),
               f"{label}: file navigate should be target-unresolved, got {r}")
        r = c.req("downloadUrl", {"url": "https://example.com:99999/file"})
        expect(r and r.get("success") is False and "target unresolved" in str(r.get("error", "")),
               f"{label}: malformed-port download should be target-unresolved, got {r}")
        for payload in ({}, {"domain": ""}, {"domain": "."}, {"domain": "   "}):
            r = c.req("getCookies", payload)
            expect(r and r.get("success") is False and "target unresolved" in str(r.get("error", "")),
                   f"{label}: invalid getCookies target should be denied for {payload}, got {r}")
        r = c.req("batch", {"steps": [{"action": "getCookies", "payload": {"domain": ""}}]})
        expect(r and r.get("success") is False and "batch step 0: target unresolved" in str(r.get("error", "")),
               f"{label}: batch invalid target should identify step, got {r}")
        expect(all(a not in forwarded_actions() for a in ("navigate", "downloadUrl", "getCookies", "batch")),
               f"{label}: unresolved target actions must not forward, got {forwarded_actions()}")
        c.close()

    # --- Example deny-list blocks local/private origins even under wildcard allow ---
    write_policy(permissive_with(allowedActions=["*"], allowedOrigins=["*"], deniedOrigins=EXAMPLE_DENIED_ORIGINS))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        for url in [
            "http://localhost:9223/",
            "http://127.0.0.1:9223/",
            "http://0.0.0.0:9223/",
            "http://foo.local:9223/",
            "http://[::1]:9223/",
        ]:
            r = c.req("navigate", {"url": url})
            expect(r and r.get("success") is False and "target denied" in str(r.get("error", "")),
                   f"{label}: example deny-list should block {url}, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: local/private denied navigations must not forward")
        c.close()

    # --- Policy hot-reload ---
    write_policy(PERMISSIVE)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("ping")
        expect(r and r.get("success"), f"{label}: ping should forward under permissive policy")
        # Rewrite to deny ping; ensure mtime advances.
        time.sleep(1.1)
        write_policy(permissive_with(deniedActions=["ping"]))
        time.sleep(0.2)
        r = c.req("ping")
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: ping should be denied after hot-reload, got {r}")
        c.close()

    # --- Confirmation token is bound to client/action/payload/targets ---
    write_policy(permissive_with(requireConfirmation=["executeScript"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        payload = {"tabId": 1, "code": "1"}
        r = c.req("executeScript", payload)
        token = (r or {}).get("confirmationToken")
        expect(r and r.get("confirmationRequired") is True and r.get("success") is False and isinstance(token, str) and token,
               f"{label}: executeScript should return a confirmation token, got {r}")
        expect("executeScript" not in forwarded_actions(),
               f"{label}: unconfirmed action must not forward")
        r = c.req("executeScript", payload, confirmation_token=token)
        expect(r and r.get("success") is True,
               f"{label}: confirmed executeScript should succeed, got {r}")
        expect("executeScript" in forwarded_actions(),
               f"{label}: confirmed executeScript should forward")
        token_only_payload = {"tabId": 1, "code": "token-only"}
        r = c.req("executeScript", token_only_payload)
        token_only = (r or {}).get("confirmationToken")
        expect((r or {}).get("resumeCommand") == f"chrome-bridge confirm {token_only}",
               f"{label}: confirmation response should expose token-only resume command, got {r}")
        # Resume through a different authenticated local identity, matching the
        # real MCP-issued-token -> default-CLI confirmation flow.
        c2 = Client("legacy-token")
        r = c2.req("confirm", {"confirmationToken": token_only})
        expect(r and r.get("success") is True,
               f"{label}: cross-client token-only confirm should resume the original identity/action, got {r}")
        before_invalid = len(forwarded_actions())
        r = c2.req("confirm", {"confirmationToken": "not-a-real-token"})
        expect(r and r.get("success") is False and "invalid or expired" in str(r.get("error", "")),
               f"{label}: invalid token-only confirm must fail closed, got {r}")
        expect(len(forwarded_actions()) == before_invalid,
               f"{label}: invalid token-only confirm must not forward")
        r = c2.req("confirm", "not-an-object")
        expect(r and r.get("success") is False and "invalid or expired" in str(r.get("error", "")),
               f"{label}: malformed token-only confirm payload must fail closed, got {r}")
        r = c2.req("ping")
        expect(r and r.get("success") is True,
               f"{label}: malformed confirm payload must not crash the client handler, got {r}")
        c2.close()
        r = c.req("executeScript", {"tabId": 1, "code": "2"}, confirmation_token=token)
        expect(r and r.get("confirmationRequired") is True and r.get("confirmationToken") != token,
               f"{label}: reused token with different payload should require fresh confirmation, got {r}")
        c.close()
        time.sleep(0.3)
        exec_events = [e for e in audit_events() if e["action"] == "executeScript"]
        decisions = [e["decision"] for e in exec_events]
        expected_order = [
            "confirmation_required", "confirmation_accepted", "allow", "extension_success",
            "confirmation_required", "confirmation_accepted", "allow", "extension_success",
            "confirmation_required",
        ]
        expect(decisions == expected_order,
               f"{label}: confirmation audit order = {decisions}")

    # --- Batch action denial (batch itself denied, steps not inspected) ---
    write_policy(permissive_with(deniedActions=["batch"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("batch", {"steps": [{"action": "ping", "payload": {}}]})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: denied batch should be policy denied, got {r}")
        expect(forwarded_actions() == [],
               f"{label}: denied batch must not forward any step")
        c.close()

    # --- Batch step denial ---
    write_policy(permissive_with(deniedActions=["executeScript"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("batch", {"steps": [{"action": "executeScript", "payload": {"tabId": 1, "code": "1"}}]})
        expect(r and r.get("success") is False and "batch step 0:" in str(r.get("error", "")),
               f"{label}: batch step denial should name step 0, got {r}")
        expect(forwarded_actions() == [],
               f"{label}: batch step denial must not forward")
        c.close()

    # --- Audit ---
    write_policy(permissive_with(deniedActions=["getCookies"], requireConfirmation=["executeScript"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        c.req("ping")
        c.req("getCookies", {"domain": "mail.google.com"})
        c.req("executeScript", {"tabId": 1, "code": "1"})
        c.close()
        time.sleep(0.3)
        events = audit_events()
        for e in events:
            expect(set(e.keys()) == AUDIT_KEYS,
                   f"{label}: audit event keys = {sorted(e.keys())}")
            expect("payload" not in e and "response" not in e,
                   f"{label}: audit must omit payload/response")
        ping_events = [e for e in events if e["action"] == "ping"]
        expect(len(ping_events) == 2, f"{label}: ping should write 2 audit events, got {len(ping_events)}")
        if len(ping_events) == 2:
            decisions = [e["decision"] for e in ping_events]
            expect(decisions == ["allow", "extension_success"],
                   f"{label}: ping audit decisions = {decisions}")
            rids = {e["requestId"] for e in ping_events}
            expect(len(rids) == 1 and None not in rids,
                   f"{label}: ping audit requestIds should match and be non-null, got {rids}")
        cookie_events = [e for e in events if e["action"] == "getCookies"]
        expect(len(cookie_events) == 1 and cookie_events[0]["decision"] == "deny"
               and cookie_events[0]["requestId"] is None,
               f"{label}: getCookies should write 1 deny event with null requestId, got {cookie_events}")
        expect(cookie_events and cookie_events[0]["targets"] == ["*://mail.google.com"],
               f"{label}: getCookies audit targets = {cookie_events[0]['targets'] if cookie_events else None}")
        exec_events = [e for e in events if e["action"] == "executeScript"]
        expect(len(exec_events) == 1 and exec_events[0]["decision"] == "confirmation_required"
               and exec_events[0]["requestId"] is None,
               f"{label}: executeScript should write 1 confirmation_required event, got {exec_events}")

    # --- Cookie redaction ---
    write_policy(PERMISSIVE)
    cookie_result = lambda a, p: {"cookies": [{"name": "sid", "value": "secret-cookie",
                                               "domain": "x.test", "secure": True}]}
    with Host(label, cmd, env, result_fn=cookie_result):
        c = Client("tok-alpha")
        r = c.req("getCookies", {"domain": "x.test"})
        cookies = (r or {}).get("result", {}).get("cookies", [])
        expect(cookies and cookies[0].get("value") == "<redacted>",
               f"{label}: cookie value should be redacted, got {cookies}")
        expect(cookies and cookies[0].get("name") == "sid" and cookies[0].get("secure") is True,
               f"{label}: cookie metadata should be preserved, got {cookies}")
        c.close()

    # --- policyCheck ---
    write_policy(permissive_with(requireConfirmation=["executeScript"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("policyCheck", {"action": "getCookies", "payload": {"domain": "mail.google.com"}})
        res = (r or {}).get("result", {})
        expect(set(res.keys()) == {"allowed", "reason", "confirmationRequired", "redact", "audit", "originDependent"},
               f"{label}: policyCheck result keys = {sorted(res.keys())}")
        expect(res.get("allowed") is True, f"{label}: policyCheck getCookies should be allowed, got {res}")
        expect(res.get("originDependent") is False,
               f"{label}: policyCheck getCookies should not be originDependent, got {res}")
        expect("getCookies" not in forwarded_actions(),
               f"{label}: policyCheck must not forward")
        c.close()
        time.sleep(0.3)
        pc_events = [e for e in audit_events() if e["action"] == "policyCheck"]
        expect(len(pc_events) == 1 and pc_events[0]["decision"] == "allow"
               and pc_events[0]["requestId"] is None,
               f"{label}: policyCheck should write 1 allow event with null requestId, got {pc_events}")
        expect(pc_events and pc_events[0]["targets"] == ["*://mail.google.com"],
               f"{label}: policyCheck targets = {pc_events[0]['targets'] if pc_events else None}")

    # --- Structured policyDenial companion accompanies action denials ---
    write_policy(permissive_with(deniedActions=["getCookies"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getCookies", {"domain": "mail.google.com"})
        # Error string stays byte-stable; structured companion is additive.
        expect(r and r.get("error") == "policy denied: action getCookies denied",
               f"{label}: getCookies deny error must stay byte-stable, got {r}")
        pd = (r or {}).get("policyDenial") or {}
        expect(pd.get("kind") == "action" and pd.get("action") == "getCookies",
               f"{label}: policyDenial should classify action getCookies, got {pd}")
        sp = pd.get("suggestedPatch") or {}
        expect(sp.get("op") == "removePattern" and sp.get("list") == "deniedActions"
               and sp.get("patterns") == ["getCookies"],
               f"{label}: policyDenial suggestedPatch should removePattern from deniedActions, got {sp}")
        expect(pd.get("policyFile") == POLICY_FILE,
               f"{label}: policyDenial should report the active policy file, got {pd}")
        c.close()

    # --- policyDenial for a denied batch step carries the step index ---
    write_policy(permissive_with(deniedActions=["executeScript"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("batch", {"steps": [
            {"action": "ping", "payload": {}},
            {"action": "executeScript", "payload": {"tabId": 1, "code": "1"}}]})
        pd = (r or {}).get("policyDenial") or {}
        expect(pd.get("batchStep") == 1 and pd.get("action") == "executeScript",
               f"{label}: policyDenial should name failing batch step 1 / executeScript, got {pd}")
        c.close()

    # --- policyInfo is always answerable, even under a deny-all policy, and
    #     leaks only paths/metadata (never policy contents) ---
    write_policy({"default": {"allowedActions": [], "deniedActions": ["*"],
                              "allowedOrigins": [], "deniedOrigins": ["*"],
                              "requireConfirmation": [], "redact": True, "audit": True}})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        # Sanity: the deny-all policy really denies a normal action.
        r = c.req("getTabs")
        expect(r and r.get("success") is False,
               f"{label}: deny-all policy should deny getTabs, got {r}")
        r = c.req("policyInfo")
        expect(r and r.get("success") is True,
               f"{label}: policyInfo must succeed under deny-all policy, got {r}")
        res = (r or {}).get("result") or {}
        expect(set(res.keys()) == {"policyFile", "policyFileExists", "auditLogFile", "client"},
               f"{label}: policyInfo must expose only path metadata, got {sorted(res.keys())}")
        expect(res.get("policyFile") == POLICY_FILE and res.get("policyFileExists") is True,
               f"{label}: policyInfo should report the active policy file, got {res}")
        expect("policyInfo" not in forwarded_actions(),
               f"{label}: policyInfo must not forward to the extension")
        c.close()

    # --- CLI `policy allow-action` produces a policy the host honors WITHOUT
    #     dropping inherited grants (the replace-merge footgun). Uses the real
    #     test_client.cmd_policy to edit the file, then the host to evaluate. ---
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location("tc_guard", os.path.join(SCRIPT_DIR, "test_client.py"))
    _tc = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_tc)
    # Base policy: default grants ping + getTabs only. We grant getCookies via the
    # CLI and require ping/getTabs to still resolve afterward.
    write_policy({"default": {"allowedActions": ["ping", "getTabs"], "deniedActions": [],
                              "allowedOrigins": ["*"], "deniedOrigins": [],
                              "requireConfirmation": [], "redact": True, "audit": True}})
    _tc.send_command_data = lambda a, p=None, read_timeout_ms=None, confirmation_token=None: (
        0, {"success": True, "result": {"policyFile": POLICY_FILE, "policyFileExists": True,
                                        "auditLogFile": AUDIT_FILE, "client": "alpha"}}, "")
    import io as _io, contextlib as _ctx
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_policy(["test_client.py", "policy", "allow-action", "getCookies"])
    expect(_rc == 0, f"{label}: CLI allow-action should succeed, got rc={_rc}")
    time.sleep(1.1)  # let the policy file mtime advance for hot-reload
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getCookies", {"domain": "x.test"})
        expect(r and r.get("success") is True,
               f"{label}: host should honor CLI-granted getCookies, got {r}")
        # Inherited grants must survive the edit (the replace-merge footgun).
        r = c.req("ping")
        expect(r and r.get("success") is True,
               f"{label}: inherited ping must survive CLI allow-action, got {r}")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: inherited getTabs must survive CLI allow-action, got {r}")
        c.close()

    # --- Reserved action rejected from socket clients ---
    write_policy(PERMISSIVE)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("__tabOrigin", {"tabId": 1})
        expect(r and r.get("success") is False and "unknown action" in str(r.get("error", "")),
               f"{label}: reserved __tabOrigin must be rejected as unknown, got {r}")
        expect("__tabOrigin" not in forwarded_actions(),
               f"{label}: reserved action must not forward")
        time.sleep(0.3)
        re_events = [e for e in audit_events() if e["action"] == "__tabOrigin"]
        expect(len(re_events) == 1 and re_events[0]["decision"] == "deny"
               and re_events[0]["reason"] == "unknown action"
               and re_events[0]["requestId"] is None,
               f"{label}: reserved action must write 1 deny event (reason 'unknown action', null requestId), got {re_events}")
        expect(re_events and set(re_events[0].keys()) == AUDIT_KEYS,
               f"{label}: reserved deny event keys = {sorted(re_events[0].keys()) if re_events else None}")
        c.close()

    # --- Reserved action rejected as a batch step (no runBatch dispatch) ---
    write_policy(PERMISSIVE)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("batch", {"steps": [{"action": "__tabOrigin", "payload": {"tabId": 1}}]})
        expect(r and r.get("success") is False and "batch step 0:" in str(r.get("error", "")),
               f"{label}: batch reserved step must be denied, got {r}")
        expect("__tabOrigin" not in forwarded_actions(),
               f"{label}: batch reserved step must not forward")
        c.close()

    # --- Tab-origin enforcement: deny tab-scoped action on a denied origin ---
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    set_tab_origins({7: "https://mail.google.com"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("click", {"tabId": 7, "selector": "#x"})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: click on denied-origin tab should be denied, got {r}")
        expect("click" not in forwarded_actions(),
               f"{label}: denied-origin click must not forward")
        # The host did a host-internal origin lookup to make the decision.
        expect("__tabOrigin" in forwarded_actions(),
               f"{label}: host should have looked up the tab origin")
        c.close()

    # --- Tab-origin enforcement: allow tab-scoped action on an allowed origin ---
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    set_tab_origins({7: "https://github.com"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("click", {"tabId": 7, "selector": "#x"})
        expect(r and r.get("success") is True,
               f"{label}: click on allowed-origin tab should succeed, got {r}")
        expect("click" in forwarded_actions(),
               f"{label}: allowed-origin click should forward")
        c.close()

    # --- Tab-origin allow-list with explicit default port (parity) ---
    write_policy(permissive_with(allowedOrigins=["https://example.com:443"]))
    set_tab_origins({7: "https://example.com:443"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("click", {"tabId": 7, "selector": "#x"})
        expect(r and r.get("success") is True,
               f"{label}: explicit default-port origin should match allow-list, got {r}")
        c.close()

    # --- Fail closed when the tab origin cannot be resolved ---
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    set_tab_origins({7: None})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("click", {"tabId": 7, "selector": "#x"})
        expect(r and r.get("success") is False and "tab origin unresolved" in str(r.get("error", "")),
               f"{label}: unresolved tab origin should be denied, got {r}")
        expect("click" not in forwarded_actions(),
               f"{label}: unresolved-origin click must not forward")
        c.close()
    set_tab_origins({None: "https://github.com"})

    # --- Origin-permissive policy skips the lookup round-trip ---
    write_policy(PERMISSIVE)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("click", {"tabId": 7, "selector": "#x"})
        expect(r and r.get("success") is True,
               f"{label}: permissive policy click should succeed, got {r}")
        expect("__tabOrigin" not in forwarded_actions(),
               f"{label}: permissive policy must not trigger an origin lookup")
        c.close()

    # --- Batch tabId defaulting is origin-checked ---
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    set_tab_origins({7: "https://mail.google.com"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("batch", {"tabId": 7, "steps": [{"action": "click", "payload": {"selector": "#x"}}]})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: batch step inheriting denied-origin tabId should be denied, got {r}")
        expect("click" not in forwarded_actions(),
               f"{label}: denied batch step must not forward")
        c.close()
    set_tab_origins({None: "https://github.com"})

    # --- policyCheck reports originDependent for tab-scoped actions ---
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("policyCheck", {"action": "click", "payload": {"tabId": 7}})
        res = (r or {}).get("result", {})
        expect(res.get("originDependent") is True,
               f"{label}: policyCheck for tab-scoped action should be originDependent, got {res}")
        expect("__tabOrigin" not in forwarded_actions(),
               f"{label}: policyCheck must not forward an origin lookup")
        c.close()


    # --- Content redaction: redactPatterns mask getHTML/extractText/script ---
    write_policy(permissive_with(redactPatterns=[r"\d{3}-\d{2}-\d{4}", "(?i)bearer [a-z0-9]+"]))
    html_result = lambda a, p: {"success": True, "html": "<p>SSN 123-45-6789</p>"} if a == "getHTML" else (
        {"success": True, "text": "auth Bearer abc123 token"} if a == "extractText" else (
        {"success": True, "val": "SSN 999-88-7777"} if a == "executeScript" else {"echo": a}))
    with Host(label, cmd, env, result_fn=html_result):
        c = Client("tok-alpha")
        r = c.req("getHTML", {"tabId": 7})
        expect(r and "<redacted>" in json.dumps(r) and "123-45-6789" not in json.dumps(r),
               f"{label}: getHTML SSN should be redacted, got {r}")
        r = c.req("extractText", {"tabId": 7})
        expect(r and "<redacted>" in json.dumps(r) and "abc123" not in json.dumps(r),
               f"{label}: extractText bearer token should be redacted, got {r}")
        r = c.req("executeScript", {"tabId": 7, "code": "1"})
        expect(r and "<redacted>" in json.dumps(r) and "999-88-7777" not in json.dumps(r),
               f"{label}: executeScript SSN should be redacted, got {r}")
        c.close()

    # --- Batch redaction: each result item uses the corresponding step action ---
    write_policy(permissive_with(redactPatterns=[r"\d{3}-\d{2}-\d{4}", "(?i)bearer [a-z0-9]+"]))
    batch_steps = [
        {"action": "getCookies", "payload": {"domain": "example.com"}},
        {"action": "storageState", "payload": {}},
        {"action": "getHTML", "payload": {"tabId": 7}},
        {"action": "extractText", "payload": {"tabId": 7}},
        {"action": "executeScript", "payload": {"tabId": 7, "code": "1"}},
        {"action": "executeScriptCDP", "payload": {"tabId": 7, "code": "1"}},
        {"action": "batch", "payload": {"steps": [
            {"action": "getCookies", "payload": {"domain": "nested.example.com"}},
            {"action": "extractText", "payload": {"tabId": 7}},
        ]}},
    ]
    batch_payload = {"steps": batch_steps}
    batch_result = lambda a, p: [
        [{"name": "sid", "value": "cookie-secret"}],
        {"cookies": [{"name": "auth", "value": "storage-cookie"}],
         "origins": [{"localStorage": [{"name": "token", "value": "storage-token"},
                                       {"name": "safe", "value": "visible"}]}]},
        {"html": "<p>SSN 123-45-6789</p>"},
        {"text": "auth Bearer abc123 token"},
        {"val": "SSN 999-88-7777"},
        {"value": {"nested": "Bearer cdp999"}},
        [[{"name": "nested", "value": "nested-cookie"}], {"text": "nested Bearer nested123"}],
        {"unmatchedExtra": "Bearer extra999 111-22-3333"},
    ] if a == "batch" else {"echo": a}
    with Host(label, cmd, env, result_fn=batch_result):
        c = Client("tok-alpha")
        r = c.req("batch", batch_payload)
        rendered = json.dumps(r, sort_keys=True)
        expect(r and r.get("success") is True and isinstance(r.get("result"), list),
               f"{label}: batch redaction should preserve result array shape, got {r}")
        expect("cookie-secret" not in rendered and "storage-cookie" not in rendered and "storage-token" not in rendered and "nested-cookie" not in rendered,
               f"{label}: batch cookie/storage secrets should be redacted, got {r}")
        expect("123-45-6789" not in rendered and "abc123" not in rendered and "999-88-7777" not in rendered and "cdp999" not in rendered and "nested123" not in rendered,
               f"{label}: batch content redactPatterns should apply per step, got {r}")
        expect("visible" in rendered and "unmatchedExtra" in rendered and "extra999" not in rendered and "111-22-3333" not in rendered,
               f"{label}: batch redaction should preserve safe values and mask unmatched extras with redactPatterns, got {r}")
        c.close()

    # --- No redactPatterns: content passes through unchanged ---
    write_policy(PERMISSIVE)
    with Host(label, cmd, env, result_fn=lambda a, p: {"success": True, "html": "<p>SSN 123-45-6789</p>"}):
        c = Client("tok-alpha")
        r = c.req("getHTML", {"tabId": 7})
        expect(r and "123-45-6789" in json.dumps(r),
               f"{label}: getHTML without redactPatterns should be unchanged, got {r}")
        c.close()

    # --- Plan preflight: one verdict per step, nothing forwarded ---
    write_policy(permissive_with(deniedActions=["getCookies"],
                                 requireConfirmation=["executeScript"],
                                 deniedOrigins=["*://mail.google.com"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("policyCheck", {"plan": [
            {"action": "getTabs"},
            {"action": "getCookies", "payload": {"domain": "x.test"}},
            {"action": "executeScript", "payload": {"tabId": 7, "code": "1"}},
            {"action": "click", "payload": {"tabId": 7}, "origin": "https://mail.google.com"},
        ]})
        steps = ((r or {}).get("result") or {}).get("plan")
        expect(isinstance(steps, list) and len(steps) == 4,
               f"{label}: plan preflight should return one verdict per step, got {r}")
        if isinstance(steps, list) and len(steps) == 4:
            expect(all(set(s.keys()) == {"step", "action", "allowed", "reason",
                                         "confirmationRequired", "redact", "audit",
                                         "originDependent"} for s in steps),
                   f"{label}: plan step verdict keys = {[sorted(s.keys()) for s in steps]}")
            expect([s["step"] for s in steps] == [0, 1, 2, 3],
                   f"{label}: plan steps should be indexed in order, got {steps}")
            expect(steps[0]["allowed"] is True,
                   f"{label}: plan step 0 should be allowed, got {steps[0]}")
            expect(steps[1]["allowed"] is False and "denied" in str(steps[1]["reason"]),
                   f"{label}: plan step 1 should be denied, got {steps[1]}")
            expect(steps[2]["allowed"] is True and steps[2]["confirmationRequired"] is True,
                   f"{label}: plan step 2 should require confirmation, got {steps[2]}")
            expect(steps[3]["allowed"] is False and steps[3]["originDependent"] is False,
                   f"{label}: supplied origin should decide plan step 3, got {steps[3]}")
        expect(forwarded_actions() == [],
               f"{label}: plan preflight must not forward, got {forwarded_actions()}")
        r = c.req("policyCheck", {"plan": [{"action": "getTabs"}] * 51})
        expect(r and r.get("success") is False and "plan exceeds 50 steps" in str(r.get("error", "")),
               f"{label}: over-long plan should be rejected, got {r}")
        c.close()

    # --- dryRun: never forwards, and reports wouldForward per verdict ---
    write_policy(permissive_with(deniedActions=["getCookies"],
                                 requireConfirmation=["executeScript"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs", extra={"dryRun": True})
        expect(r and r.get("success") is True and r.get("dryRun") is True
               and r.get("wouldForward") is True,
               f"{label}: allowed dry run should report wouldForward, got {r}")
        expect(set(((r or {}).get("verdict") or {}).keys()) ==
               {"allowed", "reason", "confirmationRequired", "redact", "audit", "originDependent"},
               f"{label}: dry run verdict keys = {sorted(((r or {}).get('verdict') or {}).keys())}")
        r = c.req("getCookies", {"domain": "x.test"}, extra={"dryRun": True})
        expect(r and r.get("success") is True and r.get("dryRun") is True
               and r.get("wouldForward") is False
               and ((r.get("verdict") or {}).get("allowed") is False),
               f"{label}: denied dry run should report wouldForward false, got {r}")
        r = c.req("executeScript", {"tabId": 7, "code": "1"}, extra={"dryRun": True})
        expect(r and r.get("wouldForward") is False
               and ((r.get("verdict") or {}).get("confirmationRequired") is True)
               and "confirmationToken" not in r,
               f"{label}: confirmation-gated dry run should not mint a token, got {r}")
        expect(forwarded_actions() == [],
               f"{label}: dry run must never forward, got {forwarded_actions()}")
        c.close()

    # --- Secret masking: secretMaskFile values are masked in nested fields ---
    with open(SECRETS_FILE, "w") as f:
        f.write("# masked values\napiKey=sup3r-secret-value\n")
    os.chmod(SECRETS_FILE, 0o600)
    write_policy(permissive_with(secretMaskFile=SECRETS_FILE))
    secret_result = lambda a, p: {"success": True, "result": {
        "outer": "prefix sup3r-secret-value suffix",
        "nested": {"deep": ["carrying sup3r-secret-value"]},
    }}
    with Host(label, cmd, env, result_fn=secret_result):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        rendered = json.dumps(r)
        expect("sup3r-secret-value" not in rendered,
               f"{label}: secretMaskFile value must never reach the client, got {r}")
        expect(rendered.count("<masked:apiKey>") == 2,
               f"{label}: secret masking should replace nested occurrences, got {r}")
        c.close()
    try:
        os.remove(SECRETS_FILE)
    except FileNotFoundError:
        pass



def check_example_policy_is_conservative():
    policy_path = os.path.join(SCRIPT_DIR, "bridge_policy.example.json")
    with open(policy_path) as f:
        policy = json.load(f)
    client = policy.get("clients", {}).get("default", {})
    allowed = set(client.get("allowedOrigins") or [])
    expected = {"https://github.com", "https://chatgpt.com", "https://claude.ai",
                "https://google.com", "https://accounts.google.com"}
    expect(allowed == expected,
           f"example policy should keep a narrow onboarding allow-list, got {sorted(allowed)}")
    privileged = {
        "https://mail.google.com", "https://drive.google.com", "https://calendar.google.com",
        "https://vercel.com", "https://app.vercel.com", "https://dashboard.cloudflare.com",
        "https://dash.cloudflare.com", "https://dashboard.stripe.com",
        "https://console.aws.amazon.com", "https://*.console.aws.amazon.com",
        "https://console.cloud.google.com", "https://portal.azure.com",
        "https://platform.openai.com", "https://paypal.com", "https://venmo.com",
        "https://x.com", "https://twitter.com", "https://www.linkedin.com",
        "https://www.facebook.com", "https://www.instagram.com", "https://www.threads.net",
    }
    leaked = allowed & privileged
    expect(not leaked, f"example policy must not ship privileged/personal origins: {sorted(leaked)}")


def check_classification_parity():
    """Static guard: the 5 emulate actions must be classified mutating in BOTH
    hosts, and Python's MUTATING_ACTIONS must match the Rust mutating_actions()
    string list. Behavioral tests don't exercise classification directly, so this
    catches host-to-host drift (e.g. an action added to Rust but not Python)."""
    sys.path.insert(0, SCRIPT_DIR)
    import re
    import bridge
    emulate = {"setCpuThrottling", "setNetworkConditions",
               "clearNetworkConditions", "setColorScheme", "setUserAgent"}
    missing = emulate - bridge.MUTATING_ACTIONS
    expect(not missing,
           f"python: emulate actions missing from MUTATING_ACTIONS: {sorted(missing)}")

    rs = open(os.path.join(SCRIPT_DIR, "host-rs", "src", "main.rs")).read()
    m = re.search(r"fn mutating_actions\(\)[^{]*\{\s*&\[(.*?)\]", rs, re.S)
    expect(m is not None, "rust: could not locate mutating_actions() list")
    if m:
        rust_mut = set(re.findall(r'"([^"]+)"', m.group(1)))
        expect(not (emulate - rust_mut),
               f"rust: emulate actions missing from mutating_actions(): {sorted(emulate - rust_mut)}")
        expect(bridge.MUTATING_ACTIONS == rust_mut,
               "python/rust MUTATING parity drift: "
               f"py-only={sorted(bridge.MUTATING_ACTIONS - rust_mut)} "
               f"rust-only={sorted(rust_mut - bridge.MUTATING_ACTIONS)}")


def main():
    check_classification_parity()
    check_example_policy_is_conservative()
    env = make_env()
    python_cmd = [sys.executable, os.path.join(SCRIPT_DIR, "bridge.py")]
    check_python_origin_approval(python_cmd, env)
    run_against("python", python_cmd, env)

    rust_bin = os.path.join(SCRIPT_DIR, "host-rs", "target", "release", "bridge-host")
    try:
        meta = json.loads(subprocess.check_output(
            ["cargo", "metadata", "--format-version", "1", "--no-deps",
             "--manifest-path", os.path.join(SCRIPT_DIR, "host-rs", "Cargo.toml")]))
        rust_bin = os.path.join(meta["target_directory"], "release", "bridge-host")
    except Exception:
        pass
    if os.path.exists(rust_bin):
        run_against("rust", [rust_bin], env)
    else:
        print("\n(skipping rust host: binary not built)")

    if failures:
        print(f"\n{len(failures)} guardrails contract failure(s).")
        sys.exit(1)
    print("\nGuardrails contract OK (both hosts)")


if __name__ == "__main__":
    main()
