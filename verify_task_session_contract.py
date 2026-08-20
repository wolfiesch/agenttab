#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
failures = []


def expect(condition, message):
    if not condition:
        failures.append(message)
        print(f"FAIL: {message}")


for path in (ROOT / "background.js", ROOT / "extension" / "background.js"):
    text = path.read_text(encoding="utf-8")
    for needle in (
        'case "createTaskSession"',
        'case "navigateTaskSession"',
        'case "getTaskSessions"',
        'case "updateTaskSessionState"',
        'case "closeTaskSession"',
        'TASK_SESSIONS_KEY',
        'chrome.storage.local',
        'chrome.tabs.onCreated.addListener',
        'tab?.openerTabId',
        'adoptTaskSessionChildTab',
        'chrome.tabs.onRemoved.addListener',
        'chrome.tabs.group',
        'active: active === true',
        'closedTabIds: tabIds',
        "error: 'activeDialog'",
        'includeActiveDialog',
        'settleMs',
        'openedTabs: adoptedTabs',
        "const anchor = el.closest?.('a[href]') || null;",
        "lookup.target === '_blank'",
        'openerTabId: tabId',
        'Input.dispatchMouseEvent',
        'tab.openerTabId === tabId',
    ):
        expect(needle in text, f"{path.name} missing task-session contract: {needle}")
    close_body = text.split("async function closeTaskSession", 1)[1].split("chrome.tabs.onRemoved", 1)[0]
    expect(
        "const tabIds = await mutateTaskSessions" in close_body
        and "delete sessions[sessionId]" in close_body
        and close_body.index("const tabIds = await mutateTaskSessions") < close_body.index("await chrome.tabs.remove(tabIds)"),
        f"{path.name} must persist session deletion before tab removal events fire",
    )
    navigate_body = text.split("async function navigateTaskSession", 1)[1].split("async function closeTaskSession", 1)[0]
    expect(
        "const reusedTabId = session.tabIds[0]" in navigate_body
        and "session.tabIds.filter((tabId) => tabId !== reusedTabId)" in navigate_body,
        f"{path.name} must replace a reused tab that closes during navigation",
    )
    expect(
        "try {\n      await chrome.tabs.remove(tabIds);" in close_body
        and "Could not remove every task-session tab" in close_body,
        f"{path.name} must tolerate tabs closing during session cleanup",
    )

adapter = (ROOT / "adapters" / "browser_use" / "chrome_bridge_session.py").read_text(encoding="utf-8")
expect(
    'if not line:\n            self.close()\n            raise ChromeBridgeError("Received empty response from bridge.")' in adapter,
    "browser-use adapter must close a dead socket immediately after EOF",
)

for path in (ROOT / "manifest.json", ROOT / "extension" / "manifest.json"):
    manifest = json.loads(path.read_text(encoding="utf-8"))
    expect("tabGroups" in manifest.get("permissions", []), f"{path} missing tabGroups permission")

bridge = (ROOT / "bridge.py").read_text(encoding="utf-8")
expect("'navigateTaskSession'" in bridge, "host missing navigateTaskSession policy classification")
expect("'closeTaskSession'" in bridge, "host missing closeTaskSession policy classification")
expect("'updateTaskSessionState'" in bridge, "host missing updateTaskSessionState policy classification")
mcp = (ROOT / "mcp" / "chrome_bridge_mcp" / "server.py").read_text(encoding="utf-8")
expect(
    'result["taskSession"] = call("getTaskSessions", {"sessionId": session_id})' in mcp,
    "MCP task-session open must return fresh post-navigation ownership",
)
expect("include_active_dialog" in mcp, "MCP snapshot missing active-dialog context option")
expect("settle_ms: int = 500" in mcp, "MCP click missing bounded side-effect settling")

harness = (ROOT / "scripts" / "background_reliability.py").read_text(encoding="utf-8")
for needle in ("active_tabs_changed", "frontmost_app_changed", "unexpected_tabs", "owned_tab_became_active", "owned_ready", "runError"):
    expect(needle in harness, f"reliability harness missing invariant {needle}")

if failures:
    raise SystemExit(1)
print("Task session contract OK")
