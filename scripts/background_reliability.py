#!/usr/bin/env python3
"""Verify that creating a v2 task tab does not steal Chrome or application focus."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "packages" / "sdk-python"))

from agenttab import AgentTabClient, AgentTabError  # noqa: E402


def frontmost_app() -> str | None:
    if sys.platform != "darwin":
        return None
    try:
        asn = subprocess.check_output(["lsappinfo", "front"], text=True).strip()
        info = subprocess.check_output(
            ["lsappinfo", "info", "-only", "bundleID", asn], text=True
        ).strip()
        return info.split('="', 1)[1].rstrip('"')
    except (OSError, subprocess.SubprocessError, IndexError):
        return None


def chrome_tabs(chrome_app: str) -> dict[str, Any] | None:
    """Return Chrome window, tab, and active-tab IDs without reading page URLs."""
    if sys.platform != "darwin":
        raise RuntimeError("the background reliability focus probe currently requires macOS")
    application = json.dumps(chrome_app)
    script = f"""
function run() {{
const chrome = Application({application});
if (!chrome.running()) return JSON.stringify({{ windows: [] }});
return JSON.stringify({{
  windows: chrome.windows().map((window) => {{
    const active = window.activeTab();
    const activeId = active ? Number(active.id()) : null;
    return {{
      window_id: Number(window.id()),
      tabs: window.tabs().map((tab) => ({{
        tab_id: Number(tab.id()),
        active: Number(tab.id()) === activeId,
      }})),
    }};
  }}),
}});
}}
"""
    completed = subprocess.run(
        ["osascript", "-l", "JavaScript", "-e", script],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"cannot inspect Chrome tab IDs through macOS automation: {detail}")
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("macOS automation returned malformed Chrome tab inventory") from error
    if not isinstance(value, dict) or not isinstance(value.get("windows"), list):
        raise RuntimeError("macOS automation returned an invalid Chrome tab inventory")
    return value


def active_tabs(snapshot: dict[str, Any] | None) -> list[tuple[int, int]]:
    if snapshot is None:
        return []
    result: list[tuple[int, int]] = []
    for window in snapshot["windows"]:
        if not isinstance(window, dict) or not isinstance(window.get("tabs"), list):
            continue
        window_id = window.get("window_id")
        if not isinstance(window_id, int):
            continue
        for tab in window["tabs"]:
            if (
                isinstance(tab, dict)
                and isinstance(tab.get("tab_id"), int)
                and tab.get("active") is True
            ):
                result.append((window_id, tab["tab_id"]))
    return sorted(result)


def tab_ids(snapshot: dict[str, Any] | None) -> set[int]:
    if snapshot is None:
        return set()
    return {
        tab["tab_id"]
        for window in snapshot["windows"]
        if isinstance(window, dict) and isinstance(window.get("tabs"), list)
        for tab in window["tabs"]
        if isinstance(tab, dict) and isinstance(tab.get("tab_id"), int)
    }


def focus_violations(
    baseline: dict[str, Any] | None,
    current: dict[str, Any] | None,
    *,
    owned_tab_id: int,
    iteration: int,
) -> list[dict[str, Any]]:
    if baseline is None or current is None:
        return []
    violations: list[dict[str, Any]] = []
    baseline_active = dict(active_tabs(baseline))
    current_active = dict(active_tabs(current))
    changed = [
        {
            "windowId": window_id,
            "expectedTabId": tab_id,
            "actualTabId": current_active[window_id],
        }
        for window_id, tab_id in baseline_active.items()
        if window_id in current_active and current_active[window_id] != tab_id
    ]
    if changed:
        violations.append({
            "kind": "active_tabs_changed",
            "iteration": iteration,
            "windows": changed,
        })
    unexpected = sorted(tab_ids(current) - tab_ids(baseline) - {owned_tab_id})
    if unexpected:
        violations.append({
            "kind": "unexpected_tabs",
            "iteration": iteration,
            "tabIds": unexpected,
        })
    if owned_tab_id not in tab_ids(current):
        violations.append({
            "kind": "owned_tab_missing",
            "iteration": iteration,
            "tabId": owned_tab_id,
        })
    return violations


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration-seconds", type=float, default=60)
    parser.add_argument("--interval-seconds", type=float, default=2)
    parser.add_argument("--connect-timeout-seconds", type=float, default=10)
    parser.add_argument("--cleanup-timeout-seconds", type=float, default=5)
    parser.add_argument("--url", default="https://example.com")
    parser.add_argument(
        "--output",
        default="/tmp/agenttab-background-reliability.json",
    )
    parser.add_argument(
        "--chrome-app",
        default=os.environ.get("AGENTTAB_CHROME_APP", "Google Chrome"),
    )
    args = parser.parse_args()
    if args.duration_seconds < 0:
        parser.error("--duration-seconds must be non-negative")
    if args.interval_seconds <= 0:
        parser.error("--interval-seconds must be positive")
    if args.connect_timeout_seconds <= 0:
        parser.error("--connect-timeout-seconds must be positive")
    if args.cleanup_timeout_seconds < 0:
        parser.error("--cleanup-timeout-seconds must be non-negative")
    return args


def open_background_tab(
    url: str,
    timeout_seconds: float,
) -> tuple[AgentTabClient, dict[str, Any]]:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        client: AgentTabClient | None = None
        try:
            client = AgentTabClient.connect(connect_timeout=0.5, request_timeout=30)
            opened = client.call(
                "browser_open",
                {"mode": "create", "url": url, "background": True},
            )
            if not isinstance(opened, dict):
                raise RuntimeError("browser_open returned a non-object result")
            return client, opened
        except AgentTabError as error:
            if error.code != "runtime_not_ready" or error.outcome != "not_started":
                if client is not None:
                    client.close()
                raise
            last_error = error
        except (OSError, TimeoutError, ConnectionError) as error:
            last_error = error
        except Exception:
            if client is not None:
                client.close()
            raise
        if client is not None:
            client.close()
        time.sleep(0.25)
    raise RuntimeError(
        f"AgentTab did not become ready within {timeout_seconds:g} seconds: {last_error}"
    )


def main() -> int:
    args = parse_args()
    started = time.time()
    baseline: dict[str, Any] | None = None
    baseline_frontmost: str | None = None
    baseline_active: list[tuple[int, int]] = []
    violations: list[dict[str, Any]] = []
    samples: list[dict[str, Any]] = []
    run_error: str | None = None
    cleanup_error: str | None = None
    opened: dict[str, Any] | None = None
    client: AgentTabClient | None = None

    try:
        baseline = chrome_tabs(args.chrome_app)
        baseline_frontmost = frontmost_app()
        baseline_active = active_tabs(baseline)
        client, opened = open_background_tab(
            args.url,
            args.connect_timeout_seconds,
        )
        tab_id = opened.get("tab_id")
        window_id = opened.get("window_id")
        if not isinstance(tab_id, int) or not isinstance(window_id, int):
            raise RuntimeError("browser_open did not return integer tab_id and window_id")

        deadline = time.monotonic() + args.duration_seconds
        iteration = 0
        while True:
            current = chrome_tabs(args.chrome_app)
            current_frontmost = frontmost_app()
            violations.extend(
                focus_violations(
                    baseline,
                    current,
                    owned_tab_id=tab_id,
                    iteration=iteration,
                )
            )
            if baseline_frontmost and current_frontmost != baseline_frontmost:
                violations.append({
                    "kind": "frontmost_app_changed",
                    "iteration": iteration,
                    "expected": baseline_frontmost,
                    "actual": current_frontmost,
                })
            samples.append({
                "iteration": iteration,
                "elapsedSeconds": round(time.time() - started, 3),
                "activeTabs": active_tabs(current),
                "frontmostApp": current_frontmost,
                "ownedTabPresent": tab_id in tab_ids(current),
            })
            iteration += 1
            if time.monotonic() >= deadline:
                break
            time.sleep(args.interval_seconds)
    except Exception as error:  # The report must retain an actionable live-path failure.
        run_error = str(error)
    finally:
        if client is not None:
            # The task's initial resume capability is intentionally left unconfirmed.
            # Core RPC therefore closes the disposable task and its tabs on disconnect.
            client.close()

    if opened is not None and isinstance(opened.get("tab_id"), int):
        tab_id = opened["tab_id"]
        cleanup_deadline = time.monotonic() + args.cleanup_timeout_seconds
        try:
            while tab_id in tab_ids(chrome_tabs(args.chrome_app)):
                if time.monotonic() >= cleanup_deadline:
                    cleanup_error = f"disposable task tab {tab_id} remained after client disconnect"
                    break
                time.sleep(0.1)
        except Exception as error:
            cleanup_error = str(error)

    report = {
        "success": not violations and cleanup_error is None and run_error is None,
        "startedAt": started,
        "durationSeconds": round(time.time() - started, 3),
        "baselineActiveTabs": baseline_active,
        "baselineFrontmostApp": baseline_frontmost,
        "ownedTabId": opened.get("tab_id") if opened else None,
        "ownedWindowId": opened.get("window_id") if opened else None,
        "sampleCount": len(samples),
        "violations": violations,
        "cleanupError": cleanup_error,
        "runError": run_error,
        "samples": samples,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                key: report[key]
                for key in (
                    "success",
                    "durationSeconds",
                    "sampleCount",
                    "violations",
                    "runError",
                    "cleanupError",
                )
            },
            indent=2,
        )
    )
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
