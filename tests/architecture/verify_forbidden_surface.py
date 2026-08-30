#!/usr/bin/env python3
"""Reject obsolete runtime paths, symbols, and unsafe release members."""

from __future__ import annotations

import argparse
import fnmatch
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

OBSOLETE_PATHS = (
    "bridge.py",
    "broker.py",
    "bridge_wake.py",
    "host-rs/src/main.rs",
    "mcp/chrome_bridge_mcp",
    "setup.sh",
    "setup-rs.sh",
    "setup-broker.sh",
    "setup-edge.sh",
    "setup-windows.ps1",
    "uninstall-broker.sh",
    "scripts/quick_install.sh",
    "scripts/diagnose_install.py",
    "scripts/generate_browser_manifests.py",
    "adapters/browser_use",
)

PRIVATE_MEMBER_GLOBS = (
    "*token*",
    "*secret*",
    "*policy*.json",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.log",
    ".env*",
)

RUNTIME_ROOTS = (
    "packages",
    "host-rs/crates",
    "schemas",
    "scripts",
)

TEXT_SUFFIXES = {
    "",
    ".cjs",
    ".html",
    ".js",
    ".json",
    ".mjs",
    ".py",
    ".rs",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}

FORBIDDEN_TEXT = {
    "com.automation.bridge": {
        "config/migration-v1.json",
        "packages/installer/dist/cli.mjs",
    },
    "chrome_bridge_mcp": set(),
    "CHROME_BRIDGE": set(),
    "BRIDGE_EXTENSION_KEY": set(),
    "BRIDGE_CHROME_APP": set(),
    "browser_lease": set(),
    "bridge.py": set(),
    "broker.py": set(),
    "bridge_tokens": {
        "config/migration-v1.json",
        "packages/installer/dist/cli.mjs",
        "packages/installer/test/install.test.ts",
    },
    "bridge_policy": {
        "config/migration-v1.json",
        "packages/installer/dist/cli.mjs",
        "packages/installer/test/install.test.ts",
    },
}


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def source_files() -> list[Path]:
    files: list[Path] = []
    for item in RUNTIME_ROOTS:
        path = ROOT / item
        if path.is_file():
            files.append(path)
        elif path.is_dir():
            files.extend(
                candidate
                for candidate in path.rglob("*")
                if candidate.is_file()
                and "node_modules" not in candidate.parts
                and "target" not in candidate.parts
                and candidate.suffix in TEXT_SUFFIXES
            )
    return sorted(set(files))


def verify_repository() -> list[str]:
    failures = [f"obsolete path still exists: {item}" for item in OBSOLETE_PATHS if (ROOT / item).exists()]
    for path in source_files():
        name = relative(path)
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for needle, allowed in FORBIDDEN_TEXT.items():
            if needle in text and name not in allowed:
                failures.append(f"obsolete symbol {needle!r} in {name}")
    return failures


def private_member(name: str) -> bool:
    normalized = name.removeprefix("./")
    base = Path(normalized).name
    return any(
        fnmatch.fnmatch(normalized.lower(), pattern.lower())
        or fnmatch.fnmatch(base.lower(), pattern.lower())
        for pattern in PRIVATE_MEMBER_GLOBS
    )


def verify_member(name: str, payload: bytes | None) -> list[str]:
    normalized = name.removeprefix("./")
    base = Path(normalized).name
    failures: list[str] = []
    if private_member(normalized):
        failures.append(f"private or policy artifact in archive: {normalized}")
    if base in {"bridge.py", "broker.py", "bridge_wake.py", "bridge-host"}:
        failures.append(f"obsolete runtime member in archive: {normalized}")
    if "chrome_bridge_mcp" in normalized or "com.automation.bridge" in normalized:
        failures.append(f"obsolete runtime path in archive: {normalized}")
    if payload is None:
        return failures
    text = payload.decode("utf-8", errors="ignore")
    for needle in ("com.automation.bridge", "chrome_bridge_mcp", "CHROME_BRIDGE", "browser_lease"):
        if needle in text:
            failures.append(f"obsolete symbol {needle!r} in archive member {normalized}")
    return failures


def verify_archive(path: Path) -> list[str]:
    failures: list[str] = []
    try:
        if path.suffix in {".zip", ".whl"}:
            with zipfile.ZipFile(path) as archive:
                for info in archive.infolist():
                    if info.is_dir():
                        continue
                    payload = archive.read(info) if info.file_size <= 64 * 1024 * 1024 else None
                    failures.extend(verify_member(info.filename, payload))
        elif path.name.endswith((".tar.gz", ".tgz")):
            with tarfile.open(path, "r:gz") as archive:
                for member in archive.getmembers():
                    if not member.isfile():
                        continue
                    stream = archive.extractfile(member)
                    payload = stream.read() if stream is not None and member.size <= 64 * 1024 * 1024 else None
                    failures.extend(verify_member(member.name, payload))
        else:
            failures.extend(verify_member(path.name, path.read_bytes()))
    except (OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
        failures.append(f"cannot inspect archive {path}: {exc}")
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archives", nargs="*", type=Path)
    args = parser.parse_args(argv)

    failures = verify_repository()
    for archive in args.archives:
        failures.extend(verify_archive(archive))
    if failures:
        print("Forbidden AgentTab surface detected:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print("AgentTab source and archive surfaces contain no obsolete runtime artifacts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
