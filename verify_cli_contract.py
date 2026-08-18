#!/usr/bin/env python3
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
CLIENT = os.path.join(SCRIPT_DIR, "test_client.py")
ENV = os.environ.copy()
# Port 9 should be closed; recognized commands should attempt a connection and
# return 111. Unknown actions should return 64. This lets us test CLI dispatch
# without needing a live Chrome extension.
ENV["BRIDGE_PORT"] = "9"
ENV["BRIDGE_CONNECT_TIMEOUT_SECONDS"] = "0"
TOKEN_FIXTURE = "/tmp/chrome-bridge-contract-token.txt"
with open(TOKEN_FIXTURE, "w", encoding="utf-8") as f:
    f.write("contract-token\n")
ENV["BRIDGE_TOKEN_FILE"] = TOKEN_FIXTURE


UPLOAD_FIXTURE = "/tmp/chrome-bridge-upload.txt"
with open(UPLOAD_FIXTURE, "w", encoding="utf-8") as f:
    f.write("chrome bridge upload fixture\n")
RICH_TEXT_FIXTURE = "/tmp/chrome-bridge-rich-text.json"
with open(RICH_TEXT_FIXTURE, "w", encoding="utf-8") as f:
    f.write('[{"type":"paragraph","children":[{"type":"text","text":"Hello"}]}]\n')


CASES = [
    (["ping"], 111),
    (["ready", "0", "50"], 1),
    (["navigate", "https://example.com"], 111),
    (["navigate", "https://example.com", "--foreground"], 111),
    (["navigateAndSnapshot", "https://example.com", "--wait", "selector", "--selector", "#ready"], 111),
    (["navigateAndSnapshot", "https://example.com", "--wait", "url"], 2),
    (["getCookies", "example.com"], 111),
    (["executeScript", "1", "document.title"], 111),
    (["getTabs"], 111),
    (["taskSession", "create", "research"], 111),
    (["taskSession", "navigate", "session-1", "https://example.com"], 111),
    (["taskSession", "show"], 111),
    (["taskSession", "show", "session-1"], 111),
    (["taskSession", "state", "session-1", "completed"], 111),
    (["taskSession", "close", "session-1"], 111),
    (["executeScriptCDP", "1", "document.title"], 111),
    (["click", "1", "#submit"], 111),
    (["type", "1", "input[name=q]", "hello"], 111),
    (["observe", "1"], 111),
    (["observe", "1", "--full", "--role", "button,link", "--name", "save", "--limit", "10"], 111),
    (["activateTab", "1"], 111),
    (["closeTab", "1"], 111),
    (["reload", "1"], 111),
    (["goBack", "1"], 111),
    (["goForward", "1"], 111),
    (["waitForLoad", "1", "5000"], 111),
    (["waitForSelector", "1", "#ready", "5000"], 111),
    (["waitForText", "1", "Loaded", "5000"], 111),
    (["waitForUrl", "1", "github.com", "5000"], 111),
    (["expect", "1", "selector", "#done"], 111),
    (["expect", "1", "text", "Order confirmed", "--timeout", "2000"], 111),
    (["expect", "1", "url", "github.com", "--negate"], 111),
    (["getCurrentState", "1"], 111),
    (["screenshot", "1", "/tmp/chrome-bridge-shot.png"], 111),
    (["screenshot", "1", "/tmp/chrome-bridge-shot.png", "--visible"], 111),
    (["extractText", "1", "2000"], 111),
    (["getHTML", "1", "/tmp/chrome-bridge-page.html"], 111),
    (["hover", "1", "#target"], 111),
    (["scroll", "1", "0", "500"], 111),
    (["scroll", "1", "0", "500", "#panel"], 111),
    (["press", "1", "Enter"], 111),
    (["drag", "1", "#from", "#to"], 111),
    (["fill", "1", "input[name=q]", "hello"], 111),
    (["insertRichText", "1", "#editor", RICH_TEXT_FIXTURE], 111),
    (["select", "1", "select[name=kind]", "beta"], 111),
    (["uploadFile", "1", "input[type=file]", UPLOAD_FIXTURE], 111),
    (["githubAttachUploadedFiles", "1", "input[type=file]"], 111),
    (["githubAttachUploadedFiles", "1", "input[type=file]", ".js-comment-form", "15000"], 111),
    (["githubSubmitComment", "1"], 111),
    (["githubSubmitComment", "1", ".js-comment-form", "15000"], 111),
    (["github-attach-pr-body", "1", UPLOAD_FIXTURE], 111),
    (["githubAttachPrBody", "1", UPLOAD_FIXTURE, "--timeout", "15000"], 111),
    (["setViewport", "1", "1280", "720", "1"], 111),
    (["startMonitoring", "1"], 111),
    (["stopMonitoring", "1"], 111),
    (["startScreencast", "1"], 111),
    (["screencastSave", "1", "/tmp/chrome-bridge-screencast"], 111),
    (["stopScreencast", "1"], 111),
    (["consoleMessages", "1"], 111),
    (["networkRequests", "1"], 111),
    (["handleDialog", "1", "accept"], 111),
    (["handleDialog", "1", "accept", "typed prompt value"], 111),
    (["startInterception", "1", "*api*", "continue"], 111),
    (["startInterception", "1", "*api*", "abort"], 111),
    (["startInterception", "1", "*api*", "fulfill", "200", '{"data":1}'], 111),
    (["stopInterception", "1"], 111),
    (["interceptedRequests", "1"], 111),
    (["downloadUrl", "https://example.com/file.zip"], 111),
    (["downloadUrl", "https://example.com/file.zip", "my_file.zip"], 111),
    (["storageState", "1", "/tmp/chrome-bridge-state.json"], 111),
    (["setGeolocation", "1", "37.7749", "-122.4194"], 111),
    (["setGeolocation", "1", "37.7749", "-122.4194", "100"], 111),
    (["clearGeolocation", "1"], 111),
    (["performanceMetrics", "1"], 111),
    (["policy", "info"], 111),
    (["confirm", "confirm-token"], 111),
    (["noSuchAction"], 64),
]

