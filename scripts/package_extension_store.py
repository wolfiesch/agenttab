#!/usr/bin/env python3
"""Build a deterministic, store-ready AgentTab extension upload."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

EXTENSION_FILES = (
    "manifest.json",
    "background.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "wake.html",
    "wake.js",
    "icons/icon16.png",
    "icons/icon32.png",
    "icons/icon48.png",
    "icons/icon128.png",
)
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class PackagingError(Exception):
    """Raised before an invalid store package can be written."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Package the canonical AgentTab extension build for Chrome Web Store upload",
    )
    parser.add_argument(
        "--out",
        default="dist/agenttab-extension-store.zip",
        help="Output zip path",
    )
    parser.add_argument(
        "--source",
        default="packages/extension/dist",
        help="Canonical extension build directory",
    )
    parser.add_argument(
        "--check-js",
        action="store_true",
        help="Run node --check on packaged JavaScript",
    )
    return parser.parse_args(argv)


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def read_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as exc:
        raise PackagingError(f"cannot read {path}: {exc}") from exc


def source_members(source: Path) -> set[str]:
    return {
        path.relative_to(source).as_posix()
        for path in source.rglob("*")
        if path.is_file()
    }


def validate_manifest(manifest: dict[str, object], identity: dict[str, object]) -> None:
    if manifest.get("manifest_version") != 3:
        raise PackagingError("manifest_version must be 3")
    if "key" in manifest:
        raise PackagingError("store manifest must not contain an unpacked-extension key")
    if not identity.get("webStoreExtensionId"):
        raise PackagingError(
            "config/identity.json webStoreExtensionId is unset; create the dashboard item before packaging"
        )
    if manifest.get("name") != identity.get("product"):
        raise PackagingError("extension name does not match the frozen product identity")
    if manifest.get("version") != identity.get("chromeManifestVersion"):
        raise PackagingError("extension version does not match config/identity.json")
    if manifest.get("version_name") != identity.get("version"):
        raise PackagingError("extension version_name does not match config/identity.json")
    background = manifest.get("background")
    if not isinstance(background, dict) or background.get("service_worker") != "background.js":
        raise PackagingError("manifest background.service_worker must be background.js")
    permissions = manifest.get("permissions")
    if not isinstance(permissions, list) or "nativeMessaging" not in permissions:
        raise PackagingError("manifest permissions must include nativeMessaging")


def collect_members(source: Path, root: Path) -> dict[str, bytes]:
    expected = set(EXTENSION_FILES)
    actual = source_members(source)
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        details = []
        if missing:
            details.append("missing: " + ", ".join(missing))
        if unexpected:
            details.append("unexpected: " + ", ".join(unexpected))
        raise PackagingError("extension staging tree is not exhaustive (" + "; ".join(details) + ")")

    try:
        identity = json.loads(read_bytes(root / "config" / "identity.json"))
        manifest = json.loads(read_bytes(source / "manifest.json"))
    except json.JSONDecodeError as exc:
        raise PackagingError(f"invalid JSON: {exc}") from exc
    if not isinstance(identity, dict) or not isinstance(manifest, dict):
        raise PackagingError("identity and manifest documents must be JSON objects")
    validate_manifest(manifest, identity)

    background = read_bytes(source / "background.js").decode("utf-8", errors="replace")
    native_host = identity.get("nativeHost")
    if not isinstance(native_host, str) or native_host not in background:
        raise PackagingError("background.js does not reference the frozen AgentTab native host")

    return {name: read_bytes(source / name) for name in EXTENSION_FILES}


def check_javascript(source: Path) -> None:
    node = shutil.which("node")
    if node is None:
        raise PackagingError("--check-js requires node on PATH")
    for name in ("background.js", "popup.js", "wake.js"):
        result = subprocess.run(
            [node, "--check", str(source / name)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise PackagingError(f"node --check failed for {name}: {detail}")


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
    *,
    source: Path | None = None,
    root: Path | None = None,
    run_js_check: bool = False,
) -> dict[str, object]:
    root = (root or repo_root()).resolve()
    source = (source or root / "packages" / "extension" / "dist").resolve()
    members = collect_members(source, root)
    if run_js_check:
        check_javascript(source)
    write_zip(out_path, members)
    payload = read_bytes(out_path)
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
    try:
        metadata = build_store_package(
            Path(args.out),
            source=Path(args.source),
            run_js_check=args.check_js,
        )
    except PackagingError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(metadata, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
