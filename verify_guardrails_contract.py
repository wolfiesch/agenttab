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
import hashlib
import json
import os
import shutil
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
# Full forwarded envelopes, so a case can assert host-stamped fields that live
# OUTSIDE payload (e.g. the DLP channel modes stamped as `dlp`).
forwarded_messages = []

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
            forwarded_messages.append(msg)
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
SECRETS_FILE_B = "/tmp/chrome-bridge-guard-secrets-b.txt"
TRACE_DIR = "/tmp/chrome-bridge-guard-traces"
OTEL_FILE = "/tmp/chrome-bridge-guard-otel.jsonl"
SCHEDULE_FILE = "/tmp/chrome-bridge-guard-schedules.json"
WORKFLOW_FILE = "/tmp/chrome-bridge-guard-workflow.json"
BAD_WORKFLOW_FILE = "/tmp/chrome-bridge-guard-workflow-invalid.json"
BUNDLE_FILE = "/tmp/chrome-bridge-guard-bundle.json"
BUNDLE_LOCK_FILE = "/tmp/chrome-bridge-guard-bundle.lock"
EXPORT_FILE = "/tmp/chrome-bridge-guard-export.jsonl"
EXPORT_CEF_FILE = "/tmp/chrome-bridge-guard-export.cef"
EXPORT_DEAD_DIR = "/tmp/chrome-bridge-guard-export-missing"
# A FIFO export destination: both hosts open a file sink with a blocking
# open(2), so a reader-less FIFO holds the export worker deterministically.
EXPORT_FIFO = "/tmp/chrome-bridge-guard-export.fifo"
EXPORT_SWITCH_FILE = "/tmp/chrome-bridge-guard-export-switched.jsonl"


def write_policy(policy):
    with open(POLICY_FILE, "w") as f:
        json.dump(policy, f)


def write_bundle(document, bump=0):
    # ``bump`` advances the file's mtime so a rewrite is unambiguously a change
    # for the host's mtime-based reload check, with no sleep involved.
    with open(BUNDLE_FILE, "w") as f:
        json.dump(document, f)
    if bump:
        stamp = time.time() + bump
        os.utime(BUNDLE_FILE, (stamp, stamp))


def bundle_digest():
    with open(BUNDLE_FILE, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def write_bundle_lock(digest):
    with open(BUNDLE_LOCK_FILE, "w") as f:
        json.dump({"sha256": digest}, f)


def bundle_local_policy(**layers):
    # A local policy whose only job is to name the bundle, plus any local layer
    # the case wants to layer on top of it.
    policy = {"policyBundle": {"path": BUNDLE_FILE, "lockfile": BUNDLE_LOCK_FILE}}
    policy.update(layers)
    return policy


def bundle_rejections():
    return [e for e in audit_events() if e.get("decision") == "policy_bundle_rejected"]



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
            forwarded_messages.clear()
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


def wait_until_forwarded(action, timeout=10.0):
    # Deterministic barrier for the in-flight-handoff cases. A handoff is only
    # registered once the host actually forwards it, so probing after a fixed
    # sleep is a race: whichever host is slower to start loses it, and which
    # case fails then depends on process scheduling rather than on behavior.
    # Block until the mock extension has actually seen the forward.
    deadline = time.time() + timeout
    while time.time() < deadline:
        if action in forwarded_actions():
            return True
        time.sleep(0.02)
    return False


def export_text(path=EXPORT_FILE):
    # Raw sink bytes, so a case can assert a secret never reaches the SIEM.
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return ""


def export_lines(path=EXPORT_FILE):
    return [line for line in export_text(path).splitlines() if line.strip()]


def wait_until_exported(count, path=EXPORT_FILE, timeout=10.0):
    # Same discipline as wait_until_forwarded: the export sink is written after
    # the local audit append returns, so any fixed sleep is a race against host
    # startup. Block until the sink actually holds ``count`` lines.
    deadline = time.time() + timeout
    while time.time() < deadline:
        if len(export_lines(path)) >= count:
            return True
        time.sleep(0.02)
    return False


def wait_until_audited(decision, count, timeout=10.0):
    # Barrier for audit events a BACKGROUND thread writes. audit_export_unavailable
    # is discovered by the export worker, not by the request thread, so the
    # request that triggered it has already returned by the time the event lands:
    # polling the audit log is the only race-free way to observe it, exactly like
    # wait_until_exported for the sink. Returns the matching events once at least
    # ``count`` are present, else whatever is present at the deadline, so a case
    # can assert "exactly one" over a bounded window without a fixed sleep.
    deadline = time.time() + timeout
    while True:
        events = [e for e in audit_events() if e.get("decision") == decision]
        if len(events) >= count or time.time() >= deadline:
            return events
        time.sleep(0.02)


def wait_until(predicate, timeout=10.0):
    # Generic polling barrier for a condition a BACKGROUND thread satisfies.
    # Prefer this over a count-based barrier whenever a case cares about a
    # SPECIFIC event: a count can be satisfied by unrelated earlier events, so
    # "at least N lines arrived" is not evidence that the line under test did.
    deadline = time.time() + timeout
    while True:
        if predicate():
            return True
        if time.time() >= deadline:
            return False
        time.sleep(0.02)


def wait_until_datagram_matching(received, predicate, timeout=10.0):
    # Poll for a datagram the case actually asserts on, not for a datagram
    # COUNT. The export worker emits every audit event, so a count barrier for
    # "the denial arrived" is satisfied by the earlier allow events and the
    # assertion then races the datagram it is about.
    def seen():
        with forwarded_lock:
            return any(predicate(line) for line in received)

    return wait_until(seen, timeout)


def wait_until_export_matching(fragment, path=EXPORT_FILE, timeout=10.0):
    # Same discipline for a file sink: poll for the specific bytes under test.
    return wait_until(lambda: fragment in export_text(path), timeout)


def make_blocking_fifo(path):
    # A FIFO with no reader is the one export destination that blocks the worker
    # DETERMINISTICALLY and indefinitely: both hosts open a file sink with a
    # plain blocking open(2), which on a FIFO does not return until a reader
    # arrives. That turns "events are still queued" from a timing hope into a
    # structural fact, with no sleep and no timeout involved -- the worker cannot
    # advance past the first event until the case opens the read end.
    remove_paths(path)
    os.mkfifo(path, 0o600)


class FifoReader:
    """Opens a FIFO's read end (releasing the export worker) and drains it."""

    def __init__(self, path):
        self.path = path
        self.chunks = []
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.fd = None
        self.thread = None

    def release(self):
        # Opening the read end is what unblocks the worker's pending open(2).
        self.fd = os.open(self.path, os.O_RDONLY | os.O_NONBLOCK)
        self.thread = threading.Thread(target=self._drain, daemon=True)
        self.thread.start()

    def _drain(self):
        while not self.stop.is_set():
            try:
                data = os.read(self.fd, 65536)
            except BlockingIOError:
                time.sleep(0.02)
                continue
            except OSError:
                return
            if not data:
                time.sleep(0.02)
                continue
            with self.lock:
                self.chunks.append(data.decode("utf-8", "replace"))

    def text(self):
        with self.lock:
            return "".join(self.chunks)

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=2)
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None


def reload_policy_barrier(client, policy, label):
    # Install ``policy`` and block until the host has actually reloaded it,
    # observed on the REQUEST thread rather than after a sleep. Policy reload is
    # mtime-keyed and happens on the next request, so the barrier is: make the
    # new policy deny getTabs, then poll getTabs until it is denied. The mtime is
    # advanced explicitly so a rewrite is unambiguously a change. The barrier is
    # deliberately request-side: the export worker may be blocked, so nothing
    # observable on the SINK can prove the reload happened.
    policy = dict(policy)
    default = dict(policy["default"])
    default["deniedActions"] = sorted(set(default.get("deniedActions") or []) | {"getTabs"})
    policy["default"] = default
    write_policy(policy)
    stamp = time.time() + 1
    os.utime(POLICY_FILE, (stamp, stamp))
    deadline = time.time() + 10.0
    while time.time() < deadline:
        r = client.req("getTabs")
        if r and r.get("success") is False:
            return True
        time.sleep(0.02)
    expect(False, f"{label}: the host never reloaded the switched policy")
    return False


def remove_paths(*paths):
    for path in paths:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def trace_text(trace_id):
    # Raw artifact bytes, so a case can assert page content never reaches it.
    try:
        with open(os.path.join(TRACE_DIR, trace_id + ".jsonl")) as f:
            return f.read()
    except FileNotFoundError:
        return ""


def trace_events(trace_id):
    return [json.loads(l) for l in trace_text(trace_id).splitlines() if l.strip()]


def otel_spans(documents):
    # Flatten OTLP/HTTP JSON documents into their spans.
    return [span
            for document in documents
            for resource_spans in document.get("resourceSpans") or []
            for scope_spans in resource_spans.get("scopeSpans") or []
            for span in scope_spans.get("spans") or []]


def forwarded_actions():
    with forwarded_lock:
        return [a for a, _ in forwarded]