failed = False
for args, expected in CASES:
    proc = subprocess.run([CLIENT, *args], env=ENV, text=True, capture_output=True)
    if proc.returncode != expected:
        failed = True
        print(f"FAIL {' '.join(args)}: expected exit {expected}, got {proc.returncode}")
        if proc.stdout:
            print("stdout:", proc.stdout.strip())
        if proc.stderr:
            print("stderr:", proc.stderr.strip())

missing = "/tmp/chrome-bridge-upload-missing.txt"
try:
    os.unlink(missing)
except FileNotFoundError:
    pass
proc = subprocess.run(
    [CLIENT, "uploadFile", "1", "input[type=file]", missing],
    env=ENV,
    text=True,
    capture_output=True,
)
if proc.returncode != 2 or "Upload file not found:" not in proc.stderr:
    failed = True
    print(f"FAIL uploadFile missing preflight: expected exit 2 and missing-file stderr, got {proc.returncode}")
    if proc.stdout:
        print("stdout:", proc.stdout.strip())
    if proc.stderr:
        print("stderr:", proc.stderr.strip())

# Offline dispatch assertions: import the client module and monkeypatch
# send_command_data so we can observe the exact action/payload/read_timeout_ms
# produced by main() without needing a live bridge.
import importlib.util

_spec = importlib.util.spec_from_file_location("test_client", CLIENT)
test_client = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(test_client)

captured = {}

def _fake_send_command_data(
        action, payload=None, read_timeout_ms=None, confirmation_token=None, **kwargs):
    captured["action"] = action
    captured["payload"] = payload
    captured["read_timeout_ms"] = read_timeout_ms
    captured["confirmation_token"] = confirmation_token
    captured["extra_kwargs"] = kwargs
    if action == "ping":
        result = "pong"
    elif action == "screenshot":
        result = {"dataUrl": "data:image/png;base64,iVBORw0KGgo="}
    else:
        result = {}
    # Mimic a successful response so send_command returns exit code 0.
    return 0, {"success": True, "result": result}, ""

