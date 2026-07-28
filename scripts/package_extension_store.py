#!/usr/bin/env python3
"""Build a store-ready Chrome extension upload zip.

This script only writes a local zip. It never uploads, never talks to the
Chrome Web Store API, and never creates, reads, or packages a private
extension key.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from fnmatch import fnmatch
from pathlib import Path

# Exactly the extension surface. Nothing else may enter the archive.
EXTENSION_FILES = ("manifest.json", "background.js", "wake.html", "wake.js")

# Native messaging host name convention for this repo.
NATIVE_HOST_NAME = "com.automation.bridge"

# Local artifacts that must never reach a store upload.
FORBIDDEN_GLOBS = (
    "bridge_token*",
    ".bridge_tokens*",
    "bridge_tokens*",
    "bridge_policy.json",
    "bridge_policy*.json",
    "bridge_secrets*",
    "extension_key.pem",
    "*.pem",
    "*.key",
    "*.log",
    "*.pyc",
    "__pycache__/*",
    "docs/*",
    "tests/*",
    "test_*",
    "verify_*",
    ".env*",
    "com.automation.bridge*.json",
)

# Deterministic archive timestamp (earliest value the zip format accepts).
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class PackagingError(Exception):
    """Raised when the extension surface fails a pre-write validation."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Package the extension surface into a Chrome Web Store upload zip",
    )
    parser.add_argument(
        "--out",
        default="dist/chrome-bridge-extension-store.zip",
        help="Output zip path (default: dist/chrome-bridge-extension-store.zip)",
    )
    parser.add_argument(
        "--source",
        default=None,
        help="Directory holding the extension surface files (default: repository root)",
    )
    parser.add_argument(
        "--check-js",
        action="store_true",
        help="Run 'node --check' on the packaged JavaScript; requires node on PATH",
    )
    return parser.parse_args(argv)


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def read_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as exc:
        raise PackagingError(f"cannot read {path.name}: {exc}") from exc


def validate_extension_copy_parity(root: Path) -> None:
    """Root files are canonical; the extension/ mirror must be byte-identical."""
    mirror = root / "extension"
    if not mirror.is_dir():
        return
    for name in ("background.js", "manifest.json"):
        copy = mirror / name
        if not copy.is_file():
            raise PackagingError(f"extension/{name} is missing while extension/ exists")
        if read_bytes(root / name) != read_bytes(copy):
            raise PackagingError(
                f"extension/{name} is not byte-identical to the canonical root {name}; "
                "re-sync the extension copy before packaging"
            )


def validate_manifest(manifest: dict, root_manifest: dict) -> None:
    if manifest.get("manifest_version") != 3:
        raise PackagingError(
            f"manifest_version must be 3, got {manifest.get('manifest_version')!r}"
        )
    if "key" in manifest:
        raise PackagingError(
            "manifest contains a 'key' field; store uploads must not carry a local extension key"
        )
    if not manifest.get("name"):
        raise PackagingError("manifest is missing 'name'")
    if not manifest.get("version"):
        raise PackagingError("manifest is missing 'version'")

    background = manifest.get("background") or {}
    if background.get("service_worker") != "background.js":
        raise PackagingError("manifest background.service_worker must be 'background.js'")

    permissions = set(manifest.get("permissions") or [])
    if "nativeMessaging" not in permissions:
        raise PackagingError("manifest permissions must include 'nativeMessaging'")
    missing = sorted(set(root_manifest.get("permissions") or []) - permissions)
    if missing:
        raise PackagingError(
            "manifest is missing permissions required by the canonical root manifest: "
            + ", ".join(missing)
        )


def validate_native_host_name(background_source: str) -> None:
    if NATIVE_HOST_NAME not in background_source:
        raise PackagingError(
            f"background.js does not reference the native messaging host {NATIVE_HOST_NAME!r}"
        )


def forbidden_matches(names: list[str]) -> list[str]:
    hits = []
    for name in names:
        posix = Path(name).as_posix()
        base = Path(name).name
        if any(fnmatch(posix, pattern) or fnmatch(base, pattern) for pattern in FORBIDDEN_GLOBS):
            hits.append(name)
    return hits


def check_js(paths: list[Path]) -> None:
    node = shutil.which("node")
    if node is None:
        raise PackagingError("--check-js requires node on PATH")
    for path in paths:
        result = subprocess.run(
            [node, "--check", str(path)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise PackagingError(f"node --check failed for {path.name}: {detail}")


def collect_members(source: Path, root: Path) -> dict[str, bytes]:
    """Return the exact archive payload, keyed by archive name."""
    missing = [name for name in EXTENSION_FILES if not (source / name).is_file()]
    if missing:
        raise PackagingError("missing extension file(s): " + ", ".join(missing))

    root_manifest = json.loads(read_bytes(root / "manifest.json").decode("utf-8"))
    try:
        manifest = json.loads(read_bytes(source / "manifest.json").decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise PackagingError(f"manifest.json is not valid JSON: {exc}") from exc
    manifest.pop("key", None)
    validate_manifest(manifest, root_manifest)

    background = read_bytes(source / "background.js")
    validate_native_host_name(background.decode("utf-8", errors="replace"))

    members = {
        "manifest.json": (json.dumps(manifest, indent=2) + "\n").encode("utf-8"),
        "background.js": background,
        "wake.html": read_bytes(source / "wake.html"),
        "wake.js": read_bytes(source / "wake.js"),
    }
    hits = forbidden_matches(sorted(members))
    if hits:
        raise PackagingError("forbidden artifact(s) in package: " + ", ".join(hits))
    return members


def write_zip(out_path: Path, members: dict[str, bytes]) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.create_system = 3
            archive.writestr(info, members[name])


def build_store_package(
    out_path: Path,
    source: Path | None = None,
    root: Path | None = None,
    run_js_check: bool = False,
) -> dict:
    """Write the store upload zip and return metadata only."""
    root = (root or repo_root()).resolve()
    source = (source or root).resolve()
    if source == root:
        validate_extension_copy_parity(root)
    members = collect_members(source, root)
    if run_js_check:
        check_js([source / "background.js", source / "wake.js"])
    write_zip(out_path, members)
    payload = out_path.read_bytes()
    return {
        "path": out_path.as_posix(),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "files": [
            {
                "name": name,
                "bytes": len(members[name]),
                "sha256": hashlib.sha256(members[name]).hexdigest(),
            }
            for name in sorted(members)
        ],
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    out_path = Path(args.out)
    source = Path(args.source) if args.source else None
    try:
        metadata = build_store_package(out_path, source=source, run_js_check=args.check_js)
    except PackagingError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(metadata, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
