#!/usr/bin/env python3
"""Offline contract checks for quiet reads and task-scoped debugger reuse."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent
FAILURES = []


def expect(condition, message):
    if not condition:
        FAILURES.append(message)
        print(f"FAIL: {message}")


def function_body(text, name, next_name):
    start = f"async function {name}"
    end = f"async function {next_name}"
    expect(start in text, f"missing function {name}")
    expect(end in text, f"missing function boundary {next_name}")
    if start not in text or end not in text:
        return ""
    return text.split(start, 1)[1].split(end, 1)[0]


for path in (ROOT / "background.js", ROOT / "extension" / "background.js"):
    text = path.read_text(encoding="utf-8")
    label = str(path.relative_to(ROOT))

    for needle in (
        "TASK_DEBUGGER_IDLE_MS",
        "taskDebuggerStates",
        "mutateTaskSessions",
        "findTaskSessionForTab",
        "acquireTaskDebugger",
        "releaseTaskDebugger",
        "withTaskDebugger",
        "detachTaskSessionDebuggers",
        "pageContainsText",
        "readBodyLengthInTab",
    ):
        expect(needle in text, f"{label} missing quiet-debugger contract: {needle}")

    with_debugger = function_body(text, "withDebugger", "evaluateWithDebugger")
    expect(
        "taskDebuggerStates.get" in with_debugger
        and "findTaskSessionForTab" in with_debugger
        and "withTaskDebugger" in with_debugger,
        f"{label} must reuse a debugger for task-owned tabs",
    )
    expect(
        "debuggerAttach" in with_debugger and "debuggerDetach" in with_debugger,
        f"{label} must preserve one-shot compatibility for unowned tabs",
    )

    wait_for_text = function_body(text, "waitForText", "getCurrentState")
    expect("pageContainsText" in wait_for_text, f"{label} waitForText must use a quiet page probe")
    expect("withDebugger" not in wait_for_text, f"{label} waitForText must not attach the debugger")

    text_probe = function_body(text, "pageContainsText", "waitForText")
    expect("try" in text_probe and "catch" in text_probe and "return false" in text_probe,
           f"{label} text probe must treat transient injection failures as not-ready")

    extract_text = function_body(text, "extractText", "getHTML")
    expect("chrome.scripting.executeScript" in extract_text, f"{label} extractText must use chrome.scripting")
    expect("withDebugger" not in extract_text, f"{label} extractText must not attach the debugger")

    get_html = function_body(text, "getHTML", "extractScopedText")
    expect("chrome.scripting.executeScript" in get_html, f"{label} getHTML must use chrome.scripting")
    expect("withDebugger" not in get_html, f"{label} getHTML must not attach the debugger")

    observe = function_body(text, "observeTab", "startMonitoring")
    expect(
        "options.compact" in observe
        and "withDebugger" in observe
        and "Accessibility.getFullAXTree" in observe,
        f"{label} compact and full observe must use Chrome's accessibility tree",
    )
    expect("observeTabWithoutDebugger" not in text,
           f"{label} must not keep the inaccurate hand-built accessibility fallback")

    close_session = function_body(text, "closeTaskSession", "tabOrigin")
    expect(
        "await detachTaskSessionDebuggers(sessionId)" in close_session,
        f"{label} closing a task session must detach its debugger leases",
    )
    if "await detachTaskSessionDebuggers(sessionId)" in close_session and "await chrome.tabs.remove(tabIds)" in close_session:
        expect(
            close_session.index("await detachTaskSessionDebuggers(sessionId)")
            < close_session.index("await chrome.tabs.remove(tabIds)"),
            f"{label} must detach task debuggers before closing tabs",
        )

    find_session = function_body(text, "findTaskSessionForTab", "detachTaskDebugger")
    expect(
        "tab.groupId === session.groupId" in find_session
        and "session === groupSession" in find_session,
        f"{label} must prefer current Chrome group ownership and remove stale ownership",
    )

    acquire = function_body(text, "acquireTaskDebugger", "withTaskDebugger")
    expect("phase" in acquire and "generation" in acquire and "busyCount" in acquire,
           f"{label} must serialize debugger attachment states and count active commands")
    detach = text.split("async function detachTaskDebugger", 1)[1].split("function scheduleTaskDebuggerDetach", 1)[0]
    expect("state.detachPromise" in detach and "state.phase = \"detaching\"" in detach,
           f"{label} must keep detaching state visible until Chrome completes the detach")

    monitoring = function_body(text, "startMonitoring", "stopMonitoring")
    expect(
        "findTaskSessionForTab" in monitoring and "acquireTaskDebugger" in monitoring,
        f"{label} monitoring must join a task-owned debugger connection",
    )
    expect("releaseTaskDebugger" in monitoring,
           f"{label} failed monitoring setup must release its persistent debugger holder")

    interception = function_body(text, "startInterception", "stopInterception")
    expect(
        "findTaskSessionForTab" in interception and "acquireTaskDebugger" in interception,
        f"{label} interception must join a task-owned debugger connection",
    )
    expect("releaseTaskDebugger" in interception,
           f"{label} failed interception setup must release its persistent debugger holder")

    debugger_detach = text.split("function debuggerDetach", 1)[1].split("async function withDebugger", 1)[0]
    expect("chrome.runtime.lastError" in debugger_detach and "reject" in debugger_detach,
           f"{label} debugger detach failures must be visible to the state machine")

    body_length = function_body(text, "readBodyLengthInTab", "handoffBodyLength")
    expect("try" in body_length and "catch" in body_length and "return -1" in body_length,
           f"{label} handoff body probe must tolerate transient injection failures")
    expect("startLen < 0" in text and "currentLen >= 0" in text,
           f"{label} handoff loop must not treat a failed body probe as user activity")


commands = (ROOT / "docs" / "commands.md").read_text(encoding="utf-8")
expect("Both compact and full snapshots use Chrome's real accessibility tree" in commands,
       "commands documentation must explain debugger-backed accessibility reads")
expect("Text extraction, HTML capture, and text waits" in commands and "do not attach the debugger" in commands,
       "commands documentation must identify genuinely quiet reads")
expect("task-owned tabs" in commands and "reuses one debugger connection" in commands,
       "commands documentation must explain task-scoped debugger reuse")

verification = (ROOT / "docs" / "verification.md").read_text(encoding="utf-8")
expect("verify_quiet_debugger_contract.py" in verification,
       "verification guide must run the quiet-debugger contract")
expect("verify_quiet_debugger_behavior.mjs" in verification,
       "verification guide must run the quiet-debugger behavioral races")

ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
expect("./verify_quiet_debugger_contract.py" in ci,
       "CI must run the quiet-debugger static contract")
expect("node verify_quiet_debugger_behavior.mjs" in ci,
       "CI must run the quiet-debugger behavioral races")

for manifest_path in (ROOT / "manifest.json", ROOT / "extension" / "manifest.json"):
    manifest = manifest_path.read_text(encoding="utf-8")
    expect('"minimum_chrome_version": "118"' in manifest,
           f"{manifest_path.name} must require the Chrome version that supports reliable MV3 timers")

if FAILURES:
    raise SystemExit(1)
print("Quiet debugger contract OK")