test_client.send_command_data = _fake_send_command_data

def dispatch(argv):
    captured.clear()
    saved_argv = sys.argv
    sys.argv = [CLIENT, *argv]
    try:
        test_client.main()
    except SystemExit:
        pass
    finally:
        sys.argv = saved_argv
    return dict(captured)

def check(name, got, expected):
    global failed
    if got != expected:
        failed = True
        print(f"FAIL {name}: expected {expected}, got {got}")

_saved_broker_timeout = os.environ.pop("BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS", None)
_saved_response_timeout = os.environ.pop("BRIDGE_RESPONSE_TIMEOUT_SECONDS", None)
try:
    check("default bridge response timeout", test_client.response_timeout_seconds(), 15.0)
    os.environ["BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS"] = "45"
    check("broker-aligned response timeout", test_client.response_timeout_seconds(), 50.0)
    check("action-aligned response timeout", test_client.response_timeout_seconds(60000), 70.0)
finally:
    if _saved_broker_timeout is None:
        os.environ.pop("BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS", None)
    else:
        os.environ["BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS"] = _saved_broker_timeout
    if _saved_response_timeout is None:
        os.environ.pop("BRIDGE_RESPONSE_TIMEOUT_SECONDS", None)
    else:
        os.environ["BRIDGE_RESPONSE_TIMEOUT_SECONDS"] = _saved_response_timeout

_doctor_invocation = {}
_saved_subprocess_run = test_client.subprocess.run
def _fake_doctor_run(argv, check=False):
    _doctor_invocation["argv"] = argv
    _doctor_invocation["check"] = check
    return type("Completed", (), {"returncode": 0})()
test_client.subprocess.run = _fake_doctor_run
try:
    check("doctor rc", test_client.cmd_doctor(), 0)
    check(
        "doctor script",
        os.path.basename(_doctor_invocation.get("argv", ["", ""])[1]),
        "diagnose_install.py",
    )
finally:
    test_client.subprocess.run = _saved_subprocess_run

ready = test_client.bridge_readiness(100, 50)
check("readiness ready", ready.get("ready"), True)
check("readiness backend", ready.get("backend"), "reachable")
check("readiness extension", ready.get("extension"), "connected")

result = dispatch(["sessionStatus", "a.com", "b.com"])
check("sessionStatus action", result.get("action"), "sessionStatus")
check("sessionStatus payload", result.get("payload"), {"domains": ["a.com", "b.com"]})

result = dispatch(["waitForHandoff", "please log in", "selector", "#ok", "60000"])
check("waitForHandoff action", result.get("action"), "waitForHandoff")
check(
    "waitForHandoff payload",
    result.get("payload"),
    {"message": "please log in", "until": {"mode": "selector", "selector": "#ok"}, "timeoutMs": 60000},
)
check("waitForHandoff read_timeout_ms", result.get("read_timeout_ms"), 60000)

result = dispatch(["navigate", "https://example.com"])
check("default navigate payload", result.get("payload"), {"url": "https://example.com", "active": False})

result = dispatch(["navigate", "https://example.com", "--foreground"])
check("foreground navigate payload", result.get("payload"), {"url": "https://example.com", "active": True})
result = dispatch([
    "navigateAndSnapshot", "https://example.com",
    "--session", "session-1", "--wait", "selector", "--selector", "#ready",
    "--timeout", "2000", "--role", "button,link", "--diff",
])
check("navigate-and-snapshot action", result.get("action"), "navigateAndSnapshot")
check("navigate-and-snapshot payload", result.get("payload"), {
    "url": "https://example.com",
    "waitMode": "selector",
    "compact": True,
    "limit": 50,
    "sessionId": "session-1",
    "selector": "#ready",
    "timeoutMs": 2000,
    "roles": ["button", "link"],
    "diff": True,
})
check("navigate-and-snapshot read timeout", result.get("read_timeout_ms"), 2000)


