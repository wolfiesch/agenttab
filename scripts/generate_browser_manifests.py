#!/usr/bin/env python3
"""Generate Edge and Firefox native-messaging artifacts from the canonical source.

Chrome is the supported runtime. This script only writes deterministic
browser-specific artifacts into an output directory (default `dist/browsers`):

- Edge (Chromium): a `com.automation.bridge.json` native-messaging manifest.
  Edge speaks the same `chrome-extension://` origin scheme and the same MV3
  service-worker model, so the canonical extension is used unchanged.
- Firefox: a `com.automation.bridge.json` native-messaging manifest using
  `allowed_extensions`, plus a staged extension directory whose manifest is the
  canonical manifest with only the Gecko-specific differences applied.

The Firefox staging output is a manifest/packaging artifact, not a supported
runtime. See `FIREFOX_LIMITATIONS` and docs/setup.md for what does not work.

Nothing is registered, no secret is read or written, and stdout is metadata only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import package_extension_store as store  # noqa: E402

NATIVE_HOST_NAME = store.NATIVE_HOST_NAME
HOST_DESCRIPTION = "Chrome Native Messaging Automation Bridge"
EXTENSION_FILES = store.EXTENSION_FILES
HOST_MANIFEST_NAME = f"{NATIVE_HOST_NAME}.json"

BROWSERS = ("edge", "firefox")

DEFAULT_FIREFOX_ADDON_ID = "chrome-bridge@wolfie.gg"
FIREFOX_MIN_VERSION = "115.0"

# Chrome-only permissions with no Firefox WebExtension equivalent. They are
# dropped from the staged Firefox manifest and reported in the metadata.
FIREFOX_UNSUPPORTED_PERMISSIONS = ("debugger", "tabGroups", "contentSettings")

FIREFOX_LIMITATIONS = (
    "Firefox has no chrome.debugger/CDP API, so every debugger-backed action is "
    "unavailable: background-safe screenshot, printToPDF, clickAt, screencast, "
    "executeScriptCDP, performance metrics, network/CPU throttling, and emulation.",
    "Firefox has no chrome.tabGroups, so task sessions cannot create named tab groups.",
    "Firefox has no chrome.contentSettings, so permission/content-setting control is unavailable.",
    "Firefox MV3 runs an event page (background.scripts), not a service worker; "
    "the keepalive and heartbeat paths in background.js are tuned for Chrome's worker lifecycle.",
    "The staged Firefox extension is generated for manifest review and packaging only. "
    "It is not exercised by any live gate in this repository and is not a supported runtime.",
)


class GenerationError(Exception):
    """Raised when inputs are unusable or an output would be unsafe to write."""


def repo_root() -> Path:
    return SCRIPTS_DIR.parent


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Edge/Firefox native-messaging manifests and a Firefox staging dir.",
    )
    parser.add_argument(
        "--browser",
        choices=(*BROWSERS, "all"),
        default="all",
        help="which browser artifacts to generate (default: all)",
    )
    parser.add_argument(
        "--host-path",
        required=True,
        help="absolute path to the native host executable or launcher",
    )
    parser.add_argument(
        "--extension-id",
        help="Chromium extension ID for the Edge manifest (32 chars, a-p)",
    )
    parser.add_argument(
        "--addon-id",
        default=DEFAULT_FIREFOX_ADDON_ID,
        help=f"Firefox add-on ID (default: {DEFAULT_FIREFOX_ADDON_ID})",
    )
    parser.add_argument(
        "--out-dir",
        default="dist/browsers",
        help="output directory for generated artifacts (default: dist/browsers)",
    )
    return parser.parse_args(argv)


def validate_extension_id(extension_id: str) -> str:
    value = (extension_id or "").strip()
    if len(value) != 32 or any(ch not in "abcdefghijklmnop" for ch in value):
        raise GenerationError(
            "extension id must be 32 characters in the range a-p; "
            "run ./setup.sh (or extension_identity.py id) to derive it"
        )
    return value


def validate_addon_id(addon_id: str) -> str:
    value = (addon_id or "").strip()
    ok_email_form = "@" in value and not value.startswith("@") and not value.endswith("@")
    ok_guid_form = value.startswith("{") and value.endswith("}") and len(value) > 2
    if not (ok_email_form or ok_guid_form):
        raise GenerationError(
            "firefox add-on id must be an email-style id (name@domain) or a {GUID}"
        )
    return value


def validate_host_path(host_path: str) -> str:
    value = (host_path or "").strip()
    if not value:
        raise GenerationError("host path is required")
    if not Path(value).is_absolute():
        raise GenerationError(f"host path must be absolute, got {value}")
    return value


def dumps(data: dict) -> str:
    """Deterministic JSON: sorted keys, fixed indent, trailing newline."""
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def build_edge_manifest(host_path: str, extension_id: str) -> dict:
    return {
        "name": NATIVE_HOST_NAME,
        "description": HOST_DESCRIPTION,
        "path": validate_host_path(host_path),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{validate_extension_id(extension_id)}/"],
    }


def build_firefox_host_manifest(host_path: str, addon_id: str) -> dict:
    return {
        "name": NATIVE_HOST_NAME,
        "description": HOST_DESCRIPTION,
        "path": validate_host_path(host_path),
        "type": "stdio",
        "allowed_extensions": [validate_addon_id(addon_id)],
    }


def build_firefox_extension_manifest(root_manifest: dict, addon_id: str) -> tuple[dict, list[str]]:
    """Apply only the Gecko differences to the canonical MV3 manifest."""
    if root_manifest.get("manifest_version") != 3:
        raise GenerationError("canonical manifest must be manifest_version 3")
    if "key" in root_manifest:
        raise GenerationError("canonical manifest must not carry a local extension key")

    manifest = json.loads(json.dumps(root_manifest))
    permissions = list(manifest.get("permissions", []))
    if "nativeMessaging" not in permissions:
        raise GenerationError("canonical manifest must request nativeMessaging")

    dropped = [name for name in permissions if name in FIREFOX_UNSUPPORTED_PERMISSIONS]
    manifest["permissions"] = [name for name in permissions if name not in dropped]

    # Firefox MV3 has no service worker; it runs an event page instead.
    manifest["background"] = {"scripts": ["background.js"]}
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": validate_addon_id(addon_id),
            "strict_min_version": FIREFOX_MIN_VERSION,
        }
    }
    return manifest, dropped


def file_metadata(path: Path) -> dict:
    payload = path.read_bytes()
    return {
        "path": path.as_posix(),
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def reject_forbidden(paths: list[Path], base: Path, label: str) -> None:
    names = [p.relative_to(base).as_posix() for p in paths]
    hits = store.forbidden_matches(names)
    if hits:
        raise GenerationError(f"{label} must not contain local artifacts: {sorted(hits)}")


def stage_firefox_extension(dest: Path, addon_id: str, root: Path) -> dict:
    root_manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    manifest, dropped = build_firefox_extension_manifest(root_manifest, addon_id)

    dest.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name in EXTENSION_FILES:
        target = dest / name
        if name == "manifest.json":
            target.write_text(dumps(manifest), encoding="utf-8")
        else:
            source = root / name
            if not source.is_file():
                raise GenerationError(f"missing canonical extension file: {name}")
            target.write_bytes(source.read_bytes())
        written.append(target)

    present = sorted(p.name for p in dest.iterdir())
    if present != sorted(EXTENSION_FILES):
        raise GenerationError(
            f"firefox staging dir must contain exactly {sorted(EXTENSION_FILES)}, got {present}"
        )
    reject_forbidden(written, dest, "firefox staging dir")

    return {
        "dir": dest.as_posix(),
        "addonId": addon_id,
        "droppedPermissions": sorted(dropped),
        "backgroundMode": "scripts",
        "files": [file_metadata(path) for path in sorted(written)],
    }


def generate(
    out_dir: Path,
    host_path: str,
    browser: str = "all",
    extension_id: str | None = None,
    addon_id: str = DEFAULT_FIREFOX_ADDON_ID,
    root: Path | None = None,
) -> dict:
    """Write the selected browser artifacts and return metadata only."""
    root = (root or repo_root()).resolve()
    targets = BROWSERS if browser == "all" else (browser,)
    out_dir = Path(out_dir)
    metadata: dict = {"outDir": out_dir.as_posix(), "hostName": NATIVE_HOST_NAME}

    if "edge" in targets:
        if not extension_id:
            raise GenerationError("--extension-id is required for the edge manifest")
        edge_dir = out_dir / "edge"
        edge_dir.mkdir(parents=True, exist_ok=True)
        edge_manifest = edge_dir / HOST_MANIFEST_NAME
        edge_manifest.write_text(dumps(build_edge_manifest(host_path, extension_id)), encoding="utf-8")
        metadata["edge"] = {
            "hostManifest": file_metadata(edge_manifest),
            "extensionId": validate_extension_id(extension_id),
            "extensionSource": "canonical (unchanged)",
        }

    if "firefox" in targets:
        firefox_dir = out_dir / "firefox"
        firefox_dir.mkdir(parents=True, exist_ok=True)
        firefox_manifest = firefox_dir / HOST_MANIFEST_NAME
        firefox_manifest.write_text(
            dumps(build_firefox_host_manifest(host_path, addon_id)), encoding="utf-8"
        )
        metadata["firefox"] = {
            "hostManifest": file_metadata(firefox_manifest),
            "extension": stage_firefox_extension(firefox_dir / "extension", addon_id, root),
            "supported": False,
            "limitations": list(FIREFOX_LIMITATIONS),
        }

    return metadata


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        metadata = generate(
            Path(args.out_dir),
            args.host_path,
            browser=args.browser,
            extension_id=args.extension_id,
            addon_id=args.addon_id,
        )
    except GenerationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(metadata, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