def forwarded_envelopes():
    # (action, whole envelope) per forward, for fields outside payload.
    with forwarded_lock:
        return [(m.get("action"), m) for m in forwarded_messages]


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
        expect(set(res.keys()) == {"allowed", "reason", "confirmationRequired", "redact", "audit",
                                   "originDependent", "siteMode", "effectiveTier", "dlp"},
               f"{label}: policyCheck result keys = {sorted(res.keys())}")
        expect(res.get("effectiveTier") == "mutating",
               f"{label}: policyCheck getCookies should report a mutating effectiveTier, got {res}")
        expect(res.get("siteMode") is None,
               f"{label}: policyCheck with no siteModes configured should report null, got {res}")
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

    # --- siteModes: manual gates a mutation on a matching origin even with an
    #     empty requireConfirmation, and leaves other origins alone ---
    write_policy(permissive_with(siteModes={"*://mail.google.com": "manual"}))
    set_tab_origins({None: "https://github.com", 7: "https://mail.google.com"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: siteMode manual should gate navigate on the matching origin, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: siteMode manual must not forward before confirmation, got {forwarded_actions()}")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is True,
               f"{label}: siteMode manual must not affect a non-matching origin, got {r}")
        # Non-mutating read on a manual origin stays ungated: manual gates
        # mutations and high-risk reads, not observation.
        r = c.req("getHTML", {"tabId": 7})
        expect(r and r.get("success") is True,
               f"{label}: siteMode manual should not gate getHTML, got {r}")
        c.close()
    set_tab_origins({None: "https://github.com"})

    # --- siteModes: skip waives a listed confirmation, except for the
    #     non-skippable set, and records the waiver in the audit log ---
    write_policy(permissive_with(requireConfirmation=["navigate", "getCookies"],
                                 siteModes={"*://mail.google.com": "skip"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is True and "confirmationToken" not in r,
               f"{label}: siteMode skip should waive the navigate confirmation without a token, got {r}")
        r = c.req("getCookies", {"domain": "mail.google.com"})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: siteMode skip must never waive non-skippable getCookies, got {r}")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: siteMode skip must not waive a non-matching origin, got {r}")
        c.close()
        time.sleep(0.3)
        waived = [e for e in audit_events() if e["decision"] == "confirmation_waived"]
        expect(len(waived) == 1 and waived[0]["action"] == "navigate"
               and waived[0]["reason"] == "siteMode skip",
               f"{label}: skip-waived confirmation should be audited exactly once, got {waived}")

    # --- siteModes never widen a gate: a denied origin and a denied action both
    #     outrank skip/manual ---
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"],
                                 requireConfirmation=["navigate"],
                                 siteModes={"*://mail.google.com": "skip"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: target denied",
               f"{label}: denied origin must outrank siteMode skip, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: denied origin must not forward under siteMode skip, got {forwarded_actions()}")
        c.close()
    write_policy(permissive_with(deniedActions=["navigate"],
                                 siteModes={"*://mail.google.com": "manual"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action navigate denied",
               f"{label}: denied action must outrank siteMode manual, got {r}")
        c.close()

    # --- siteModes: policyCheck reports the resolved mode, and the most
    #     specific (longest) matching pattern wins ---
    write_policy(permissive_with(siteModes={"*://*.google.com": "skip",
                                            "*://mail.google.com": "manual"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("policyCheck", {"action": "navigate",
                                  "payload": {"url": "https://mail.google.com/mail"}})
        res = (r or {}).get("result") or {}
        expect(res.get("siteMode") == "manual" and res.get("confirmationRequired") is True,
               f"{label}: longest matching siteModes pattern should win, got {res}")
        r = c.req("policyCheck", {"action": "navigate",
                                  "payload": {"url": "https://docs.google.com/d"}})
        res = (r or {}).get("result") or {}
        expect(res.get("siteMode") == "skip",
               f"{label}: wildcard siteModes pattern should apply elsewhere, got {res}")
        r = c.req("policyCheck", {"action": "getTabs"})
        res = (r or {}).get("result") or {}
        expect(res.get("siteMode") is None,
               f"{label}: siteMode should be null when no origin is known, got {res}")
        c.close()

    # --- siteModes merge per pattern: a client layer overrides only the pattern
    #     it names and inherits the rest of the default layer's modes ---
    write_policy({"default": {"allowedActions": ["*"], "deniedActions": [],
                              "allowedOrigins": ["*"], "deniedOrigins": [],
                              "requireConfirmation": [], "redact": True, "audit": True,
                              "siteModes": {"*://mail.google.com": "manual",
                                            "*://docs.google.com": "manual"}},
                 "clients": {"alpha": {"siteModes": {"*://docs.google.com": "auto"}}}})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("confirmationRequired") is True,
               f"{label}: inherited default siteMode must survive a client override, got {r}")
        r = c.req("navigate", {"url": "https://docs.google.com/d"})
        expect(r and r.get("success") is True,
               f"{label}: client layer should override the same siteModes pattern, got {r}")
        c.close()

    # --- DLP: block on `upload` denies uploadFile with `dlp blocked` and does
    #     not forward, so no file is ever opened on the request's behalf ---
    write_policy(permissive_with(dlp={"upload": "block"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("uploadFile", {"tabId": 7, "selector": "#f", "files": ["/tmp/dlp-fixture.txt"]})
        expect(r and r.get("success") is False and r.get("error") == "policy denied: dlp blocked",
               f"{label}: dlp block on upload should deny uploadFile, got {r}")
        denial = (r or {}).get("policyDenial") or {}
        expect(denial.get("kind") == "dlp" and denial.get("dlpChannel") == "upload"
               and denial.get("action") == "uploadFile",
               f"{label}: dlp denial should name the channel and action, got {denial}")
        expect("uploadFile" not in forwarded_actions(),
               f"{label}: a dlp-blocked upload must not forward, got {forwarded_actions()}")
        # The other upload chokepoints share the channel.
        r = c.req("githubAttachPrBody", {"tabId": 7, "files": ["/tmp/dlp-fixture.txt"]})
        expect(r and r.get("error") == "policy denied: dlp blocked",
               f"{label}: dlp block on upload should cover githubAttachPrBody, got {r}")
        # A channel with no configured mode stays exactly as before.
        r = c.req("downloadUrl", {"url": "https://github.com/x.zip"})
        expect(r and r.get("success") is True,
               f"{label}: an unconfigured dlp channel must not be gated, got {r}")
        c.close()

    # --- DLP: audit permits the action and writes exactly one dlp_audit event
    #     naming the channel, with no file name or path anywhere in it ---
    write_policy(permissive_with(dlp={"upload": "audit"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("uploadFile", {"tabId": 7, "selector": "#f", "files": ["/tmp/dlp-secret-name.txt"]})
        expect(r and r.get("success") is True,
               f"{label}: dlp audit should permit uploadFile, got {r}")
        expect(wait_until_forwarded("uploadFile"),
               f"{label}: dlp audit should forward uploadFile, got {forwarded_actions()}")
        c.close()
        events = [e for e in audit_events() if e["decision"] == "dlp_audit"]
        expect(len(events) == 1 and events[0]["action"] == "uploadFile"
               and events[0]["reason"] == "upload",
               f"{label}: dlp audit should write exactly one channel-named event, got {events}")
        expect(all(set(e.keys()) == AUDIT_KEYS for e in events),
               f"{label}: dlp_audit event keys = {[sorted(e.keys()) for e in events]}")
        expect("dlp-secret-name" not in json.dumps(events),
               f"{label}: a dlp_audit event must record no file name, got {events}")

    # --- DLP: block on `download` denies downloadUrl ---
    write_policy(permissive_with(dlp={"download": "block"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("downloadUrl", {"url": "https://github.com/x.zip"})
        expect(r and r.get("success") is False and r.get("error") == "policy denied: dlp blocked",
               f"{label}: dlp block on download should deny downloadUrl, got {r}")
        expect("downloadUrl" not in forwarded_actions(),
               f"{label}: a dlp-blocked download must not forward, got {forwarded_actions()}")
        c.close()

    # --- DLP: block on `screenShare` denies startScreencast (and the frame read) ---
    write_policy(permissive_with(dlp={"screenShare": "block"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("startScreencast", {"tabId": 7})
        expect(r and r.get("success") is False and r.get("error") == "policy denied: dlp blocked",
               f"{label}: dlp block on screenShare should deny startScreencast, got {r}")
        r = c.req("screencastFrames", {"tabId": 7})
        expect(r and r.get("error") == "policy denied: dlp blocked",
               f"{label}: dlp block on screenShare should deny screencastFrames, got {r}")
        expect("startScreencast" not in forwarded_actions()
               and "screencastFrames" not in forwarded_actions(),
               f"{label}: a dlp-blocked screen share must not forward, got {forwarded_actions()}")
        c.close()

    # --- DLP: a composite cannot smuggle a gated action; the denial carries the
    #     step index and names the smuggled step's own action ---
    write_policy(permissive_with(dlp={"upload": "block"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("batch", {"tabId": 7, "steps": [
            {"action": "getHTML", "payload": {}},
            {"action": "uploadFile", "payload": {"selector": "#f", "files": ["/tmp/dlp-fixture.txt"]}},
        ]})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: batch step 1: dlp blocked",
               f"{label}: a batch hiding a blocked upload should be denied with its step, got {r}")
        denial = (r or {}).get("policyDenial") or {}
        expect(denial.get("kind") == "dlp" and denial.get("batchStep") == 1
               and denial.get("dlpChannel") == "upload"
               and denial.get("action") == "uploadFile",
               f"{label}: batch dlp denial should name step, channel, and action, got {denial}")
        expect("uploadFile" not in forwarded_actions() and "batch" not in forwarded_actions(),
               f"{label}: a dlp-blocked batch must not forward, got {forwarded_actions()}")
        c.close()

    # --- DLP: policyCheck reports the resolved mode per channel, null off-channel,
    #     and a malformed mode fails CLOSED to block rather than being ignored ---
    write_policy(permissive_with(dlp={"upload": "audit", "download": "block",
                                      "screenShare": "sometimes"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("policyCheck", {"action": "uploadFile", "payload": {"tabId": 7}})
        expect(((r or {}).get("result") or {}).get("dlp") == "audit",
               f"{label}: policyCheck should report the resolved dlp mode, got {r}")
        r = c.req("policyCheck", {"action": "downloadUrl",
                                  "payload": {"url": "https://github.com/x.zip"}})
        res = (r or {}).get("result") or {}
        expect(res.get("dlp") == "block" and res.get("allowed") is False
               and res.get("reason") == "dlp blocked",
               f"{label}: policyCheck should report a blocked channel, got {res}")
        r = c.req("policyCheck", {"action": "getTabs"})
        expect(((r or {}).get("result") or {}).get("dlp") is None,
               f"{label}: policyCheck should report null dlp off-channel, got {r}")
        r = c.req("startScreencast", {"tabId": 7})
        expect(r and r.get("success") is False and r.get("error") == "policy denied: dlp blocked",
               f"{label}: a malformed dlp mode must fail closed to block, got {r}")
        c.close()

    # --- DLP merges per channel: a client layer tightens one channel and inherits
    #     the default layer's other channels ---
    write_policy({"default": {"allowedActions": ["*"], "deniedActions": [],
                              "allowedOrigins": ["*"], "deniedOrigins": [],
                              "requireConfirmation": [], "redact": True, "audit": True,
                              "dlp": {"upload": "block", "download": "audit"}},
                  "clients": {"alpha": {"dlp": {"upload": "allow"}}}})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("uploadFile", {"tabId": 7, "selector": "#f", "files": ["/tmp/dlp-fixture.txt"]})
        expect(r and r.get("success") is True,
               f"{label}: a client layer should be able to relax one dlp channel, got {r}")
        r = c.req("policyCheck", {"action": "downloadUrl",
                                  "payload": {"url": "https://github.com/x.zip"}})
        expect(((r or {}).get("result") or {}).get("dlp") == "audit",
               f"{label}: an unnamed dlp channel must survive a client override, got {r}")
        c.close()

    # --- Absent dlp preserves current behavior exactly: no gate, no dlp_audit
    #     event, and no `dlp` field stamped on the forwarded envelope ---
    write_policy(PERMISSIVE)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        for action, payload in (("uploadFile", {"tabId": 7, "selector": "#f", "files": ["/tmp/f.txt"]}),
                                ("downloadUrl", {"url": "https://github.com/x.zip"}),
                                ("startScreencast", {"tabId": 7})):
            r = c.req(action, payload)
            expect(r and r.get("success") is True,
                   f"{label}: absent dlp should leave {action} untouched, got {r}")
        c.close()
        time.sleep(0.3)
        expect(not [e for e in audit_events() if e["decision"] == "dlp_audit"],
               f"{label}: absent dlp must write no dlp_audit event")
        expect(not [p for a, p in forwarded_envelopes() if "dlp" in p],
               f"{label}: absent dlp must not stamp a dlp field on the envelope")

    # --- DLP stamps the enforcing modes on the forwarded envelope, always
    #     overwriting a client-supplied value so a caller cannot loosen it ---
    write_policy(permissive_with(dlp={"upload": "audit", "download": "block"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("uploadFile", {"tabId": 7, "selector": "#f", "files": ["/tmp/f.txt"]},
                  extra={"dlp": {"upload": "allow", "download": "allow"}})
        expect(r and r.get("success") is True,
               f"{label}: audit-mode upload should still forward, got {r}")
        expect(wait_until_forwarded("uploadFile"),
               f"{label}: audit-mode upload should reach the extension, got {forwarded_actions()}")
        stamped = [p.get("dlp") for a, p in forwarded_envelopes() if a == "uploadFile"]
        expect(stamped == [{"upload": "audit", "download": "block"}],
               f"{label}: host must overwrite the envelope dlp field, got {stamped}")
        c.close()

    # --- Effective tier: a read-only action whose payload sets a state-changing
    #     flag is treated as mutating, so `manual` gates it. screencastFrames
    #     drains the frame buffer unless the caller passes consume: false ---
    write_policy(permissive_with(siteModes={"*://mail.google.com": "manual"}))
    set_tab_origins({None: "https://github.com", 7: "https://mail.google.com"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("screencastFrames", {"tabId": 7, "consume": True})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: consuming screencastFrames should be gated by manual, got {r}")
        expect("screencastFrames" not in forwarded_actions(),
               f"{label}: escalated screencastFrames must not forward, got {forwarded_actions()}")
        r = c.req("screencastFrames", {"tabId": 7, "consume": False})
        expect(r and r.get("success") is True,
               f"{label}: non-consuming screencastFrames should stay read-only, got {r}")
        expect("screencastFrames" in forwarded_actions(),
               f"{label}: non-consuming screencastFrames should forward, got {forwarded_actions()}")
        # An omitted consume defaults to true in the extension, so it escalates.
        r = c.req("screencastFrames", {"tabId": 7})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: screencastFrames with a defaulted consume should be gated, got {r}")
        c.close()

    # --- Effective tier: batch is the union over its steps, so an all-read-only
    #     batch is not force-gated by manual and one mutating step gates it ---
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("batch", {"tabId": 7, "steps": [{"action": "getHTML", "payload": {}}]})
        expect(r and r.get("success") is True,
               f"{label}: an all-read-only batch must not be force-gated by manual, got {r}")
        r = c.req("batch", {"tabId": 7, "steps": [
            {"action": "getHTML", "payload": {}},
            {"action": "click", "payload": {"selector": "#x"}}]})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: a batch with one mutating step should be gated by manual, got {r}")
        expect("click" not in forwarded_actions(),
               f"{label}: gated batch must not forward its steps, got {forwarded_actions()}")
        c.close()

    # --- Effective tier: replayWorkflow follows the same union rule. The first
    #     step pins the manual tab so the outer replay resolves that origin; the
    #     second step decides the union without being gated on its own ---
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("replayWorkflow", {"tabId": 7, "workflow": {"steps": [
            {"action": "getHTML", "payload": {"tabId": 7}},
            {"action": "getHTML", "payload": {}}]}})
        expect(r and r.get("success") is True,
               f"{label}: an all-read-only replayWorkflow must not be gated, got {r}")
        r = c.req("replayWorkflow", {"tabId": 7, "workflow": {"steps": [
            {"action": "getHTML", "payload": {"tabId": 7}},
            {"action": "reload", "payload": {}}]}})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: a replayWorkflow with a mutating step should be gated, got {r}")
        expect("reload" not in forwarded_actions(),
               f"{label}: gated replayWorkflow must not forward its steps, got {forwarded_actions()}")
        # policyCheck reports the resolved tier for both shapes.
        r = c.req("policyCheck", {"action": "batch", "payload": {
            "tabId": 7, "steps": [{"action": "getHTML", "payload": {}}]}})
        expect(((r or {}).get("result") or {}).get("effectiveTier") == "read_only",
               f"{label}: policyCheck should report a read_only batch, got {r}")
        r = c.req("policyCheck", {"action": "batch", "payload": {
            "tabId": 7, "steps": [{"action": "click", "payload": {"selector": "#x"}}]}})
        expect(((r or {}).get("result") or {}).get("effectiveTier") == "mutating",
               f"{label}: policyCheck should report a mutating batch, got {r}")
        r = c.req("screencastFrames", {"tabId": 7, "consume": False}, extra={"dryRun": True})
        expect(((r or {}).get("verdict") or {}).get("effectiveTier") == "read_only",
               f"{label}: dry run should report the payload-resolved tier, got {r}")
        r = c.req("screencastFrames", {"tabId": 7, "consume": True}, extra={"dryRun": True})
        expect(((r or {}).get("verdict") or {}).get("effectiveTier") == "mutating",
               f"{label}: dry run should escalate a consuming screencastFrames, got {r}")
        c.close()
    set_tab_origins({None: "https://github.com"})

    # --- Effective tier: cacheSelectors escalates on the mutating ops only ---
    write_policy(permissive_with(siteModes={"*://github.com": "manual"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("cacheSelectors", {"op": "list"})
        expect(r and r.get("success") is True,
               f"{label}: cacheSelectors list should stay read-only, got {r}")
        for op in ("clear", "import"):
            r = c.req("cacheSelectors", {"op": op})
            expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
                   f"{label}: cacheSelectors {op} should be gated by manual, got {r}")
        c.close()

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
        expect(set(res.keys()) == {"policyFile", "policyFileExists", "auditLogFile", "traceDir",
                                   "policyBundle", "client"},
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

    # --- CLI `policy site-mode` / `clear-site-mode` write a siteModes entry the
    #     host honors, and leave the rest of the policy intact ---
    write_policy({"default": {"allowedActions": ["*"], "deniedActions": [],
                              "allowedOrigins": ["*"], "deniedOrigins": [],
                              "requireConfirmation": [], "redact": True, "audit": True}})
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_policy(["test_client.py", "policy", "site-mode",
                              "*://mail.google.com", "manual"])
    expect(_rc == 0, f"{label}: CLI policy site-mode should succeed, got rc={_rc}")
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_policy(["test_client.py", "policy", "site-mode",
                              "*://mail.google.com", "bogus"])
    expect(_rc == 2, f"{label}: CLI policy site-mode should reject an unknown mode, got rc={_rc}")
    time.sleep(1.1)  # let the policy file mtime advance for hot-reload
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("confirmationRequired") is True,
               f"{label}: host should honor a CLI-written manual siteMode, got {r}")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is True,
               f"{label}: CLI site-mode must not affect other origins, got {r}")
        c.close()
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_policy(["test_client.py", "policy", "clear-site-mode",
                              "*://mail.google.com"])
    expect(_rc == 0, f"{label}: CLI policy clear-site-mode should succeed, got rc={_rc}")
    time.sleep(1.1)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is True,
               f"{label}: clearing the siteMode should restore auto behavior, got {r}")
        c.close()

    # --- CLI `schedule`: validates the workflow file contract and writes local
    #     metadata only. No host action, no daemon, nothing forwarded. ---
    _tc.SCHEDULE_FILE = SCHEDULE_FILE
    _forwarded_before = forwarded_actions()
    if os.path.exists(SCHEDULE_FILE):
        os.unlink(SCHEDULE_FILE)
    with open(WORKFLOW_FILE, "w") as f:
        json.dump({"version": 1, "name": "nightly-report",
                   "steps": [{"action": "navigate", "payload": {"url": "https://github.com"}},
                             {"action": "click", "payload": {"tabId": 7}, "wait": 500}],
                   "policy": {"requiredOrigins": ["https://github.com"]}}, f)
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_schedule(["test_client.py", "schedule", "workflow", WORKFLOW_FILE,
                                "--interval", "3600"])
    expect(_rc == 0, f"{label}: schedule workflow --interval should succeed, got rc={_rc}")
    _registry = json.load(open(SCHEDULE_FILE))
    _entries = _registry.get("schedules") or []
    expect(len(_entries) == 1 and _entries[0].get("name") == "nightly-report"
           and _entries[0].get("trigger") == {"kind": "interval", "seconds": 3600}
           and _entries[0].get("steps") == 2
           and _entries[0].get("requiredOrigins") == ["https://github.com"],
           f"{label}: schedule registry entry = {_entries}")
    expect("payload" not in json.dumps(_registry),
           f"{label}: schedule registry must record metadata only, never step payloads")
    expect(oct(os.stat(SCHEDULE_FILE).st_mode & 0o777) == oct(0o600),
           f"{label}: schedule registry must be mode 600, got {oct(os.stat(SCHEDULE_FILE).st_mode & 0o777)}")
    # Exactly one trigger is required, and an unknown flag is rejected.
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_schedule(["test_client.py", "schedule", "workflow", WORKFLOW_FILE,
                                "--at", "2026-08-01T09:00:00", "--interval", "3600"])
    expect(_rc == 2, f"{label}: schedule with both triggers should be rejected, got rc={_rc}")
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_schedule(["test_client.py", "schedule", "workflow", WORKFLOW_FILE])
    expect(_rc == 2, f"{label}: schedule with no trigger should be rejected, got rc={_rc}")
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_schedule(["test_client.py", "schedule", "workflow", WORKFLOW_FILE,
                                "--interval", "30"])
    expect(_rc == 2, f"{label}: schedule interval below 60s should be rejected, got rc={_rc}")
    # An --at schedule replaces the same name rather than duplicating it.
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_schedule(["test_client.py", "schedule", "workflow", WORKFLOW_FILE,
                                "--at", "2026-08-01T09:00:00Z", "--name", "nightly-report"])
    expect(_rc == 0, f"{label}: schedule workflow --at should succeed, got rc={_rc}")
    _entries = (json.load(open(SCHEDULE_FILE)).get("schedules") or [])
    expect(len(_entries) == 1 and (_entries[0].get("trigger") or {}).get("kind") == "at",
           f"{label}: re-registering a name should replace it, got {_entries}")
    # A workflow file that violates the contract is rejected before anything is written.
    with open(BAD_WORKFLOW_FILE, "w") as f:
        json.dump({"version": 1, "name": "broken", "steps": [{"payload": {}}]}, f)
    try:
        with _ctx.redirect_stdout(_io.StringIO()):
            _tc.cmd_schedule(["test_client.py", "schedule", "workflow", BAD_WORKFLOW_FILE,
                              "--interval", "3600"])
        expect(False, f"{label}: a step with no action should be rejected")
    except SystemExit as _exc:
        expect(_exc.code == 2, f"{label}: invalid workflow should exit 2, got {_exc.code}")
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_schedule(["test_client.py", "schedule", "remove", "nightly-report"])
    expect(_rc == 0, f"{label}: schedule remove should succeed, got rc={_rc}")
    expect((json.load(open(SCHEDULE_FILE)).get("schedules") or []) == [],
           f"{label}: schedule remove should empty the registry")
    expect(forwarded_actions() == _forwarded_before,
           f"{label}: schedule commands must never forward an action, got {forwarded_actions()}")

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

    # --- replayWorkflow is policed step by step BEFORE it forwards -----------
    # A recorded workflow reproduces mutating actions inside the extension's
    # dispatch table, exactly like a batch, so the host must evaluate every
    # nested step before the outer replay is forwarded at all.
    def workflow_payload(steps, **extra):
        payload = {"workflow": {"version": 1, "name": "wf", "steps": steps}}
        payload.update(extra)
        return payload

    # (a) a denied nested action blocks the whole replay and forwards nothing.
    write_policy(permissive_with(deniedActions=["executeScript"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("replayWorkflow", workflow_payload([
            {"action": "click", "payload": {"tabId": 7, "selector": "#a"}},
            {"action": "executeScript", "payload": {"tabId": 7, "code": "1"}},
        ]))
        expect(r and r.get("success") is False
               and "workflow step 1: action executeScript denied" in str(r.get("error", "")),
               f"{label}: denied nested replay step should name step 1, got {r}")
        expect(forwarded_actions() == [],
               f"{label}: denied nested replay step must not forward, got {forwarded_actions()}")
        pd = (r or {}).get("policyDenial") or {}
        expect(pd.get("batchStep") == 1 and pd.get("action") == "executeScript",
               f"{label}: policyDenial should name failing workflow step 1, got {pd}")
        c.close()

    # (b) a reserved action can never be smuggled in as a workflow step.
    write_policy(PERMISSIVE)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("replayWorkflow", workflow_payload([
            {"action": "__tabOrigin", "payload": {"tabId": 1}}]))
        expect(r and r.get("success") is False and "workflow step 0:" in str(r.get("error", "")),
               f"{label}: reserved replay step must be denied, got {r}")
        expect("__tabOrigin" not in forwarded_actions(),
               f"{label}: reserved replay step must not forward")
        c.close()

    # (c) a confirmation-gated nested action fails the replay outright. There is
    # no aggregate token: one outer token cannot stand in for per-step approval,
    # so no token is minted and nothing forwards.
    write_policy(permissive_with(requireConfirmation=["setCookie"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("replayWorkflow", workflow_payload([
            {"action": "click", "payload": {"tabId": 7, "selector": "#a"}},
            {"action": "setCookie", "payload": {"url": "https://github.com", "name": "s", "value": "1"}},
        ]))
        expect(r and r.get("success") is False
               and "workflow step 1 requires confirmation" in str(r.get("error", "")),
               f"{label}: confirmation-gated replay step should fail the replay, got {r}")
        expect(r and r.get("confirmationToken") is None
               and r.get("confirmationRequired") is not True,
               f"{label}: a nested confirmation must not mint an outer token, got {r}")
        expect(forwarded_actions() == [],
               f"{label}: confirmation-gated replay step must not forward, got {forwarded_actions()}")
        c.close()

    # (d) nested steps that are all plainly allowed forward as one replay.
    write_policy(PERMISSIVE)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("replayWorkflow", workflow_payload([
            {"action": "click", "payload": {"tabId": 7, "selector": "#a"}}]))
        expect(r and r.get("success") is True,
               f"{label}: an allowed nested click should replay, got {r}")
        expect("replayWorkflow" in forwarded_actions(),
               f"{label}: allowed replay should forward, got {forwarded_actions()}")
        c.close()

    # (e) replay tabId retargeting is origin-checked: the caller's tabId replaces
    # the recorded one, so the LIVE origin of the target tab governs the step.
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    set_tab_origins({7: "https://mail.google.com", 9: "https://github.com"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("replayWorkflow", workflow_payload(
            [{"action": "click", "payload": {"tabId": 9, "selector": "#a"}}], tabId=7))
        expect(r and r.get("success") is False
               and "workflow step 0: target denied" in str(r.get("error", "")),
               f"{label}: replay retargeted at a denied-origin tab should be denied by the retargeted origin, got {r}")
        expect("replayWorkflow" not in forwarded_actions(),
               f"{label}: denied retargeted replay must not forward, got {forwarded_actions()}")
        c.close()
    set_tab_origins({None: "https://github.com"})

    # (f) T4-4: a step's `expect` clause is enumerated as a nested read-only
    # `expect` step, so a postcondition aimed at a denied-origin tab is denied
    # with the rest of the replay instead of riding in unexamined. The step's own
    # action must be genuinely origin-exempt so the ONLY enumerated step that can
    # need an origin is the expect clause: `navigate` carries its own url and is
    # in ORIGIN_EXEMPT_ACTIONS, whereas `setCookie` is not exempt and would drag
    # in the active tab (tabId None) and fail closed on that instead.
    write_policy(permissive_with(deniedOrigins=["*://mail.google.com"]))
    set_tab_origins({None: "https://github.com",
                     7: "https://mail.google.com",
                     9: "https://github.com"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("replayWorkflow", workflow_payload(
            [{"action": "navigate",
              "payload": {"url": "https://github.com/one"},
              "expect": {"mode": "selector", "selector": "#done"}}], tabId=7))
        expect(r and r.get("success") is False and "workflow step 1:" in str(r.get("error", "")),
               f"{label}: a nested expect clause on a denied origin should deny the replay, got {r}")
        pd = (r or {}).get("policyDenial") or {}
        # An origin denial identifies the step through `batchStep` plus the
        # offending origin in `targets`. It does NOT rename `action` to the
        # nested step: policy_denial() recovers a nested action only for
        # action-type reasons, where it is embedded in the byte-stable reason
        # text ("action <X> denied"). "target denied" carries no action name, and
        # the reason string is deliberately byte-stable, so the outer action
        # stays as-is rather than threading a step action through the whole
        # evaluate_policy return contract for one cosmetic field.
        expect(pd.get("batchStep") == 1 and pd.get("kind") == "origin"
               and "https://mail.google.com" in (pd.get("targets") or []),
               f"{label}: policyDenial should locate the enumerated expect step, got {pd}")
        expect("replayWorkflow" not in forwarded_actions(),
               f"{label}: a denied nested expect must not forward, got {forwarded_actions()}")
        c.close()
    set_tab_origins({None: "https://github.com"})

    # (g) an allowed expect clause replays normally, and `expect` is not itself a
    # denial trigger.
    write_policy(PERMISSIVE)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("replayWorkflow", workflow_payload(
            [{"action": "click", "payload": {"tabId": 7, "selector": "#a"},
              "expect": {"mode": "text", "text": "done"},
              "retry": {"max": 2, "delayMs": 100}}]))
        expect(r and r.get("success") is True,
               f"{label}: an allowed nested expect should replay, got {r}")
        expect("replayWorkflow" in forwarded_actions(),
               f"{label}: allowed replay with an expect clause should forward, got {forwarded_actions()}")
        c.close()

    # (h) `expect` is a non-mutating assertion, so a `manual` site mode - which
    # gates on the effective tier - must not force a confirmation for it, while a
    # real mutation on the same origin still is gated.
    write_policy(permissive_with(siteModes={"*://mail.google.com": "manual"}))
    set_tab_origins({None: "https://github.com", 7: "https://mail.google.com"})
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("expect", {"tabId": 7, "mode": "selector", "selector": "#done"})
        expect(r and r.get("success") is True,
               f"{label}: expect is read-only and must not be gated by manual, got {r}")
        r = c.req("reload", {"tabId": 7})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: manual should still gate a mutation on the same origin, got {r}")
        c.close()
    set_tab_origins({None: "https://github.com"})

    # --- egressAllowlist: host-side bound on where the agent may make the
    #     browser SEND traffic (T4-9) ------------------------------------------
    # (a) baseline: an absent/empty allowlist changes nothing.
    write_policy(permissive_with())
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://anywhere.test/x"})
        expect(r and r.get("success") is True,
               f"{label}: no egressAllowlist must leave navigate unconstrained, got {r}")
        c.close()
    write_policy(permissive_with(egressAllowlist=[]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://anywhere.test/x"})
        expect(r and r.get("success") is True,
               f"{label}: an empty egressAllowlist must preserve current behavior, got {r}")
        c.close()

    # (b) a configured allowlist denies an outside destination before forwarding
    #     and admits one inside it, for every action whose payload names the
    #     destination the host can see.
    write_policy(permissive_with(egressAllowlist=["*://github.com", "*://*.github.com"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        for action, payload in (
                ("navigate", {"url": "https://evil.test/x"}),
                ("navigateTaskSession", {"sessionId": "s1", "url": "https://evil.test/x"}),
                ("downloadUrl", {"url": "https://evil.test/f.zip"}),
                ("setCookie", {"url": "https://evil.test", "name": "s", "value": "1"})):
            r = c.req(action, payload)
            expect(r and r.get("success") is False
                   and r.get("error") == "policy denied: egress not allowed",
                   f"{label}: {action} outside egressAllowlist should be denied, got {r}")
            pd = (r or {}).get("policyDenial") or {}
            expect(pd.get("kind") == "egress"
                   and pd.get("targets") == ["https://evil.test", "*://evil.test"],
                   f"{label}: {action} egress denial should be kind=egress on the destination, got {pd}")
            expect(action not in forwarded_actions(),
                   f"{label}: {action} must not forward outside the egressAllowlist, got {forwarded_actions()}")
        for action, payload in (
                ("navigate", {"url": "https://github.com/x"}),
                ("downloadUrl", {"url": "https://raw.github.com/f.zip"}),
                ("setCookie", {"url": "https://github.com", "name": "s", "value": "1"})):
            r = c.req(action, payload)
            expect(r and r.get("success") is True,
                   f"{label}: {action} inside the egressAllowlist should proceed, got {r}")
        # Fail closed: an egress-bearing action whose destination the host cannot
        # resolve is denied, never forwarded unchecked.
        r = c.req("setCookie", {"name": "s", "value": "1"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: egress not allowed",
               f"{label}: setCookie with no resolvable destination should fail closed, got {r}")
        # The reason surfaces through policyCheck and dry run without any new field.
        r = c.req("policyCheck", {"action": "navigate",
                                  "payload": {"url": "https://evil.test/x"}})
        res = (r or {}).get("result") or {}
        expect(res.get("allowed") is False and res.get("reason") == "egress not allowed",
               f"{label}: policyCheck should surface the egress reason, got {res}")
        r = c.req("navigate", {"url": "https://evil.test/x"}, extra={"dryRun": True})
        expect(r and r.get("wouldForward") is False
               and ((r.get("verdict") or {}).get("reason")) == "egress not allowed",
               f"{label}: dry run should surface the egress reason, got {r}")
        c.close()

    # (c) composites cannot smuggle egress: the offending step is named by index.
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("batch", {"steps": [
            {"action": "getTabs", "payload": {}},
            {"action": "navigate", "payload": {"url": "https://evil.test/x"}}]})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: batch step 1: egress not allowed",
               f"{label}: a batch hiding an outside navigate should be denied by step, got {r}")
        pd = (r or {}).get("policyDenial") or {}
        expect(pd.get("kind") == "egress" and pd.get("batchStep") == 1,
               f"{label}: batch egress denial should report the step index, got {pd}")
        expect("batch" not in forwarded_actions(),
               f"{label}: a denied batch must not forward, got {forwarded_actions()}")
        r = c.req("replayWorkflow", {"workflow": {"version": 1, "name": "wf", "steps": [
            {"action": "downloadUrl", "payload": {"url": "https://evil.test/f.zip"}}]}})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: workflow step 0: egress not allowed",
               f"{label}: a workflow hiding an outside download should be denied by step, got {r}")
        expect("replayWorkflow" not in forwarded_actions(),
               f"{label}: a denied replay must not forward, got {forwarded_actions()}")
        r = c.req("batch", {"steps": [
            {"action": "navigate", "payload": {"url": "https://github.com/x"}}]})
        expect(r and r.get("success") is True,
               f"{label}: an all-inside batch should proceed, got {r}")
        c.close()

    # (d) egress never loosens site policy: a denied origin still wins even when
    #     the same host is on the egress allowlist.
    write_policy(permissive_with(deniedOrigins=["*://evil.test"],
                                 egressAllowlist=["*://evil.test"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://evil.test/x"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: target denied",
               f"{label}: a denied origin must outrank an egress grant, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: a denied origin must not forward under an egress grant, got {forwarded_actions()}")
        c.close()
    write_policy(permissive_with(deniedActions=["navigate"],
                                 egressAllowlist=["*://github.com"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action navigate denied",
               f"{label}: a denied action must outrank an egress grant, got {r}")
        c.close()

    # (e) the documented out-of-scope paths are genuinely out of scope, not
    #     silently denied. The host cannot see where a click-driven in-page
    #     navigation, a script-issued request, or a cookie DELETE sends traffic,
    #     so those actions stay governed by site policy alone.
    write_policy(permissive_with(egressAllowlist=["*://github.com"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        for action, payload in (
                ("click", {"tabId": 7, "selector": "a[href='https://evil.test']"}),
                ("executeScript", {"tabId": 7, "code": "fetch('https://evil.test')"}),
                ("deleteCookie", {"url": "https://evil.test", "name": "s"}),
                ("startInterception", {"tabId": 7, "urlPattern": "https://evil.test/*",
                                       "mode": "fulfill", "status": 200, "body": "x"})):
            r = c.req(action, payload)
            expect(r and r.get("success") is True,
                   f"{label}: {action} is out of egress scope and must not be egress-denied, got {r}")
        c.close()

    # (f) CLI `policy allow-egress` / `clear-egress` write an egressAllowlist the
    #     host honors, and leave the rest of the policy intact.
    write_policy({"default": {"allowedActions": ["*"], "deniedActions": [],
                              "allowedOrigins": ["*"], "deniedOrigins": [],
                              "requireConfirmation": [], "redact": True, "audit": True}})
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_policy(["test_client.py", "policy", "allow-egress", "*://github.com"])
    expect(_rc == 0, f"{label}: CLI policy allow-egress should succeed, got rc={_rc}")
    time.sleep(1.1)  # let the policy file mtime advance for hot-reload
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is True,
               f"{label}: host should honor a CLI-written egress grant, got {r}")
        r = c.req("navigate", {"url": "https://evil.test/x"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: egress not allowed",
               f"{label}: a CLI-written egressAllowlist should bound other hosts, got {r}")
        # Inherited grants must survive the edit (the replace-merge footgun).
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: inherited getTabs must survive CLI allow-egress, got {r}")
        c.close()
    with _ctx.redirect_stdout(_io.StringIO()):
        _rc = _tc.cmd_policy(["test_client.py", "policy", "clear-egress", "*://github.com"])
    expect(_rc == 0, f"{label}: CLI policy clear-egress should succeed, got rc={_rc}")
    time.sleep(1.1)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://evil.test/x"})
        expect(r and r.get("success") is True,
               f"{label}: clearing the last egress pattern should restore unconstrained egress, got {r}")
        c.close()

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
                                         "originDependent", "siteMode",
                                         "effectiveTier", "dlp"} for s in steps),
                   f"{label}: plan step verdict keys = {[sorted(s.keys()) for s in steps]}")
            expect([s["effectiveTier"] for s in steps]
                   == ["read_only", "mutating", "mutating", "mutating"],
                   f"{label}: plan preview should report effectiveTier per step, got {steps}")
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
               {"allowed", "reason", "confirmationRequired", "redact", "audit",
                "originDependent", "siteMode", "effectiveTier", "dlp"},
               f"{label}: dry run verdict keys = {sorted(((r or {}).get('verdict') or {}).keys())}")
        expect(((r or {}).get("verdict") or {}).get("effectiveTier") == "read_only",
               f"{label}: dry run getTabs should report a read_only effectiveTier, got {r}")
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

    # --- Secret masking is armed for the VERY FIRST request -------------------
    # A policy denial quotes the request's target in both the error and the audit
    # event. If secret masks are only primed on an mtime reload or after the
    # first successful forward, that first denial writes the raw secret to the
    # audit log, which is exactly the artifact that must never hold it.
    with open(SECRETS_FILE, "w") as f:
        f.write("apiKey=s3cr3t-first-request\n")
    os.chmod(SECRETS_FILE, 0o600)
    write_policy(permissive_with(secretMaskFile=SECRETS_FILE,
                                 allowedOrigins=["https://github.com"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        # First request of this host process, and it is denied.
        r = c.req("navigate", {"url": "https://s3cr3t-first-request.example.com/x"})
        expect(r and r.get("success") is False and "target not allowed" in str(r.get("error", "")),
               f"{label}: navigate to an unlisted origin should be denied, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: denied navigate must not forward, got {forwarded_actions()}")
        audit_text = json.dumps(audit_events())
        expect("s3cr3t-first-request" not in audit_text,
               f"{label}: first-request denial must not write the raw secret to the audit log: {audit_text}")
        expect("<masked:apiKey>" in audit_text,
               f"{label}: first-request denial audit should carry the masked secret, got {audit_text}")
        c.close()
    try:
        os.remove(SECRETS_FILE)
    except FileNotFoundError:
        pass

    # --- Session trace artifacts: one JSONL event per eligible request ---
    # With traceDir configured the host appends exactly one metadata event per
    # trace-eligible request, and never the payload or the response body.
    shutil.rmtree(TRACE_DIR, ignore_errors=True)
    write_policy(permissive_with(traceDir=TRACE_DIR))
    trace_result = lambda a, p: {
        "sessionId": "sess-alpha",
        "title": "top-secret-page-title",
        "nodes": [{"ref": "e1", "role": "button"}],
    }
    with Host(label, cmd, env, result_fn=trace_result):
        c = Client("tok-alpha")
        r = c.req("createTaskSession", {"name": "demo"})
        expect(r and r.get("success") is True,
               f"{label}: traced task session action should succeed, got {r}")
        events = trace_events("sess-alpha")
        expect(len(events) == 1,
               f"{label}: task session action should write exactly one trace event, got {events}")
        event = events[0] if events else {}
        expect(event.get("traceId") == "sess-alpha" and event.get("action") == "createTaskSession"
               and event.get("decision") == "extension_success" and event.get("success") is True,
               f"{label}: trace event should record the session, action, and decision, got {event}")
        expect(isinstance(event.get("responseHash"), str) and len(event["responseHash"]) == 64,
               f"{label}: trace event should carry a response hash, got {event}")
        expect(isinstance(event.get("snapshotHash"), str) and len(event["snapshotHash"]) == 64,
               f"{label}: snapshot-bearing response should carry a snapshot hash, got {event}")
        expect(isinstance(event.get("durationMs"), int) and event["durationMs"] >= 0,
               f"{label}: trace event should carry a duration, got {event}")
        raw = trace_text("sess-alpha")
        expect("top-secret-page-title" not in raw and "demo" not in raw,
               f"{label}: trace must not store payload or response content, got {raw}")

        # An explicit traceId groups any action into a trace, under a file name
        # sanitized to [A-Za-z0-9._-].
        r = c.req("getTabs", {"traceId": "run/../weird id"})
        expect(r and r.get("success") is True,
               f"{label}: explicit-traceId action should succeed, got {r}")
        events = trace_events("run_.._weird_id")
        expect(len(events) == 1 and events[0].get("traceId") == "run/../weird id"
               and events[0].get("action") == "getTabs",
               f"{label}: explicit traceId should write one event to the sanitized file, got {events}")
        c.close()

    # A host denial is still traced when the request names a trace explicitly:
    # the artifact must show what was refused, not just what ran.
    shutil.rmtree(TRACE_DIR, ignore_errors=True)
    write_policy(permissive_with(traceDir=TRACE_DIR, deniedActions=["screenshot"]))
    with Host(label, cmd, env, result_fn=trace_result):
        c = Client("tok-alpha")
        r = c.req("screenshot", {"tabId": 7, "traceId": "sess-denied"})
        expect(r and r.get("success") is False and r.get("error") == "policy denied: action screenshot denied",
               f"{label}: denied action should report the policy denial, got {r}")
        events = trace_events("sess-denied")
        expect(len(events) == 1 and events[0].get("decision") == "deny"
               and events[0].get("success") is False
               and events[0].get("reason") == "action screenshot denied"
               and events[0].get("targets") == [7],
               f"{label}: a denied request with an explicit traceId should still be traced, got {events}")
        expect(isinstance((events[0] if events else {}).get("responseHash"), str),
               f"{label}: a denial trace event should still carry a response hash, got {events}")
        c.close()
    shutil.rmtree(TRACE_DIR, ignore_errors=True)

    # --- Handoff telemetry blackout: observation denied while a handoff runs ---
    # The mock delays its waitForHandoff response, which is exactly what the real
    # extension does while a human types credentials, so the host has a genuine
    # in-flight handoff for the duration. Blackout is enforced host-side before
    # policy, so nothing needs the (blocked) mock to answer.
    def handoff_result(action, payload):
        if action in ("waitForHandoff", "credentialHandoff"):
            # Long enough for the whole blacked-out action set to be probed while
            # the handoff is genuinely in flight.
            time.sleep(6)
            return {"resolved": True}
        return {"echo": action}

    # (a) tab-scoped handoff blacks out that tab, (b) it lifts on completion.
    write_policy(PERMISSIVE)
    with Host(label, cmd, env, result_fn=handoff_result):
        watcher = Client("tok-alpha")
        observer = Client("tok-alpha")
        handoff_response = []
        t = threading.Thread(target=lambda: handoff_response.append(
            watcher.req("waitForHandoff", {"message": "log in", "tabId": 7})))
        t.start()
        expect(wait_until_forwarded("waitForHandoff"),
               f"{label}: handoff never reached the extension, cannot test the blackout")
        # Same client identity as the initiator: the blackout applies to every
        # client, including the one that asked for the handoff.
        r = observer.req("screenshot", {"tabId": 7})
        expect(r and r.get("success") is False and r.get("error") == "handoff in progress"
               and r.get("blackout") is True,
               f"{label}: screenshot during handoff should be blacked out, got {r}")
        expect("screenshot" not in forwarded_actions(),
               f"{label}: blacked-out screenshot must not forward, got {forwarded_actions()}")
        r = observer.req("getHTML", {"tabId": 7})
        expect(r and r.get("success") is False and r.get("blackout") is True,
               f"{label}: getHTML during handoff should be blacked out, got {r}")
        # observe is a full accessibility snapshot of the page the human is
        # typing into, and the collector actions are the other half of the leak:
        # retrieval hands back the buffer that spans the handoff, and a start
        # opened mid-handoff would be read out the moment the blackout lifts.
        for blacked_out in ("observe", "networkRequests", "interceptedRequests",
                            "consoleMessages", "screencastFrames",
                            "startMonitoring", "startInterception", "startScreencast"):
            r = observer.req(blacked_out, {"tabId": 7})
            expect(r and r.get("success") is False
                   and r.get("error") == "handoff in progress"
                   and r.get("blackout") is True,
                   f"{label}: {blacked_out} during handoff should be blacked out, got {r}")
            expect(blacked_out not in forwarded_actions(),
                   f"{label}: blacked-out {blacked_out} must not forward, got {forwarded_actions()}")
        # A composite action cannot smuggle an observation past the gate: batch
        # and replayWorkflow dispatch their steps inside the extension.
        r = observer.req("batch", {"tabId": 7, "steps": [{"action": "observe"}]})
        expect(r and r.get("success") is False and r.get("blackout") is True,
               f"{label}: batch wrapping observe should be blacked out, got {r}")
        r = observer.req("replayWorkflow", {
            "tabId": 7,
            "workflow": {"version": 1, "steps": [{"action": "networkRequests", "payload": {"tabId": 7}}]},
        })
        expect(r and r.get("success") is False and r.get("blackout") is True,
               f"{label}: replayWorkflow wrapping networkRequests should be blacked out, got {r}")
        expect("batch" not in forwarded_actions() and "replayWorkflow" not in forwarded_actions(),
               f"{label}: blacked-out composites must not forward, got {forwarded_actions()}")
        r = observer.req("screenshot", {"tabId": 7}, extra={"dryRun": True})
        expect(r and r.get("success") is True and r.get("wouldForward") is False
               and ((r.get("verdict") or {}).get("blackout") is True)
               and ((r.get("verdict") or {}).get("reason") == "handoff in progress"),
               f"{label}: dry run during handoff should report the blackout, got {r}")
        r = observer.req("ping")
        expect(r and r.get("success") is True,
               f"{label}: non-observation actions should pass during handoff, got {r}")
        blackouts = [e for e in audit_events() if e.get("decision") == "handoff_blackout"]
        expect(len(blackouts) >= 2 and blackouts[0].get("action") == "screenshot"
               and blackouts[0].get("reason") == "handoff in progress",
               f"{label}: blackout should be audited as handoff_blackout, got {blackouts}")
        t.join(timeout=15)
        expect(handoff_response and (handoff_response[0] or {}).get("success") is True,
               f"{label}: handoff should complete, got {handoff_response}")
        r = observer.req("screenshot", {"tabId": 7})
        expect(r and r.get("success") is True,
               f"{label}: screenshot after handoff should pass policy again, got {r}")
        expect("screenshot" in forwarded_actions(),
               f"{label}: post-handoff screenshot should forward, got {forwarded_actions()}")
        observer.close()
        watcher.close()

    # (c) a handoff with no tabId is GLOBAL: every tab is blacked out.
    write_policy(PERMISSIVE)
    with Host(label, cmd, env, result_fn=handoff_result):
        watcher = Client("tok-alpha")
        observer = Client("tok-alpha")
        t = threading.Thread(target=lambda: watcher.req("waitForHandoff", {"message": "log in"}))
        t.start()
        expect(wait_until_forwarded("waitForHandoff"),
               f"{label}: tabless handoff never reached the extension")
        for payload in ({"tabId": 99}, {"tabId": 7}, {}):
            r = observer.req("screenshot", payload)
            expect(r and r.get("success") is False and r.get("error") == "handoff in progress"
                   and r.get("blackout") is True,
                   f"{label}: tabless handoff should black out {payload}, got {r}")
        expect("screenshot" not in forwarded_actions(),
               f"{label}: globally blacked-out screenshots must not forward, got {forwarded_actions()}")
        t.join(timeout=15)
        r = observer.req("screenshot", {"tabId": 99})
        expect(r and r.get("success") is True,
               f"{label}: screenshot after a tabless handoff should be allowed again, got {r}")
        observer.close()
        watcher.close()

    # (d) T4-3: credentialHandoff is the single-field narrowing of waitForHandoff
    # and must open the identical blackout. Same delayed-mock pattern: the mock
    # holds the response while the "human" types, so the handoff is genuinely in
    # flight for the probes below.
    write_policy(PERMISSIVE)
    with Host(label, cmd, env, result_fn=handoff_result):
        watcher = Client("tok-alpha")
        observer = Client("tok-alpha")
        cred_response = []
        t = threading.Thread(target=lambda: cred_response.append(
            watcher.req("credentialHandoff", {"selector": "#password", "tabId": 7})))
        t.start()
        expect(wait_until_forwarded("credentialHandoff"),
               f"{label}: credentialHandoff never reached the extension")
        for blacked_out in ("screenshot", "getHTML", "observe"):
            r = observer.req(blacked_out, {"tabId": 7})
            expect(r and r.get("success") is False
                   and r.get("error") == "handoff in progress"
                   and r.get("blackout") is True,
                   f"{label}: {blacked_out} during credentialHandoff should be blacked out, got {r}")
            expect(blacked_out not in forwarded_actions(),
                   f"{label}: blacked-out {blacked_out} must not forward during credentialHandoff, got {forwarded_actions()}")
        blackouts = [e for e in audit_events() if e.get("decision") == "handoff_blackout"]
        expect(len(blackouts) >= 3
               and all(e.get("reason") == "handoff in progress" for e in blackouts),
               f"{label}: credentialHandoff blackout should audit as handoff_blackout, got {blackouts}")
        t.join(timeout=15)
        expect(cred_response and (cred_response[0] or {}).get("success") is True,
               f"{label}: credentialHandoff should complete, got {cred_response}")
        for lifted in ("screenshot", "getHTML", "observe"):
            r = observer.req(lifted, {"tabId": 7})
            expect(r and r.get("success") is True,
                   f"{label}: {lifted} after credentialHandoff should be allowed again, got {r}")
        observer.close()
        watcher.close()

    # (e) A credentialHandoff with no tabId is GLOBAL, exactly like waitForHandoff.
    write_policy(PERMISSIVE)
    with Host(label, cmd, env, result_fn=handoff_result):
        watcher = Client("tok-alpha")
        observer = Client("tok-alpha")
        t = threading.Thread(target=lambda: watcher.req("credentialHandoff", {"selector": "#password"}))
        t.start()
        expect(wait_until_forwarded("credentialHandoff"),
               f"{label}: tabless credentialHandoff never reached the extension")
        for payload in ({"tabId": 99}, {"tabId": 7}, {}):
            r = observer.req("observe", payload)
            expect(r and r.get("success") is False and r.get("error") == "handoff in progress"
                   and r.get("blackout") is True,
                   f"{label}: tabless credentialHandoff should black out {payload}, got {r}")
        expect("observe" not in forwarded_actions(),
               f"{label}: globally blacked-out observe must not forward, got {forwarded_actions()}")
        t.join(timeout=15)
        r = observer.req("observe", {"tabId": 99})
        expect(r and r.get("success") is True,
               f"{label}: observe after a tabless credentialHandoff should be allowed again, got {r}")
        observer.close()
        watcher.close()

    # (f) A handoff nested in a composite is refused outright. runBatch and
    # replayWorkflow dispatch their later steps inside the extension, so those
    # steps never pass back through the host and no blackout could cover them:
    # a batch of [credentialHandoff, screenshot] would capture the tab while the
    # human is still typing. The host denies the whole composite before
    # forwarding, names the offending step, and leaves top-level handoffs alone.
    write_policy(PERMISSIVE)
    with Host(label, cmd, env, result_fn=handoff_result):
        c = Client("tok-alpha")
        r = c.req("batch", {"tabId": 7, "steps": [
            {"action": "getCurrentState"},
            {"action": "credentialHandoff", "payload": {"selector": "#password"}},
            {"action": "screenshot"},
        ]})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: batch step 1: handoff not allowed in a composite",
               f"{label}: batch wrapping credentialHandoff should be denied, got {r}")
        expect(((r or {}).get("policyDenial") or {}).get("batchStep") == 1,
               f"{label}: composite handoff denial should report the batch step index, got {r}")
        r = c.req("replayWorkflow", {"tabId": 7, "workflow": {"version": 1, "steps": [
            {"action": "waitForHandoff", "payload": {"message": "log in"}},
            {"action": "getHTML"},
        ]}})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: workflow step 0: handoff not allowed in a composite",
               f"{label}: replayWorkflow wrapping waitForHandoff should be denied, got {r}")
        expect(((r or {}).get("policyDenial") or {}).get("batchStep") == 0,
               f"{label}: composite handoff denial should report the workflow step index, got {r}")
        # Nesting does not help: the step extractor reaches the inner composite.
        r = c.req("batch", {"tabId": 7, "steps": [
            {"action": "batch", "payload": {"steps": [{"action": "waitForHandoff"}]}},
        ]})
        expect(r and r.get("success") is False
               and "handoff not allowed in a composite" in (r.get("error") or ""),
               f"{label}: a nested composite handoff should be denied, got {r}")
        expect(not any(a in forwarded_actions() for a in
                       ("batch", "replayWorkflow", "credentialHandoff", "waitForHandoff")),
               f"{label}: a composite carrying a handoff must not forward, got {forwarded_actions()}")
        # A TOP-LEVEL handoff is unaffected and still opens the blackout.
        watcher = Client("tok-alpha")
        t = threading.Thread(target=lambda: watcher.req(
            "credentialHandoff", {"selector": "#password", "tabId": 7}))
        t.start()
        expect(wait_until_forwarded("credentialHandoff"),
               f"{label}: a top-level credentialHandoff should still forward")
        r = c.req("screenshot", {"tabId": 7})
        expect(r and r.get("success") is False and r.get("error") == "handoff in progress"
               and r.get("blackout") is True,
               f"{label}: a top-level credentialHandoff should still black out the tab, got {r}")
        t.join(timeout=15)
        c.close()
        watcher.close()

    # --- Opt-in OpenTelemetry spans (BRIDGE_OTEL_ENABLED) ---------------------
    # (a) Disabled is inert. An endpoint and a file sink are BOTH configured and
    # BRIDGE_OTEL_ENABLED is left unset: no span file may appear (so no export
    # ran and no collector was contacted), the response shape is unchanged, and
    # the session trace artifact carries no span ids.
    try:
        os.remove(OTEL_FILE)
    except FileNotFoundError:
        pass
    shutil.rmtree(TRACE_DIR, ignore_errors=True)
    otel_off_env = dict(env)
    otel_off_env["BRIDGE_OTEL_ENDPOINT"] = "http://127.0.0.1:9/v1/traces"
    otel_off_env["BRIDGE_OTEL_FILE"] = OTEL_FILE
    otel_off_env.pop("BRIDGE_OTEL_ENABLED", None)
    write_policy(permissive_with(traceDir=TRACE_DIR))
    otel_result = lambda a, p: {"title": "top-secret-page-title", "sessionId": "sess-otel"}
    with Host(label, cmd, otel_off_env, result_fn=otel_result):
        c = Client("tok-alpha")
        r = c.req("createTaskSession", {"name": "demo"})
        expect(r and set(r.keys()) == {"id", "success", "result"} and r.get("success") is True,
               f"{label}: telemetry-off response shape should be unchanged, got {r}")
        expect(not os.path.exists(OTEL_FILE),
               f"{label}: no span file may be written while BRIDGE_OTEL_ENABLED is unset")
        events = trace_events("sess-otel")
        expect(len(events) == 1 and "otelTraceId" not in events[0] and "otelSpanId" not in events[0],
               f"{label}: telemetry-off trace events must carry no span ids, got {events}")
        c.close()

    # (b) Enabled with a file sink: exactly one span document per request, the
    # expected attribute keys, no payload or response content, and a known
    # secret reaching a span only in masked form.
    with open(SECRETS_FILE, "w") as f:
        f.write("sessionKey=s3cr3t-trace-id\n")
    os.chmod(SECRETS_FILE, 0o600)
    try:
        os.remove(OTEL_FILE)
    except FileNotFoundError:
        pass
    shutil.rmtree(TRACE_DIR, ignore_errors=True)
    otel_on_env = dict(env)
    otel_on_env["BRIDGE_OTEL_ENABLED"] = "1"
    otel_on_env["BRIDGE_OTEL_FILE"] = OTEL_FILE
    otel_on_env.pop("BRIDGE_OTEL_ENDPOINT", None)
    write_policy(permissive_with(traceDir=TRACE_DIR, secretMaskFile=SECRETS_FILE))
    with Host(label, cmd, otel_on_env, result_fn=otel_result):
        c = Client("tok-alpha")
        r = c.req("getTabs", {"traceId": "s3cr3t-trace-id"})
        expect(r and r.get("success") is True,
               f"{label}: a traced request should still succeed with spans on, got {r}")
        raw = open(OTEL_FILE).read() if os.path.exists(OTEL_FILE) else ""
        documents = [json.loads(l) for l in raw.splitlines() if l.strip()]
        expect(len(documents) == 1,
               f"{label}: one request should export exactly one span document, got {len(documents)}")
        spans = otel_spans(documents)
        roots = [s for s in spans if s.get("name") == "execute_tool getTabs"]
        expect(len(roots) == 1,
               f"{label}: one request span per request, got {[s.get('name') for s in spans]}")
        root = roots[0] if roots else {}
        attrs = {a.get("key"): a.get("value") for a in root.get("attributes") or []}
        required = {"gen_ai.tool.name", "bridge.action", "bridge.client", "bridge.decision",
                    "bridge.duration_ms", "bridge.tab_id_count", "bridge.success",
                    "bridge.trace_id", "bridge.host"}
        expect(required <= set(attrs),
               f"{label}: span is missing attributes {sorted(required - set(attrs))}")
        expect(attrs.get("bridge.action", {}).get("stringValue") == "getTabs"
               and attrs.get("bridge.decision", {}).get("stringValue") == "extension_success"
               and attrs.get("bridge.success", {}).get("boolValue") is True,
               f"{label}: span should record the action, decision, and success, got {attrs}")
        expect(len(root.get("traceId") or "") == 32 and len(root.get("spanId") or "") == 16,
               f"{label}: span ids should be 16/8-byte hex, got {root}")
        child_names = {s.get("name") for s in spans if s.get("parentSpanId") == root.get("spanId")}
        expect({"bridge.policy_evaluate", "bridge.extension_forward"} <= child_names,
               f"{label}: policy and forward child spans should be emitted, got {sorted(child_names)}")
        expect("s3cr3t-trace-id" not in raw,
               f"{label}: a known secret must never reach a span unmasked: {raw}")
        expect("<masked:sessionKey>" in raw,
               f"{label}: the span should carry the masked secret instead, got {raw}")
        expect("top-secret-page-title" not in raw and "demo" not in raw,
               f"{label}: spans must carry no payload or response content, got {raw}")

        # The session trace artifact names the same span, so a local JSONL line
        # and an exported span correlate.
        events = trace_events("s3cr3t-trace-id")
        expect(len(events) == 1 and events[0].get("otelTraceId") == root.get("traceId")
               and events[0].get("otelSpanId") == root.get("spanId"),
               f"{label}: trace artifact should carry the span ids, got {events}")

        # An incoming traceparent is continued rather than replaced, and never
        # reaches the extension.
        incoming = "00-" + "a" * 32 + "-" + "b" * 16 + "-01"
        r = c.req("getTabs", {}, extra={"traceparent": incoming})
        expect(r and r.get("success") is True,
               f"{label}: a request carrying a traceparent should succeed, got {r}")
        with forwarded_lock:
            forwarded_text = json.dumps(forwarded)
        expect("traceparent" not in forwarded_text,
               f"{label}: traceparent must be stripped before forwarding, got {forwarded_text}")
        with open(OTEL_FILE) as f:
            documents = [json.loads(l) for l in f.read().splitlines() if l.strip()]
        continued = [s for s in otel_spans(documents) if s.get("traceId") == "a" * 32]
        expect(continued and any(s.get("parentSpanId") == "b" * 16 for s in continued),
               f"{label}: the caller's traceparent should be continued, got {continued}")
        c.close()
    try:
        os.remove(SECRETS_FILE)
    except FileNotFoundError:
        pass
    try:
        os.remove(OTEL_FILE)
    except FileNotFoundError:
        pass
    shutil.rmtree(TRACE_DIR, ignore_errors=True)

    # --- Content-addressed org policy bundles (policy key policyBundle) -----
    # A bundle is a verified SOURCE for the policy the host already merges, so
    # these cases assert what a bundle may do (supply the baseline layers) and
    # what it may never do (take effect unverified, or drop a local denial).

    # (a) A matching digest applies the bundle and its allow list governs.
    marker_origin = "https://bundle-only-marker.test"
    write_bundle({"default": {
        "allowedActions": ["ping", "policyInfo", "getTabs"],
        "deniedActions": [], "allowedOrigins": ["*", marker_origin],
        "deniedOrigins": [], "requireConfirmation": [],
        "redact": True, "audit": True}})
    digest = bundle_digest()
    write_bundle_lock(digest)
    write_policy(bundle_local_policy())
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: a verified bundle's allow list should govern, got {r}")
        r = c.req("getCookies", {"domain": "x.test"})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: an action the bundle does not allow should still deny, got {r}")
        expect(not bundle_rejections(),
               f"{label}: a verified bundle must not audit a rejection, got {bundle_rejections()}")

        # (e) policyInfo reports the truncated digest and never bundle contents.
        r = c.req("policyInfo")
        info = (r or {}).get("result") or {}
        reported = info.get("policyBundle") or {}
        expect(reported.get("path") == BUNDLE_FILE and reported.get("verified") is True,
               f"{label}: policyInfo should report the verified bundle, got {reported}")
        expect(reported.get("digest") == digest[:12] and len(reported.get("digest") or "") == 12,
               f"{label}: policyInfo should report a 12-char digest, got {reported}")
        expect(marker_origin not in json.dumps(r),
               f"{label}: policyInfo must never return bundle contents, got {r}")
        c.close()

    # (b) A mismatched digest falls back to the built-in fail-closed default and
    # audits policy_bundle_rejected exactly once, carrying both digests.
    wrong = "f" * 64
    write_bundle_lock(wrong)
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action getTabs not allowed",
               f"{label}: an unverified bundle must never take effect, got {r}")
        r = c.req("ping")
        expect(r and r.get("success") is True,
               f"{label}: the built-in fail-closed default should still allow ping, got {r}")
        r = c.req("policyInfo")
        reported = ((r or {}).get("result") or {}).get("policyBundle") or {}
        expect(reported.get("verified") is False,
               f"{label}: policyInfo should report the bundle as unverified, got {reported}")
        rejections = bundle_rejections()
        expect(len(rejections) == 1,
               f"{label}: a rejected bundle should audit exactly once, got {rejections}")
        event = rejections[0] if rejections else {}
        expect(event.get("reason") == "policy bundle digest mismatch"
               and event.get("expectedDigest") == wrong
               and event.get("actualDigest") == digest,
               f"{label}: the rejection should carry both digests, got {event}")
        c.close()

    # (c) A bundle cannot loosen a local deny list: the bundle's client layer
    # clears deniedOrigins, and the local default's denial still wins.
    write_bundle({
        "default": {"allowedActions": ["*"], "allowedOrigins": ["*"]},
        "clients": {"alpha": {"allowedActions": ["*"], "allowedOrigins": ["*"],
                              "deniedOrigins": []}}})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(
        default={"deniedOrigins": ["*://mail.google.com"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: the bundle's client layer should govern allowed actions, got {r}")
        r = c.req("getCookies", {"domain": "mail.google.com"})
        expect(r and r.get("success") is False and str(r.get("error", "")).startswith("policy denied:"),
               f"{label}: a bundle must not drop a locally denied origin, got {r}")
        expect("getCookies" not in forwarded_actions(),
               f"{label}: a locally denied origin must not forward under a bundle")
        c.close()

    # (d) Swapping the bundle on disk is caught on the existing reload path: the
    # digest is re-verified, not trusted for the process's lifetime.
    write_bundle({"default": {
        "allowedActions": ["ping", "policyInfo", "getTabs"],
        "deniedActions": [], "allowedOrigins": ["*"], "deniedOrigins": [],
        "requireConfirmation": [], "redact": True, "audit": True}})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy())
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: the verified bundle should allow getTabs before the swap, got {r}")
        write_bundle({"default": {
            "allowedActions": ["*"], "deniedActions": [], "allowedOrigins": ["*"],
            "deniedOrigins": [], "requireConfirmation": [],
            "redact": True, "audit": True}}, bump=5)
        r = c.req("getTabs")
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action getTabs not allowed",
               f"{label}: a swapped bundle must revert to fail-closed default, got {r}")
        rejections = bundle_rejections()
        expect(len(rejections) == 1
               and rejections[0].get("reason") == "policy bundle digest mismatch",
               f"{label}: the swap should audit one rejection, got {rejections}")
        r = c.req("policyInfo")
        reported = ((r or {}).get("result") or {}).get("policyBundle") or {}
        expect(reported.get("verified") is False,
               f"{label}: policyInfo should report the swapped bundle as unverified, got {reported}")
        expect(len(bundle_rejections()) == 1,
               f"{label}: the rejection must be audited once per change, not per request, "
               f"got {bundle_rejections()}")
        c.close()

    # (f) Monotonic composition: a VERIFIED bundle is a floor, so the local layer
    # can only tighten it. One case per rule kind in POLICY_BUNDLE_COMPOSITION,
    # each asserting both directions -- the local layer cannot LOOSEN the bundle,
    # and a local layer that is genuinely stricter still wins.
    bundle_baseline = {"deniedActions": [], "allowedOrigins": ["*"],
                       "deniedOrigins": [], "requireConfirmation": [],
                       "redact": True, "audit": True}

    # (f1) allowedActions ('allow'): explicit INTERSECTION, so a local "*"
    # collapses to the bundle's list instead of widening it.
    write_bundle({"default": dict(bundle_baseline,
                                  allowedActions=["ping", "policyInfo", "getTabs"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"allowedActions": ["*"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: an action both layers permit should proceed, got {r}")
        r = c.req("getCookies", {"domain": "x.test"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action getCookies not allowed",
               f"{label}: a local allowedActions '*' must not widen the bundle, got {r}")
        expect("getCookies" not in forwarded_actions(),
               f"{label}: an action outside the composed allow list must not forward, "
               f"got {forwarded_actions()}")
        c.close()
    # Mirror: a local list NARROWER than the bundle's wins.
    write_policy(bundle_local_policy(default={"allowedActions": ["ping", "policyInfo"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action getTabs not allowed",
               f"{label}: a narrower local allowedActions should tighten the bundle, got {r}")
        r = c.req("ping")
        expect(r and r.get("success") is True,
               f"{label}: an action both layers still permit should proceed, got {r}")
        c.close()

    # (f2) allowedOrigins ('allow'): the same intersection on the origin list.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  allowedOrigins=["*://github.com"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"allowedOrigins": ["*"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is True,
               f"{label}: an origin both layers permit should proceed, got {r}")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: target not allowed",
               f"{label}: a local allowedOrigins '*' must not widen the bundle, got {r}")
        c.close()
    # Mirror: the local layer drops one of the bundle's two origins.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  allowedOrigins=["*://github.com", "*://mail.google.com"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"allowedOrigins": ["*://github.com"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is True,
               f"{label}: the origin the local layer kept should proceed, got {r}")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: target not allowed",
               f"{label}: a narrower local allowedOrigins should tighten the bundle, got {r}")
        c.close()

    # (f3) dlp ('dlp'): per-channel STRICTEST mode, block > audit > allow.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  dlp={"upload": "block"})})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"dlp": {"upload": "allow"}}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("uploadFile", {"tabId": 7, "selector": "#f",
                                 "files": ["/tmp/dlp-fixture.txt"]})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: dlp blocked",
               f"{label}: a local dlp 'allow' must not relax the bundle's block, got {r}")
        denial = (r or {}).get("policyDenial") or {}
        expect(denial.get("kind") == "dlp" and denial.get("dlpChannel") == "upload",
               f"{label}: the composed dlp denial should name the channel, got {denial}")
        expect("uploadFile" not in forwarded_actions(),
               f"{label}: a composed dlp block must not forward, got {forwarded_actions()}")
        c.close()
    # Mirror: the local layer is the stricter of the two.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  dlp={"upload": "audit"})})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"dlp": {"upload": "block"}}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("uploadFile", {"tabId": 7, "selector": "#f",
                                 "files": ["/tmp/dlp-fixture.txt"]})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: dlp blocked",
               f"{label}: a local dlp block should tighten the bundle's audit, got {r}")
        c.close()

    # (f4) siteModes ('siteMode'): per-pattern STRICTEST mode, manual > auto > skip.
    set_tab_origins({None: "https://github.com", 7: "https://mail.google.com"})
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  siteModes={"*://mail.google.com": "manual"})})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(
        default={"siteModes": {"*://mail.google.com": "skip"}}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True
               and r.get("error") == "confirmation required",
               f"{label}: a local siteMode 'skip' must not lift the bundle's manual, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: a manual-gated navigate must not forward, got {forwarded_actions()}")
        c.close()
    # Mirror: the local layer tightens the bundle's auto to manual.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  siteModes={"*://mail.google.com": "auto"})})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(
        default={"siteModes": {"*://mail.google.com": "manual"}}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://mail.google.com/mail"})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: a local siteMode 'manual' should tighten the bundle's auto, got {r}")
        c.close()
    set_tab_origins({None: "https://github.com"})

    # (f5) secretMaskFile ('paths'): dropping the path is a loosening, so a
    # local null and a local omission both keep the bundle's masks armed.
    with open(SECRETS_FILE, "w") as f:
        f.write("apiKey=b0nd-bundle-secret\n")
    os.chmod(SECRETS_FILE, 0o600)
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  secretMaskFile=SECRETS_FILE)})
    write_bundle_lock(bundle_digest())
    masked_result = lambda a, p: {"outer": "carrying b0nd-bundle-secret here"}
    for local_layer, note in ((None, "omits secretMaskFile"),
                              ({"secretMaskFile": None}, "nulls secretMaskFile")):
        write_policy(bundle_local_policy()
                     if local_layer is None else bundle_local_policy(default=local_layer))
        with Host(label, cmd, env, result_fn=masked_result):
            c = Client("tok-alpha")
            r = c.req("getTabs")
            rendered = json.dumps(r)
            expect("b0nd-bundle-secret" not in rendered,
                   f"{label}: a local layer that {note} must not disarm the bundle's "
                   f"secretMaskFile, got {r}")
            expect("<masked:apiKey>" in rendered,
                   f"{label}: the bundle's mask should still replace the value, got {r}")
            c.close()
    remove_paths(SECRETS_FILE)

    # (f6) requireConfirmation ('deny'): UNION, so a bundle entry the local list
    # omits still gates.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  requireConfirmation=["executeScript"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"requireConfirmation": ["navigate"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("executeScript", {"tabId": 7, "code": "1"})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True
               and r.get("error") == "confirmation required",
               f"{label}: a bundle requireConfirmation entry must gate even when the "
               f"local list omits it, got {r}")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: the local layer's own confirmation entry should also gate, got {r}")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: the union must not gate an action neither layer named, got {r}")
        c.close()

    # (f7) egressAllowlist ('egress'): EMPTY means unconstrained, so an empty
    # local list must keep the bundle's constraint rather than lift it.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  egressAllowlist=["*://github.com"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"egressAllowlist": []}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://evil.test/x"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: egress not allowed",
               f"{label}: an empty local egressAllowlist must not lift the bundle's "
               f"constraint, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: a composed egress denial must not forward, got {forwarded_actions()}")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is True,
               f"{label}: a destination inside the bundle's egressAllowlist should "
               f"proceed, got {r}")
        c.close()

    # (f8) redact ('onlyTrue'): true is the tight value, so a local false loses.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"], redact=True)})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"redact": False}))
    bundle_cookie_result = lambda a, p: {"cookies": [{"name": "sid",
                                                      "value": "secret-cookie",
                                                      "domain": "x.test"}]}
    with Host(label, cmd, env, result_fn=bundle_cookie_result):
        c = Client("tok-alpha")
        r = c.req("getCookies", {"domain": "x.test"})
        cookies = ((r or {}).get("result") or {}).get("cookies") or []
        expect(cookies and cookies[0].get("value") == "<redacted>",
               f"{label}: a local redact false must not disable the bundle's redaction, "
               f"got {cookies}")
        c.close()

    # (k) redactPatterns ('deny'): UNION. redactPatterns is the mask applied to
    # page-derived content before it reaches the client, so it carries authority
    # over data egress and a local empty list must not erase the bundle's.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  redactPatterns=[r"\d{3}-\d{2}-\d{4}"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"redactPatterns": []}))
    bundle_html_result = lambda a, p: {"success": True,
                                       "html": "<p>SSN 123-45-6789 Bearer abc123</p>"}
    with Host(label, cmd, env, result_fn=bundle_html_result):
        c = Client("tok-alpha")
        r = c.req("getHTML", {"tabId": 7})
        rendered = json.dumps(r)
        expect("123-45-6789" not in rendered and "<redacted>" in rendered,
               f"{label}: a local empty redactPatterns must not erase the bundle's "
               f"regexes, got {r}")
        c.close()
    # Mirror: a regex the local layer ADDS on top of the bundle's also applies.
    write_policy(bundle_local_policy(
        default={"redactPatterns": ["(?i)bearer [a-z0-9]+"]}))
    with Host(label, cmd, env, result_fn=bundle_html_result):
        c = Client("tok-alpha")
        r = c.req("getHTML", {"tabId": 7})
        rendered = json.dumps(r)
        expect("123-45-6789" not in rendered and "abc123" not in rendered,
               f"{label}: the composed redactPatterns should be the union of both "
               f"layers, got {r}")
        c.close()

    # (l) secretMaskFile ('paths'): UNION of paths, so a local layer naming its
    # OWN dictionary adds to the org's instead of replacing it. A response
    # carrying both raw values must come back with both masked, which is only
    # possible if neither file was dropped.
    with open(SECRETS_FILE, "w") as f:
        f.write("orgKey=org-0nly-s3cret\n")
    os.chmod(SECRETS_FILE, 0o600)
    with open(SECRETS_FILE_B, "w") as f:
        f.write("localKey=l0cal-only-s3cret\n")
    os.chmod(SECRETS_FILE_B, 0o600)
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  secretMaskFile=SECRETS_FILE)})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"secretMaskFile": SECRETS_FILE_B}))
    both_secrets_result = lambda a, p: {
        "outer": "org org-0nly-s3cret and local l0cal-only-s3cret"}
    with Host(label, cmd, env, result_fn=both_secrets_result):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        rendered = json.dumps(r)
        expect("org-0nly-s3cret" not in rendered,
               f"{label}: a local secretMaskFile must not drop the bundle's secret "
               f"dictionary, got {r}")
        expect("l0cal-only-s3cret" not in rendered,
               f"{label}: the local layer's own secretMaskFile should mask too, got {r}")
        expect("<masked:orgKey>" in rendered and "<masked:localKey>" in rendered,
               f"{label}: both composed dictionaries should mask by name, got {r}")
        c.close()
    remove_paths(SECRETS_FILE, SECRETS_FILE_B)

    # (f10) The allow-list intersection is EXPLICIT, and one that is not
    # representable as a pattern list is REJECTED rather than silently merged.
    # Bundle ["foo*"] under local ["foo?"] used to compose to ["foo*", "foo?"] --
    # fnmatch("foo*", "foo?") is true in both directions -- so the local
    # narrowing to four-character names vanished without a word.
    write_bundle({"default": dict(bundle_baseline,
                                  allowedActions=["ping", "policyInfo", "getTabs", "foo*"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(default={"allowedActions": ["foo?"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action getTabs not allowed",
               f"{label}: a bundle with an unrepresentable allow-list intersection must "
               f"be refused, so an action it allowed should now deny, got {r}")
        r = c.req("ping")
        expect(r and r.get("success") is True,
               f"{label}: the built-in fail-closed default should still allow ping after "
               f"a composition conflict, got {r}")
        rejections = bundle_rejections()
        expect(len(rejections) == 1,
               f"{label}: a composition conflict should audit exactly once, got {rejections}")
        reason = (rejections[0] if rejections else {}).get("reason") or ""
        expect(reason.startswith("policy bundle composition conflict:")
               and "allowedActions" in reason
               and '"foo*"' in reason and '"foo?"' in reason,
               f"{label}: the conflict should name the key and both patterns, got {reason}")
        r = c.req("policyInfo")
        reported = ((r or {}).get("result") or {}).get("policyBundle") or {}
        expect(reported.get("verified") is False,
               f"{label}: a conflicting bundle should report as unverified, got {reported}")
        expect(len(bundle_rejections()) == 1,
               f"{label}: a composition conflict must be audited once per change, not per "
               f"request, got {bundle_rejections()}")
        c.close()

    # (f11) Exact-literal narrowing still composes: a literal is tested as a NAME
    # against the other side's patterns, which is the one sound direction.
    write_bundle({"default": dict(bundle_baseline,
                                  allowedActions=["ping", "policyInfo", "get*"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(
        default={"allowedActions": ["ping", "policyInfo", "getTabs"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: a local literal inside the bundle's glob should survive the "
               f"intersection, got {r}")
        r = c.req("getCookies", {"domain": "x.test"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action getCookies not allowed",
               f"{label}: another action inside the bundle's glob but outside the local "
               f"literals must deny, got {r}")
        expect(not bundle_rejections(),
               f"{label}: literal narrowing is representable and must not reject the "
               f"bundle, got {bundle_rejections()}")
        c.close()

    # (f12) Two IDENTICAL nontrivial globs compose to that glob, and it still
    # names everything it named.
    write_policy(bundle_local_policy(
        default={"allowedActions": ["ping", "policyInfo", "get*"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: an identical glob on both sides should still allow getTabs, got {r}")
        r = c.req("getCookies", {"domain": "x.test"})
        expect(r and r.get("success") is True,
               f"{label}: an identical glob on both sides should still allow every name it "
               f"covers, got {r}")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action navigate not allowed",
               f"{label}: the composed glob must not reach outside itself, got {r}")
        expect(not bundle_rejections(),
               f"{label}: identical globs are representable and must not reject the bundle, "
               f"got {bundle_rejections()}")
        c.close()

    # (f13) A local "*" still cannot widen a constrained bundle list, including
    # one whose entries are globs rather than literals.
    write_policy(bundle_local_policy(default={"allowedActions": ["*"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: a local '*' should leave the bundle's glob in force, got {r}")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action navigate not allowed",
               f"{label}: a local allowedActions '*' must not widen a bundle glob list, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: an action outside the composed allow list must not forward, "
               f"got {forwarded_actions()}")
        expect(not bundle_rejections(),
               f"{label}: a local '*' is representable and must not reject the bundle, "
               f"got {bundle_rejections()}")
        c.close()

    # (f14) The same conflict on egressAllowlist is rejected the same way, so the
    # two rules share one classification and cannot drift.
    write_bundle({"default": dict(bundle_baseline, allowedActions=["*"],
                                  egressAllowlist=["*://github.com"])})
    write_bundle_lock(bundle_digest())
    write_policy(bundle_local_policy(
        default={"egressAllowlist": ["*://*.github.com"]}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://github.com/x"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action navigate not allowed",
               f"{label}: an egressAllowlist composition conflict must refuse the bundle, "
               f"so an action it allowed should now deny, got {r}")
        expect("navigate" not in forwarded_actions(),
               f"{label}: a refused bundle must not forward the action it would have "
               f"allowed, got {forwarded_actions()}")
        rejections = bundle_rejections()
        expect(len(rejections) == 1,
               f"{label}: an egress composition conflict should audit exactly once, "
               f"got {rejections}")
        reason = (rejections[0] if rejections else {}).get("reason") or ""
        expect(reason.startswith("policy bundle composition conflict:")
               and "egressAllowlist" in reason
               and '"*://github.com"' in reason and '"*://*.github.com"' in reason,
               f"{label}: the egress conflict should name the key and both patterns, "
               f"got {reason}")
        c.close()

    for path in (BUNDLE_FILE, BUNDLE_LOCK_FILE):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass

    # (f9) Composition is INERT without a verified bundle: with no policyBundle
    # configured the local layer behaves exactly as it did before the table
    # existed, so nothing composes against a phantom baseline.
    write_policy(permissive_with(allowedActions=["ping", "policyInfo", "getTabs"]))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: without a bundle a locally allowed action should succeed, got {r}")
        r = c.req("getCookies", {"domain": "x.test"})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action getCookies not allowed",
               f"{label}: without a bundle a locally denied action should still fail, got {r}")
        r = c.req("policyInfo")
        reported = ((r or {}).get("result") or {}).get("policyBundle")
        expect(reported is None,
               f"{label}: policyInfo must report no bundle when none is configured, "
               f"got {reported}")
        c.close()

    # (m) The masking rules are inert without a bundle too: a plain STRING
    # secretMaskFile and a local redactPatterns list behave exactly as they did
    # before either key entered the composition table.
    with open(SECRETS_FILE, "w") as f:
        f.write("apiKey=n0-bundle-s3cret\n")
    os.chmod(SECRETS_FILE, 0o600)
    write_policy(permissive_with(secretMaskFile=SECRETS_FILE,
                                 redactPatterns=[r"\d{3}-\d{2}-\d{4}"]))
    unbundled_result = lambda a, p: {
        "success": True, "html": "<p>SSN 123-45-6789 key n0-bundle-s3cret</p>"}
    with Host(label, cmd, env, result_fn=unbundled_result):
        c = Client("tok-alpha")
        r = c.req("getHTML", {"tabId": 7})
        rendered = json.dumps(r)
        expect("123-45-6789" not in rendered and "<redacted>" in rendered,
               f"{label}: without a bundle a local redactPatterns list should apply "
               f"as before, got {r}")
        expect("n0-bundle-s3cret" not in rendered and "<masked:apiKey>" in rendered,
               f"{label}: without a bundle a plain string secretMaskFile should apply "
               f"as before, got {r}")
        c.close()
    remove_paths(SECRETS_FILE)

    # --- Audit export forwarder (policy auditExport) ------------------------
    # Export is an ADDITIONAL sink for events the local audit log already holds,
    # so every case compares the sink against AUDIT_FILE rather than against an
    # expectation invented here: the contract is "mirror", not "recompute".

    # (a) A jsonl file destination mirrors every audit event verbatim, and a
    # denied action arrives with decision exactly "deny".
    remove_paths(EXPORT_FILE, EXPORT_FILE + ".1", EXPORT_CEF_FILE)
    write_policy(permissive_with(
        deniedActions=["screenshot"],
        auditExport={"format": "jsonl", "destination": EXPORT_FILE}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: an allowed action should still succeed with export on, got {r}")
        r = c.req("screenshot", {"tabId": 7})
        expect(r and r.get("success") is False,
               f"{label}: the denied action should still be denied with export on, got {r}")
        expect(wait_until_exported(len(audit_events())),
               f"{label}: the export sink never mirrored the audit log, got {export_lines()}")
        exported = [json.loads(line) for line in export_lines()]
        expect(exported == audit_events(),
               f"{label}: exported events must equal the local audit events field for field, "
               f"got {exported} vs {audit_events()}")
        denials = [e for e in exported if e.get("decision") == "deny"]
        expect(any(e.get("action") == "screenshot" for e in denials),
               f"{label}: the denial must reach the export with decision deny, got {denials}")
        c.close()

    # (b) A known secretMaskFile value can never reach the sink, even when the
    # denial's own targets quote it.
    remove_paths(EXPORT_FILE)
    with open(SECRETS_FILE, "w") as f:
        f.write("siteKey=s3cr3t-host\n")
    os.chmod(SECRETS_FILE, 0o600)
    write_policy(permissive_with(
        allowedOrigins=["https://github.com"],
        secretMaskFile=SECRETS_FILE,
        auditExport={"format": "jsonl", "destination": EXPORT_FILE}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("navigate", {"url": "https://s3cr3t-host.invalid/login"})
        expect(r and r.get("success") is False,
               f"{label}: a navigate to a denied origin should fail, got {r}")
        expect(wait_until_exported(len(audit_events())),
               f"{label}: the export sink never mirrored the masked denial, got {export_lines()}")
        raw = export_text()
        expect("s3cr3t-host" not in raw,
               f"{label}: a known secret must never reach the export sink, got {raw}")
        expect("<masked:siteKey>" in raw,
               f"{label}: the export should carry the masked placeholder, got {raw}")
        c.close()
    remove_paths(SECRETS_FILE)

    # (c) An unwritable destination disables the sink loudly and exactly once,
    # and never breaks the request that triggered it.
    remove_paths(EXPORT_FILE)
    shutil.rmtree(EXPORT_DEAD_DIR, ignore_errors=True)
    dead_sink = os.path.join(EXPORT_DEAD_DIR, "sink.jsonl")
    write_policy(permissive_with(
        auditExport={"format": "jsonl", "destination": dead_sink}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        for _ in range(3):
            r = c.req("getTabs")
            expect(r and r.get("success") is True,
                   f"{label}: a dead export sink must not block automation, got {r}")
        # Poll for the sink-failure event itself: the worker discovers the
        # failure off the request path, so an unpolled read of the audit log
        # races it. wait_until_audited keys on the DECISION, not on a count of
        # audit lines, which the three getTabs events would already satisfy.
        unavailable = wait_until_audited("audit_export_unavailable", 1)
        expect(len(unavailable) == 1
               and unavailable[0].get("action") == "auditExport"
               and unavailable[0].get("targets") == [dead_sink],
               f"{label}: a dead sink should audit exactly one audit_export_unavailable, "
               f"got {unavailable}")
        expect(not os.path.exists(dead_sink),
               f"{label}: the host must not create a sink under a missing directory")
        c.close()
    shutil.rmtree(EXPORT_DEAD_DIR, ignore_errors=True)

    # (d) CEF formatting, asserted against the captured line.
    remove_paths(EXPORT_CEF_FILE)
    write_policy(permissive_with(
        deniedActions=["screenshot"],
        auditExport={"format": "cef", "destination": EXPORT_CEF_FILE}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        c.req("screenshot", {"tabId": 7})
        expect(wait_until_export_matching("|deny|screenshot|", EXPORT_CEF_FILE),
               f"{label}: the denial never reached the CEF sink, got "
               f"{export_lines(EXPORT_CEF_FILE)}")
        cef_lines = export_lines(EXPORT_CEF_FILE)
        denials = [line for line in cef_lines if "|deny|screenshot|" in line]
        expect(denials, f"{label}: the CEF sink should carry the denial, got {cef_lines}")
        if denials:
            line = denials[0]
            expect(line.startswith("CEF:0|ChromeBridge|NativeHost|1.0|deny|screenshot|7|"),
                   f"{label}: unexpected CEF header, got {line}")
            extension = line.split("|", 7)[7]
            stamp = extension.split(" ", 1)[0]
            expect(stamp.startswith("rt=") and stamp[3:].isdigit(),
                   f"{label}: CEF rt should be epoch milliseconds, got {stamp}")
            for fragment in (" suser=alpha ", " act=screenshot ", " outcome=deny ",
                             " cs1Label=targets ", "cs1=-"):
                expect(fragment in extension,
                       f"{label}: CEF extension missing {fragment!r}, got {extension}")
        c.close()
    remove_paths(EXPORT_CEF_FILE)

    # (e) RFC 5424 syslog over UDP, asserted against the captured datagram,
    # including the severity split between the deny class and everything else.
    datagrams = []
    collector = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    collector.bind(("127.0.0.1", 0))
    collector.settimeout(0.2)
    syslog_port = collector.getsockname()[1]
    stop_collector = threading.Event()

    def collect_syslog():
        while not stop_collector.is_set():
            try:
                data, _addr = collector.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                return
            with forwarded_lock:
                datagrams.append(data.decode("utf-8", "replace"))

    collector_thread = threading.Thread(target=collect_syslog, daemon=True)
    collector_thread.start()
    write_policy(permissive_with(
        deniedActions=["screenshot"],
        auditExport={"format": "syslog",
                     "destination": f"udp://127.0.0.1:{syslog_port}"}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        c.req("getTabs")
        c.req("screenshot", {"tabId": 7})
        # Poll for the DENIAL datagram and for a non-deny datagram, not for a
        # datagram count: a count of 2 is satisfied by the two earlier getTabs
        # events, so the deny assertions below would race the datagram they are
        # about. This is the barrier weakness that hid the reroute bug.
        expect(wait_until_datagram_matching(
                   datagrams, lambda line: 'decision="deny"' in line),
               f"{label}: the syslog collector never received the denial, got {datagrams}")
        expect(wait_until_datagram_matching(
                   datagrams, lambda line: 'decision="deny"' not in line),
               f"{label}: the syslog collector never received a non-deny event, "
               f"got {datagrams}")
        with forwarded_lock:
            lines = list(datagrams)
        denials = [line for line in lines if 'decision="deny"' in line]
        others = [line for line in lines if 'decision="deny"' not in line]
        expect(denials, f"{label}: the syslog sink should carry the denial, got {lines}")
        if denials:
            line = denials[0]
            expect(line.startswith("<132>1 "),
                   f"{label}: a denial must ride at local0.warning (PRI 132), got {line}")
            expect(" - chrome-bridge - screenshot [chromeBridge@0 " in line,
                   f"{label}: unexpected syslog header, got {line}")
            expect(line.endswith('targets="-"]'),
                   f"{label}: syslog structured data should end with targets, got {line}")
        expect(others and all(line.startswith("<134>1 ") for line in others),
               f"{label}: non-deny events must ride at local0.info (PRI 134), got {others}")
        c.close()
    stop_collector.set()
    collector_thread.join(timeout=2)
    collector.close()

    # (f) Rotation is single-generation, so a file sink is a BOUNDED buffer, not
    # a durable record: with rotateBytes far below the event stream the sink
    # rotates repeatedly and each pass replaces the previous `.1`, discarding the
    # older generation by design. What must hold is that the bound is respected,
    # that no line is torn across a rotation, and that it is the OLDEST data that
    # is dropped while the newest is retained. The complete record stays in
    # bridge_audit.jsonl; a durable off-host copy needs a streaming destination.
    remove_paths(EXPORT_FILE, EXPORT_FILE + ".1")
    write_policy(permissive_with(
        auditExport={"format": "jsonl", "destination": EXPORT_FILE,
                     "rotateBytes": 400, "retainDays": 30}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        for _ in range(8):
            c.req("getTabs")
        # Wait on an ordered SENTINEL, not on file existence. Rotation renames
        # the live file, so "both files exist" only narrows the window: the
        # worker can rotate again between the predicate and the assertion. The
        # export queue is ordered and drained by a single worker, so a distinct
        # final action that has reached the live file proves every earlier event
        # already drained AND that this case has no further write pending, which
        # is the only state in which both generations are stable to inspect.
        c.req("policyInfo")

        def sentinel_landed():
            lines = export_lines()
            if not lines:
                return False
            try:
                return json.loads(lines[-1]).get("action") == "policyInfo"
            except ValueError:
                return False

        expect(wait_until(sentinel_landed),
               f"{label}: the export sentinel never reached the live sink, got {export_lines()}")
        expect(os.path.exists(EXPORT_FILE + ".1"),
               f"{label}: exceeding rotateBytes should produce a rotated generation")
        expect(not os.path.exists(EXPORT_FILE + ".2"),
               f"{label}: rotation must stay single-generation, found a .2")
        live_size = os.path.getsize(EXPORT_FILE)
        expect(live_size <= 400,
               f"{label}: the live sink must stay within rotateBytes, got {live_size}")
        live = export_lines()
        rotated = export_lines(EXPORT_FILE + ".1")
        expect(live and rotated,
               f"{label}: both generations should hold lines, got {len(live)} and {len(rotated)}")
        # No torn write: every surviving line in either generation is a complete
        # JSON event, not a fragment split by the rotation boundary.
        parsed = []
        for raw in live + rotated:
            try:
                parsed.append(json.loads(raw))
            except ValueError:
                parsed.append(None)
        expect(all(isinstance(e, dict) and e.get("action") for e in parsed),
               f"{label}: rotation must not tear a line, got {parsed}")
        # Oldest is discarded, newest is kept: the sentinel is the newest event
        # and it is the last line of the live generation.
        expect(parsed and live and json.loads(live[-1]).get("action") == "policyInfo",
               f"{label}: the live generation should end with the sentinel, got {live[-1] if live else None}")
        expect(len(live) + len(rotated) <= len(audit_events()),
               f"{label}: a bounded sink can hold at most the full audit stream")
        c.close()
    remove_paths(EXPORT_FILE, EXPORT_FILE + ".1")

    # (g) Export runs OFF the request thread: the local append stays synchronous
    # and the already-masked event is then drained by one background worker. The
    # mirror contract is unchanged, but every sink assertion is now a poll --
    # wait_until_exported -- because the line is not there when the reply is.
    remove_paths(EXPORT_FILE, EXPORT_FILE + ".1")
    write_policy(permissive_with(
        deniedActions=["screenshot"],
        requireConfirmation=["executeScript"],
        auditExport={"format": "jsonl", "destination": EXPORT_FILE}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: an allowed action must not wait on the export worker, got {r}")
        r = c.req("screenshot", {"tabId": 7})
        expect(r and r.get("success") is False
               and r.get("error") == "policy denied: action screenshot denied",
               f"{label}: the denial must still be enforced with async export on, got {r}")
        r = c.req("executeScript", {"tabId": 7, "code": "1"})
        expect(r and r.get("success") is False and r.get("confirmationRequired") is True,
               f"{label}: the confirmation gate must survive async export, got {r}")
        local = audit_events()
        expect(wait_until_exported(len(local)),
               f"{label}: the export worker never drained the queue, got {export_lines()}")
        exported = [json.loads(line) for line in export_lines()]
        expect(exported == local,
               f"{label}: async export must mirror the local audit events field for field, "
               f"got {exported} vs {local}")
        expect(any(e.get("decision") == "confirmation_required" for e in exported),
               f"{label}: the confirmation_required event must reach the sink, got {exported}")
        c.close()

    # (h) One worker draining one FIFO queue, so sink order equals local append
    # order. Alternating allow/deny decisions make the assertion sensitive to
    # ORDER rather than to the multiset of events.
    remove_paths(EXPORT_FILE, EXPORT_FILE + ".1")
    write_policy(permissive_with(
        deniedActions=["screenshot"],
        auditExport={"format": "jsonl", "destination": EXPORT_FILE}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        for _ in range(3):
            r = c.req("getTabs")
            expect(r and r.get("success") is True,
                   f"{label}: the allowed leg of the ordering drive should succeed, got {r}")
            r = c.req("screenshot", {"tabId": 7})
            expect(r and r.get("success") is False,
                   f"{label}: the denied leg of the ordering drive should fail, got {r}")
        local = audit_events()
        expect(wait_until_exported(len(local)),
               f"{label}: the export worker never drained all six events, got {export_lines()}")
        exported = [json.loads(line) for line in export_lines()]
        local_order = [(e.get("action"), e.get("decision")) for e in local]
        export_order = [(e.get("action"), e.get("decision")) for e in exported]
        expect(export_order == local_order,
               f"{label}: the exported order must equal the local audit order, "
               f"got {export_order} vs {local_order}")
        expect(len({d for _a, d in local_order}) > 1,
               f"{label}: the ordering drive should mix decisions, got {local_order}")
        c.close()

    # (i) Fail-closed behavior survives the move to a worker thread: the failure
    # is now detected off the request path, so it is polled for, and it still
    # disables the sink after exactly ONE audit_export_unavailable event while
    # every request keeps succeeding.
    remove_paths(EXPORT_FILE)
    shutil.rmtree(EXPORT_DEAD_DIR, ignore_errors=True)
    async_dead_sink = os.path.join(EXPORT_DEAD_DIR, "async-sink.jsonl")
    write_policy(permissive_with(
        auditExport={"format": "jsonl", "destination": async_dead_sink}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        r = c.req("getTabs")
        expect(r and r.get("success") is True,
               f"{label}: a dead async sink must not block the first request, got {r}")
        unavailable = wait_until_audited("audit_export_unavailable", 1)
        expect(len(unavailable) == 1
               and unavailable[0].get("action") == "auditExport"
               and unavailable[0].get("targets") == [async_dead_sink],
               f"{label}: the worker should audit one audit_export_unavailable naming the "
               f"sink, got {unavailable}")
        # Keep driving traffic through the now-disabled sink and give the worker a
        # bounded window to report a second failure. It must never come.
        for _ in range(3):
            r = c.req("getTabs")
            expect(r and r.get("success") is True,
                   f"{label}: a dead async sink must not block automation, got {r}")
        again = wait_until_audited("audit_export_unavailable", 2, timeout=2.0)
        expect(len(again) == 1,
               f"{label}: a dead sink must audit audit_export_unavailable exactly once for "
               f"the life of the process, got {again}")
        expect(not os.path.exists(async_dead_sink),
               f"{label}: the worker must not create a sink under a missing directory")
        c.close()
    shutil.rmtree(EXPORT_DEAD_DIR, ignore_errors=True)

    # (j) Masking happens BEFORE the event is queued, so the worker only ever
    # holds already-masked bytes and a secretMaskFile value cannot reach the sink
    # even though a different thread writes it.
    remove_paths(EXPORT_FILE)
    with open(SECRETS_FILE, "w") as f:
        f.write("siteKey=s3cr3t-async-sink\n")
    os.chmod(SECRETS_FILE, 0o600)
    write_policy(permissive_with(
        allowedOrigins=["https://github.com"],
        secretMaskFile=SECRETS_FILE,
        auditExport={"format": "jsonl", "destination": EXPORT_FILE}))
    with Host(label, cmd, env):
        c = Client("tok-alpha")
        for n in range(3):
            r = c.req("navigate", {"url": f"https://s3cr3t-async-sink.invalid/{n}"})
            expect(r and r.get("success") is False
                   and r.get("error") == "policy denied: target not allowed",
                   f"{label}: navigate to an unlisted origin should be denied, got {r}")
        local = audit_events()
        expect(wait_until_exported(len(local)),
               f"{label}: the worker never drained the masked denials, got {export_lines()}")
        raw = export_text()
        expect("s3cr3t-async-sink" not in raw,
               f"{label}: a known secret must never reach the sink's raw bytes, got {raw}")
        expect(raw.count("<masked:siteKey>") >= 3,
               f"{label}: every masked denial should carry the placeholder, got {raw}")
        c.close()
    remove_paths(SECRETS_FILE, EXPORT_FILE)

    # (k) The sink is resolved ONCE, on the request thread, and the resolved
    # config is enqueued WITH the event, so a policy reload while events are
    # queued can never reroute an already-authorized event into a destination
    # configured later. Determinism comes from the FIFO destination: both hosts
    # open a file sink with a plain blocking open(2), which on a reader-less FIFO
    # never returns, so the worker is provably parked on the first event and the
    # rest provably sit in the queue. No sleep, no timeout, no scheduling luck --
    # the worker cannot advance until this case opens the read end.
    if hasattr(os, "mkfifo"):
        remove_paths(EXPORT_SWITCH_FILE)
        make_blocking_fifo(EXPORT_FIFO)
        write_policy(permissive_with(
            allowedOrigins=["https://github.com"],
            auditExport={"format": "jsonl", "destination": EXPORT_FIFO}))
        reader = FifoReader(EXPORT_FIFO)
        with Host(label, cmd, env):
            c = Client("tok-alpha")
            for n in range(3):
                r = c.req("navigate", {"url": f"https://sink-a-only.invalid/{n}"})
                expect(r and r.get("success") is False,
                       f"{label}: navigate to an unlisted origin should be denied, got {r}")
            # The local append is synchronous, so once the log holds them they are
            # already queued against sink A.
            expect(wait_until(lambda: sum(
                       1 for e in audit_events() if "sink-a-only" in json.dumps(e)) >= 3),
                   f"{label}: the sink-A events never reached the local audit log, "
                   f"got {audit_events()}")
            # Now switch the destination while those events are stuck in the queue.
            reload_policy_barrier(c, permissive_with(
                allowedOrigins=["https://github.com"],
                auditExport={"format": "jsonl",
                             "destination": EXPORT_SWITCH_FILE}), label)
            expect(not os.path.exists(EXPORT_SWITCH_FILE),
                   f"{label}: the parked worker cannot have drained anything yet, got "
                   f"{export_text(EXPORT_SWITCH_FILE)}")
            for n in range(2):
                c.req("navigate", {"url": f"https://sink-b-only.invalid/{n}"})
            # Release the worker: opening the read end completes its pending open.
            reader.release()
            expect(wait_until_export_matching("sink-b-only", EXPORT_SWITCH_FILE),
                   f"{label}: events produced under the new policy never reached the new "
                   f"sink, got {export_text(EXPORT_SWITCH_FILE)}")
            # Delivered to the destination that authorized them...
            expect(wait_until(lambda: sum(
                       1 for line in reader.text().splitlines()
                       if "sink-a-only" in line) >= 3),
                   f"{label}: a queued event must still reach the sink that authorized it, "
                   f"got {reader.text()!r}")
            # ...and never to the one configured afterwards.
            switched = export_text(EXPORT_SWITCH_FILE)
            expect("sink-a-only" not in switched,
                   f"{label}: an event authorized for one destination must never land in a "
                   f"destination configured later, got {switched}")
            c.close()
        reader.close()
        remove_paths(EXPORT_SWITCH_FILE, EXPORT_FIFO)

    # (l) A reload that removes auditExport ENTIRELY must not resurrect or
    # misroute already-queued events either: they still belong to the sink that
    # was in force when they were produced, so they are delivered there and the
    # disappearance of the policy key cannot silently discard them. Same FIFO
    # barrier, so the events are provably still queued when the sink vanishes.
    if hasattr(os, "mkfifo"):
        remove_paths(EXPORT_SWITCH_FILE)
        make_blocking_fifo(EXPORT_FIFO)
        write_policy(permissive_with(
            allowedOrigins=["https://github.com"],
            auditExport={"format": "jsonl", "destination": EXPORT_FIFO}))
        reader = FifoReader(EXPORT_FIFO)
        with Host(label, cmd, env):
            c = Client("tok-alpha")
            for n in range(3):
                r = c.req("navigate", {"url": f"https://sink-gone.invalid/{n}"})
                expect(r and r.get("success") is False,
                       f"{label}: navigate to an unlisted origin should be denied, got {r}")
            expect(wait_until(lambda: sum(
                       1 for e in audit_events() if "sink-gone" in json.dumps(e)) >= 3),
                   f"{label}: the queued events never reached the local audit log, "
                   f"got {audit_events()}")
            # Drop auditExport from policy while the worker is still parked.
            reload_policy_barrier(
                c, permissive_with(allowedOrigins=["https://github.com"]), label)
            reader.release()
            expect(wait_until(lambda: sum(
                       1 for line in reader.text().splitlines()
                       if "sink-gone" in line) >= 3),
                   f"{label}: removing the sink from policy must not discard events already "
                   f"queued against it, got {reader.text()!r}")
            local = audit_events()
            expect(sum(1 for e in local if "sink-gone" in json.dumps(e)) >= 3,
                   f"{label}: the local audit log stays the complete record, got {local}")
            c.close()
        reader.close()
        remove_paths(EXPORT_FIFO)



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

    # The payload escalation table must be byte-identical in intent across hosts:
    # same (action, flag, kind) triples and the same enum values, or the two
    # hosts would compute different effective tiers for the same request.
    rm = re.search(r"const ESCALATING_PAYLOAD_FLAGS[^=]*=\s*\[(.*?)\n\];", rs, re.S)
    expect(rm is not None, "rust: could not locate ESCALATING_PAYLOAD_FLAGS table")
    if rm:
        rust_rows = set()
        for row in re.findall(r'\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*&\[([^\]]*)\]\s*\)', rm.group(1)):
            action, flag, kind, values = row
            rust_rows.add((action, flag, kind, tuple(re.findall(r'"([^"]+)"', values))))
        py_rows = {(a, f, k, tuple(v)) for a, f, k, v in bridge.ESCALATING_PAYLOAD_FLAGS}
        expect(py_rows == rust_rows,
               "python/rust escalation table drift: "
               f"py-only={sorted(py_rows - rust_rows)} rust-only={sorted(rust_rows - py_rows)}")
    # And the tier helper must exist in both hosts under the contract name.
    expect(callable(getattr(bridge, "effective_action_tier", None)),
           "python: effective_action_tier is missing")
    expect("fn effective_action_tier(" in rs,
           "rust: effective_action_tier is missing")

    # The egress action set decides which requests the egressAllowlist can bound
    # at all, so drift would silently exempt an action in one host only.
    em = re.search(r"const EGRESS_URL_ACTIONS[^=]*=\s*\[(.*?)\];", rs, re.S)
    expect(em is not None, "rust: could not locate EGRESS_URL_ACTIONS")
    if em:
        rust_egress = set(re.findall(r'"([^"]+)"', em.group(1)))
        expect(bridge.EGRESS_URL_ACTIONS == rust_egress,
               "python/rust EGRESS_URL_ACTIONS drift: "
               f"py-only={sorted(bridge.EGRESS_URL_ACTIONS - rust_egress)} "
               f"rust-only={sorted(rust_egress - bridge.EGRESS_URL_ACTIONS)}")
    expect("egressAllowlist" in bridge._POLICY_LIST_KEYS,
           "python: egressAllowlist must merge as a list policy key")
    lm = re.search(r"const POLICY_LIST_KEYS[^=]*=\s*\[(.*?)\];", rs, re.S)
    expect(lm is not None and "egressAllowlist" in lm.group(1),
           "rust: egressAllowlist must merge as a list policy key")

    # The DLP channel map decides which chokepoints a `block`/`audit` mode can
    # reach, so drift would leave one host enforcing a channel the other ignores.
    expect("dlp" in bridge._POLICY_MAP_KEYS,
           "python: dlp must merge as a map policy key")
    mm = re.search(r"const POLICY_MAP_KEYS[^=]*=\s*\[(.*?)\];", rs, re.S)
    expect(mm is not None and '"dlp"' in mm.group(1),
           "rust: dlp must merge as a map policy key")
    cm2 = re.search(r"const DLP_CHANNELS[^=]*=\s*\[(.*?)\];", rs, re.S)
    expect(cm2 is not None, "rust: could not locate DLP_CHANNELS")
    if cm2:
        expect(tuple(re.findall(r'"([^"]+)"', cm2.group(1))) == bridge.DLP_CHANNELS,
               f"python/rust DLP_CHANNELS drift: rust={cm2.group(1)} py={bridge.DLP_CHANNELS}")
    mo = re.search(r"const DLP_MODES[^=]*=\s*\[(.*?)\];", rs, re.S)
    expect(mo is not None and tuple(re.findall(r'"([^"]+)"', mo.group(1))) == bridge.DLP_MODES,
           f"python/rust DLP_MODES drift: py={bridge.DLP_MODES}")
    # Rust encodes the action->channel map as a match arm rather than a table, so
    # compare the action names Python maps against the arms Rust lists.
    fm = re.search(r"fn dlp_channel_for_action\(action: &str\)[^{]*\{(.*?)\n\}", rs, re.S)
    expect(fm is not None, "rust: could not locate dlp_channel_for_action")
    if fm:
        # Only the left side of each `=>` names actions; the right side names
        # channels, which would otherwise pollute the comparison.
        rust_actions = set()
        for arm in re.findall(r'^\s*((?:"[A-Za-z]+"\s*\|\s*)*"[A-Za-z]+")\s*=>',
                              fm.group(1), re.M):
            rust_actions.update(re.findall(r'"([A-Za-z]+)"', arm))
        py_actions = set(bridge.DLP_ACTION_CHANNELS)
        expect(py_actions == rust_actions,
               "python/rust DLP action map drift: "
               f"py-only={sorted(py_actions - rust_actions)} "
               f"rust-only={sorted(rust_actions - py_actions)}")
    # And the extension's own refusal table must cover the same actions, since it
    # is the gate that sits ahead of DOM.setFileInputFiles.
    bg = open(os.path.join(SCRIPT_DIR, "background.js")).read()
    bm = re.search(r"const DLP_ACTION_CHANNELS = \{(.*?)\};", bg, re.S)
    expect(bm is not None, "background.js: could not locate DLP_ACTION_CHANNELS")
    if bm:
        ext_actions = set(re.findall(r'^\s*([A-Za-z]+):', bm.group(1), re.M))
        expect(ext_actions == set(bridge.DLP_ACTION_CHANNELS),
               "extension/host DLP action map drift: "
               f"ext-only={sorted(ext_actions - set(bridge.DLP_ACTION_CHANNELS))} "
               f"host-only={sorted(set(bridge.DLP_ACTION_CHANNELS) - ext_actions)}")


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