result = dispatch(["taskSession", "create", "research"])
check("task session create action", result.get("action"), "createTaskSession")
check("task session create payload", result.get("payload"), {"name": "research"})

result = dispatch(["taskSession", "navigate", "session-1", "https://example.com"])
check("task session navigate action", result.get("action"), "navigateTaskSession")
check("task session navigate payload", result.get("payload"), {
    "sessionId": "session-1", "url": "https://example.com", "active": False, "reuse": True,
})

result = dispatch(["taskSession", "navigate", "session-1", "https://example.com", "--foreground", "--new"])
check("task session foreground payload", result.get("payload"), {
    "sessionId": "session-1", "url": "https://example.com", "active": True, "reuse": False,
})

result = dispatch(["taskSession", "show", "session-1"])
check("task session show payload", result.get("payload"), {"sessionId": "session-1"})

result = dispatch(["taskSession", "state", "session-1", "needs_user"])
check("task session state action", result.get("action"), "updateTaskSessionState")
check("task session state payload", result.get("payload"), {"sessionId": "session-1", "state": "needs_user"})

result = dispatch(["taskSession", "close", "session-1"])
check("task session close action", result.get("action"), "closeTaskSession")
check("task session close payload", result.get("payload"), {"sessionId": "session-1"})

result = dispatch(["insertRichText", "1", "#editor", RICH_TEXT_FIXTURE])
check("insert rich text action", result.get("action"), "insertRichText")
check("insert rich text payload", result.get("payload"), {
    "tabId": 1,
    "selector": "#editor",
    "nodes": [{"type": "paragraph", "children": [{"type": "text", "text": "Hello"}]}],
    "clear": True,
})

result = dispatch(["screenshot", "1", "/tmp/chrome-bridge-shot.png"])
check("default screenshot payload", result.get("payload"), {"tabId": 1, "format": "png", "quiet": True})

result = dispatch(["screenshot", "1", "/tmp/chrome-bridge-shot.png", "--visible"])
check("visible screenshot payload", result.get("payload"), {"tabId": 1, "format": "png", "quiet": False})

result = dispatch(["observe", "1"])
check("default observe payload", result.get("payload"), {"tabId": 1, "compact": True, "limit": 50})

result = dispatch(["observe", "1", "--full", "--role", "button,link", "--name", "save", "--limit", "10"])
check("filtered observe payload", result.get("payload"), {
    "tabId": 1, "compact": False, "limit": 10, "roles": ["button", "link"], "name": "save",
})

result = dispatch(["observe", "1", "--limit", "10", "--full"])
check("observe option order payload", result.get("payload"), {
    "tabId": 1, "compact": False, "limit": 10,
})

result = dispatch(["githubAttachUploadedFiles", "1", "input[type=file]", ".js-comment-form", "15000"])
check("githubAttachUploadedFiles action", result.get("action"), "githubAttachUploadedFiles")
check("githubAttachUploadedFiles payload", result.get("payload"), {
    "tabId": 1,
    "inputSelector": "input[type=file]",
    "formSelector": ".js-comment-form",
    "timeoutMs": 15000,
})

result = dispatch(["githubSubmitComment", "1", ".js-comment-form", "15000"])
check("githubSubmitComment action", result.get("action"), "githubSubmitComment")
check("githubSubmitComment payload", result.get("payload"), {
    "tabId": 1,
    "formSelector": ".js-comment-form",
    "timeoutMs": 15000,
})

result = dispatch(["github-attach-pr-body", "1", UPLOAD_FIXTURE, "--timeout", "15000"])
check("githubAttachPrBody action", result.get("action"), "githubAttachPrBody")
check("githubAttachPrBody payload", result.get("payload"), {
    "tabId": 1,
    "files": [os.path.abspath(UPLOAD_FIXTURE)],
    "timeoutMs": 15000,
})
check("githubAttachPrBody read timeout", result.get("read_timeout_ms"), None)

