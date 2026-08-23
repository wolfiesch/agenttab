#!/usr/bin/env python3
"""Prove the AgentTab reduced-permission manifest transformation.

PR1 is a decision gate. This probe never writes extension files, reloads Chrome,
or changes permission grants. The live lifecycle matrix belongs to the PR3
AgentTab extension candidate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ROOT_MANIFEST = ROOT / "manifest.json"
MIRROR_MANIFEST = ROOT / "extension" / "manifest.json"
REQUIRED_PERMISSIONS = (
    "nativeMessaging",
    "tabs",
    "tabGroups",
    "storage",
    "alarms",
    "downloads",
)
OPTIONAL_PERMISSIONS = ("scripting", "debugger")
REMOVED_PERMISSIONS = (
    "activeTab",
    "bookmarks",
    "contentSettings",
    "cookies",
    "history",
)
HOST_PERMISSIONS = ("<all_urls>",)


class GateFailure(RuntimeError):
    pass


def manifest_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise GateFailure(f"cannot read {path.relative_to(ROOT)}: {error}") from error


def parse_manifest(path: Path, payload: bytes) -> dict:
    try:
        value = json.loads(payload)
    except json.JSONDecodeError as error:
        raise GateFailure(f"invalid JSON in {path.relative_to(ROOT)}: {error}") from error
    if not isinstance(value, dict):
        raise GateFailure(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def string_set(manifest: dict, key: str) -> set[str]:
    value = manifest.get(key, [])
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise GateFailure(f"manifest {key} must be an array of strings")
    return set(value)


def reduced_manifest(source: dict) -> dict:
    staged = json.loads(json.dumps(source))
    staged["permissions"] = list(REQUIRED_PERMISSIONS)
    staged["optional_permissions"] = list(OPTIONAL_PERMISSIONS)
    staged["host_permissions"] = list(HOST_PERMISSIONS)
    return staged


def canonical_bytes(value: dict) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def verify() -> dict:
    root_bytes = manifest_bytes(ROOT_MANIFEST)
    mirror_bytes = manifest_bytes(MIRROR_MANIFEST)
    if root_bytes != mirror_bytes:
        raise GateFailure("manifest.json and extension/manifest.json differ")

    source = parse_manifest(ROOT_MANIFEST, root_bytes)
    if source.get("manifest_version") != 3:
        raise GateFailure("permission gate requires a Manifest V3 source")

    source_grants = string_set(source, "permissions") | string_set(source, "optional_permissions")
    expected_grants = set(REQUIRED_PERMISSIONS) | set(OPTIONAL_PERMISSIONS)
    missing = sorted(expected_grants - source_grants)
    if missing:
        raise GateFailure(f"source manifest cannot produce target; missing grants: {missing}")
    if not set(HOST_PERMISSIONS).issubset(string_set(source, "host_permissions")):
        raise GateFailure("source manifest cannot produce target; <all_urls> is missing")

    staged = reduced_manifest(source)
    required = string_set(staged, "permissions")
    optional = string_set(staged, "optional_permissions")
    host = string_set(staged, "host_permissions")
    if required != set(REQUIRED_PERMISSIONS):
        raise GateFailure("staged required permissions differ from the ADR target")
    if optional != set(OPTIONAL_PERMISSIONS):
        raise GateFailure("staged optional permissions differ from the ADR target")
    if host != set(HOST_PERMISSIONS):
        raise GateFailure("staged host permissions differ from the ADR target")
    forbidden = sorted((required | optional) & set(REMOVED_PERMISSIONS))
    if forbidden:
        raise GateFailure(f"staged manifest retains forbidden permissions: {forbidden}")

    staged_bytes = canonical_bytes(staged)
    if staged_bytes != canonical_bytes(reduced_manifest(source)):
        raise GateFailure("reduced manifest transformation is not deterministic")

    return {
        "schema_version": 1,
        "decision_gate": True,
        "installed_extension_modified": False,
        "permissions": list(REQUIRED_PERMISSIONS),
        "optional_permissions": list(OPTIONAL_PERMISSIONS),
        "host_permissions": list(HOST_PERMISSIONS),
        "removed_permissions": list(REMOVED_PERMISSIONS),
        "active_tab_retained": False,
        "source_manifest_sha256": hashlib.sha256(root_bytes).hexdigest(),
        "staged_manifest_sha256": hashlib.sha256(staged_bytes).hexdigest(),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="write the scrubbed JSON report")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = verify()
    except GateFailure as error:
        print(json.dumps({"schema_version": 1, "error": str(error)}, indent=2, sort_keys=True))
        return 1

    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(payload, encoding="utf-8")
    print(payload, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
