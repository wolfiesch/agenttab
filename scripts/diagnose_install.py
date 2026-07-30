#!/usr/bin/env python3
"""Report bridge installation drift and live connection state without waking Chrome."""

from __future__ import annotations

import hashlib
import json
import re
import os
import socket
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
STATE = Path(os.environ.get(
    "BRIDGE_STATE_DIR",
    "~/Library/Application Support/chrome-native-bridge",
)).expanduser()


def digest(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def listening(port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.2)
    try:
        return sock.connect_ex(("127.0.0.1", port)) == 0
    finally:
        sock.close()


def manifest_version(path: Path) -> str | None:
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError):
        return None


def native_manifest() -> Path:
    return Path(
        os.environ.get(
            "BRIDGE_NATIVE_MANIFEST",
            "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.automation.bridge.json",
        )
    ).expanduser()


def registered_launcher() -> Path | None:
    try:
        return Path(json.loads(native_manifest().read_text(encoding="utf-8"))["path"])
    except (OSError, KeyError, ValueError):
        return None


def launcher_target(launcher: Path | None) -> Path | None:
    if launcher is None:
        return None
    try:
        text = launcher.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return launcher
    match = re.search(r'^exec\s+(?:"([^"]+)"|([^\s]+))', text, re.MULTILINE)
    return Path(match.group(1) or match.group(2)) if match else launcher


def is_within(path: Path | None, root: Path) -> bool:
    if path is None:
        return False
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def last_successful_response(log_path: Path) -> str | None:
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if "Routed response for request ID" in line:
            return line.split(" - ", 1)[0]
    return None


def effective_native_host() -> Path:
    return launcher_target(registered_launcher()) or STATE / "bridge.py"


def main() -> int:
    repo_background = digest(REPO / "extension" / "background.js")
    deployed_background = digest(STATE / "extension" / "background.js")
    repo_host = digest(REPO / "bridge.py")
    manifest = native_manifest()
    launcher = registered_launcher()
    native_host = effective_native_host()
    deployed_host = digest(native_host)
    launcher_exists = bool(launcher and launcher.is_file())
    launcher_executable = bool(launcher_exists and os.access(launcher, os.X_OK))
    native_host_exists = native_host.is_file()
    native_host_executable = bool(native_host_exists and os.access(native_host, os.X_OK))
    checkout_coupled = is_within(native_host, REPO)
    report = {
        "repository": str(REPO),
        "stateDir": str(STATE),
        "registration": {
            "manifest": str(manifest),
            "manifestExists": manifest.is_file(),
            "launcher": str(launcher) if launcher else None,
            "launcherExists": launcher_exists,
            "launcherExecutable": launcher_executable,
        },
        "effectiveNativeHost": str(native_host),
        "nativeHostExists": native_host_exists,
        "nativeHostExecutable": native_host_executable,
        "checkoutCoupled": checkout_coupled,
        "lastSuccessfulResponse": last_successful_response(STATE / "bridge_debug.log"),
        "versions": {
            "repository": manifest_version(REPO / "manifest.json"),
            "deployed": manifest_version(STATE / "extension" / "manifest.json"),
        },
        "filesCurrent": {
            "extension": bool(repo_background and repo_background == deployed_background),
            "nativeHost": bool(repo_host and repo_host == deployed_host),
        },
        "connections": {
            "broker9223": listening(int(os.environ.get("BRIDGE_BROKER_PORT", "9223"))),
            "nativeBackend19223": listening(int(os.environ.get("BRIDGE_BACKEND_PORT", "19223"))),
        },
    }
    problems = []
    if not report["registration"]["manifestExists"]:
        problems.append("native messaging manifest is missing")
    if not launcher_exists:
        problems.append("native host launcher is missing")
    elif not launcher_executable:
        problems.append("native host launcher is not executable")
    if not native_host_exists:
        problems.append("native host runtime is missing")
    elif not native_host_executable:
        problems.append("native host runtime is not executable")
    if checkout_coupled:
        problems.append("native host runtime points into the current checkout")
    if not report["filesCurrent"]["extension"]:
        problems.append("deployed extension differs from repository")
    if native_host_exists and not report["filesCurrent"]["nativeHost"]:
        problems.append("deployed native host differs from repository")
    if report["connections"]["broker9223"] and not report["connections"]["nativeBackend19223"]:
        problems.append("broker is running but Chrome native backend is disconnected")
    report["problems"] = problems
    print(json.dumps(report, indent=2))
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