result = dispatch(["confirm", "confirm-token"])
check("token-only confirm action", result.get("action"), "confirm")
check("token-only confirm payload", result.get("payload"), {"confirmationToken": "confirm-token"})

result = dispatch(["confirm", "executeScript", "legacy-token", '{"tabId":1,"code":"1"}'])
check("legacy confirm action", result.get("action"), "executeScript")
check("legacy confirm token", result.get("confirmation_token"), "legacy-token")

# Normal top-level and per-command help never contact the bridge.
for help_args, needle in [
    (["--help"], "Common commands:"),
    (["help", "observe"], "--role"),
    (["executeScript", "--help"], "chrome-bridge confirm <token>"),
]:
    proc = subprocess.run([CLIENT, *help_args], env=ENV, text=True, capture_output=True)
    check(f"help {' '.join(help_args)} exit", proc.returncode, 0)
    check(f"help {' '.join(help_args)} content", needle in proc.stdout, True)

# --- policy subcommands: file edits and doctor work against local files using
#     the paths the host reports via policyInfo (here a fake host). ---
import json as _json

POLICY_FIXTURE = "/tmp/chrome-bridge-cli-policy.json"
AUDIT_FIXTURE = "/tmp/chrome-bridge-cli-audit.jsonl"
for _p in (POLICY_FIXTURE, AUDIT_FIXTURE):
    try:
        os.unlink(_p)
    except FileNotFoundError:
        pass

def _fake_policy_info(action, payload=None, read_timeout_ms=None, confirmation_token=None):
    return 0, {"success": True, "result": {
        "policyFile": POLICY_FIXTURE,
        "policyFileExists": os.path.exists(POLICY_FIXTURE),
        "auditLogFile": AUDIT_FIXTURE,
        "client": "alpha",
    }}, ""

test_client.send_command_data = _fake_policy_info

# allow-action creates the file and adds to default.allowedActions, seeding the
# new list from the built-in defaults so inherited grants survive the edit.
rc = test_client.cmd_policy(["test_client.py", "policy", "allow-action", "getCookies"])
check("allow-action rc", rc, 0)
_pol = _json.load(open(POLICY_FIXTURE))
_da = _pol.get("default", {}).get("allowedActions", [])
check("allow-action added the new action", "getCookies" in _da, True)
check("allow-action preserved inherited ping", "ping" in _da, True)
check("allow-action preserved inherited policyInfo", "policyInfo" in _da, True)

# Re-adding the same action is idempotent (no duplicate).
rc = test_client.cmd_policy(["test_client.py", "policy", "allow-action", "getCookies"])
_pol = _json.load(open(POLICY_FIXTURE))
check("allow-action idempotent",
      _pol.get("default", {}).get("allowedActions", []).count("getCookies"), 1)

# allow-origin appends to allowedOrigins in the same section.
rc = test_client.cmd_policy(["test_client.py", "policy", "allow-origin", "https://example.com"])
check("allow-origin rc", rc, 0)
_pol = _json.load(open(POLICY_FIXTURE))
check("allow-origin added the origin",
      "https://example.com" in _pol.get("default", {}).get("allowedOrigins", []), True)

# The policy file must be written mode 600 (governs automation reach).
check("policy file mode 600", oct(os.stat(POLICY_FIXTURE).st_mode & 0o777), oct(0o600))

# Enforce permissions on existing broad files: change to 0644, write, and ensure it gets restricted to 0600.
try:
    os.chmod(POLICY_FIXTURE, 0o644)
except OSError:
    pass
rc = test_client.cmd_policy(["test_client.py", "policy", "allow-action", "anotherAction"])
check("allow-action rc on broad file", rc, 0)
check("policy file mode restricted to 600", oct(os.stat(POLICY_FIXTURE).st_mode & 0o777), oct(0o600))

# Enforce permissions on existing broad files even when no change happens (no-op).
try:
    os.chmod(POLICY_FIXTURE, 0o644)
except OSError:
    pass
rc = test_client.cmd_policy(["test_client.py", "policy", "allow-action", "anotherAction"])
check("allow-action no-op rc on broad file", rc, 0)
check("policy file mode restricted to 600 on no-op", oct(os.stat(POLICY_FIXTURE).st_mode & 0o777), oct(0o600))
# An explicitly named client edits clients.<name>, never the shared default, and
# seeds the new client list from the existing default layer so the client does
# not lose the grants default already conferred.
rc = test_client.cmd_policy(["test_client.py", "policy", "allow-action", "newaction", "beta"])
check("explicit-client allow-action rc", rc, 0)
_pol = _json.load(open(POLICY_FIXTURE))
_beta = _pol.get("clients", {}).get("beta", {}).get("allowedActions", [])
check("explicit client created clients.beta with new action", "newaction" in _beta, True)
check("explicit client seeded from default (getCookies inherited)", "getCookies" in _beta, True)
check("explicit client did not add to default",
      "newaction" in _pol.get("default", {}).get("allowedActions", []), False)

# doctor validates task-session actions as one ownership/cleanup capability and
# catches the historical transposed wire-action name before a request is denied.
_pol = _json.load(open(POLICY_FIXTURE))
_pol.setdefault("clients", {})["broken"] = {
    "allowedActions": ["createTaskSession", "taskSessionNavigate"],
}
with open(POLICY_FIXTURE, "w") as f:
    _json.dump(_pol, f)

# doctor splits "not allowed" (grant) from "denied" (remove deny-list).
with open(AUDIT_FIXTURE, "w") as f:
    f.write(_json.dumps({"decision": "deny", "action": "getTabs",
                         "reason": "action getTabs not allowed", "targets": []}) + "\n")
    f.write(_json.dumps({"decision": "deny", "action": "getCookies",
                         "reason": "action getCookies denied", "targets": []}) + "\n")
    f.write(_json.dumps({"decision": "deny", "action": "navigate",
                         "reason": "target denied", "targets": ["*://mail.google.com"]}) + "\n")
    f.write(_json.dumps({"decision": "deny", "action": "navigate",
                         "reason": "target not allowed", "targets": ["https://x.test"]}) + "\n")
    f.write(_json.dumps({"decision": "deny", "action": "batch",
                         "reason": "batch step 2: action executeScript not allowed", "targets": []}) + "\n")

import io as _io
import contextlib as _ctx
_buf = _io.StringIO()
with _ctx.redirect_stdout(_buf):
    rc = test_client.cmd_policy(["test_client.py", "policy", "doctor"])
check("doctor rc", rc, 0)
_doc = _json.loads(_buf.getvalue())
_issues = _doc.get("configurationIssues", [])
check("doctor catches unknown task-session action",
      any(i.get("kind") == "unknownAction"
          and i.get("action") == "taskSessionNavigate"
          and i.get("replacement") == "navigateTaskSession"
          for i in _issues), True)
check("doctor catches incomplete task-session capability",
      any(i.get("kind") == "incompleteCapability"
          and i.get("section") == "clients.broken"
          and "closeTaskSession" in i.get("missing", [])
          for i in _issues), True)
_by_reason = {d["reason"]: d.get("suggestion") for d in _doc.get("denials", [])}
check("doctor not-allowed action grants",
      _by_reason.get("action getTabs not allowed"), {"cli": "policy allow-action getTabs"})
check("doctor denied action is manual deny-list removal",
      (_by_reason.get("action getCookies denied") or {}).get("manual") is not None, True)
check("doctor target not allowed grants origin",
      _by_reason.get("target not allowed"), {"cli": "policy allow-origin 'https://x.test'"})
check("doctor target denied is manual",
      (_by_reason.get("target denied") or {}).get("manual") is not None, True)
_batch = next((d for d in _doc.get("denials", []) if d.get("batchStep") == 2), None)
check("doctor surfaces batch step index", _batch is not None, True)
check("doctor batch step inner reason gets grant",
      (_batch or {}).get("suggestion"), {"cli": "policy allow-action executeScript"})

if failed:
    sys.exit(1)
print("CLI contract OK")
