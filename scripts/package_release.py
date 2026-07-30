#!/usr/bin/env python3
"""Build release artifacts for chrome-native-bridge."""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
import zipfile
from fnmatch import fnmatch
from pathlib import Path

RUST_BUILD_ERROR = "ERROR: Rust release binary not found; run cargo build --release --manifest-path host-rs/Cargo.toml"

EXCLUDED_NAMES = {
    ".git",
    "__pycache__",
    ".DS_Store",
    "bridge_token.txt",
    "bridge_tokens.txt",
    "bridge_tokens.txt.lock",
    "extension_key.pem",
    "com.automation.bridge.json",
    "com.automation.bridge.rust.json",
    "bridge-host-launch.sh",
    "bridge-host-python-launch.sh",
    "bridge_policy.json",
}

EXCLUDED_SUFFIXES = {
    ".pyc",
    ".log",
    ".pem",
    ".key",
}

EXCLUDED_GLOBS = {
    ".bridge_tokens.*",
    ".env",
    ".env.*",
    "bridge_policy*.json",
    "bridge_policy*.json.*",
    "bridge_token_*.txt",
    "com.automation.bridge*.json",
    "mcp/uv.lock",
    "*.log",
    "*.pyc",
    "*.pem",
    "*.key",
    "*.secret",
    "*.secrets",
    "*.token",
    "*.tokens",
    "*.policy",
}

# Public templates that must ship even though a secret-shaped EXCLUDED_GLOBS
# pattern matches their name. `bridge_policy*.json` deliberately sweeps every
# local policy document, which would otherwise drop the tracked bundle example.
ALWAYS_INCLUDE_PATHS = {
    "bridge_policy.example.json",
    "bridge_policy_bundle.example.json",
    "bridge_policy_bundle.lock.example",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Package chrome-native-bridge release artifacts")
    parser.add_argument("--version", required=True, help="Release version string used in artifact names")
    parser.add_argument("--dist", required=True, help="Directory for generated artifacts")
    return parser.parse_args()


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True



def should_exclude(path: Path, repo_root: Path, dist_dir: Path) -> bool:
    relative = path.relative_to(repo_root)
    parts = relative.parts

    if is_relative_to(path, dist_dir):
        return True
    if ".git" in parts or "__pycache__" in parts:
        return True
    if len(parts) >= 2 and parts[0] == "host-rs" and parts[1] == "target":
        return True
    if relative.as_posix() in ALWAYS_INCLUDE_PATHS:
        return False
    if any(part in EXCLUDED_NAMES for part in parts):
        return True
    if path.suffix in EXCLUDED_SUFFIXES:
        return True
    if any(fnmatch(relative.as_posix(), pattern) or fnmatch(path.name, pattern) for pattern in EXCLUDED_GLOBS):
        return True
    return False


def tracked_source_paths(repo_root: Path) -> list[Path]:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files", "-z"],
            check=True,
            capture_output=True,
        )
    except FileNotFoundError as exc:
        print("ERROR: source packaging requires git; install git or run from a checkout.", file=sys.stderr)
        raise SystemExit(2) from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", errors="replace").strip() if exc.stderr else ""
        message = "ERROR: source packaging requires a git checkout; run from the repository root."
        if detail:
            message = f"{message} git said: {detail}"
        print(message, file=sys.stderr)
        raise SystemExit(2) from exc
    tracked = [
        repo_root / raw.decode("utf-8")
        for raw in result.stdout.split(b"\0")
        if raw
    ]
    public_untracked = [
        repo_root / relative
        for relative in sorted(ALWAYS_INCLUDE_PATHS)
        if (repo_root / relative).is_file()
    ]
    return sorted({*tracked, *public_untracked}, key=lambda path: path.relative_to(repo_root).as_posix())


def add_source_zip(repo_root: Path, dist_dir: Path, version: str) -> Path:
    source_zip = dist_dir / f"chrome-native-bridge-source-{version}.zip"
    with zipfile.ZipFile(source_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in tracked_source_paths(repo_root):
            if should_exclude(path, repo_root, dist_dir):
                continue
            archive.write(path, path.relative_to(repo_root).as_posix())
    return source_zip


def add_extension_zip(repo_root: Path, dist_dir: Path, version: str) -> Path:
    extension_zip = dist_dir / f"chrome-native-bridge-extension-unpacked-{version}.zip"
    manifest = json.loads((repo_root / "manifest.json").read_text(encoding="utf-8"))
    manifest.pop("key", None)
    with zipfile.ZipFile(extension_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(repo_root / "background.js", "background.js")
        archive.writestr("manifest.json", json.dumps(manifest, indent=2, sort_keys=False) + "\n")
        archive.write(repo_root / "wake.html", "wake.html")
        archive.write(repo_root / "wake.js", "wake.js")
        archive.write(repo_root / "popup.html", "popup.html")
        archive.write(repo_root / "popup.css", "popup.css")
        archive.write(repo_root / "popup.js", "popup.js")
        for relative in (
            "icons/icon-16.png",
            "icons/icon-32.png",
            "icons/icon-48.png",
            "icons/icon-128.png",
        ):
            archive.write(repo_root / relative, relative)
    return extension_zip


def cargo_target_dir(repo_root: Path) -> Path | None:
    try:
        result = subprocess.run(
            [
                "cargo",
                "metadata",
                "--format-version",
                "1",
                "--no-deps",
                "--manifest-path",
                str(repo_root / "host-rs" / "Cargo.toml"),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(json.loads(result.stdout)["target_directory"])
    except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError, KeyError):
        return None


def rust_binary_path(repo_root: Path) -> Path:
    target_dir = cargo_target_dir(repo_root)
    if target_dir is None:
        target_dir = repo_root / "host-rs" / "target"
    binary_name = "bridge-host.exe" if platform.system() == "Windows" else "bridge-host"
    return target_dir / "release" / binary_name


def runner_os_name() -> str:
    system = platform.system()
    if system == "Darwin":
        return "macOS"
    if system == "Windows":
        return "Windows"
    return "Linux"


def copy_rust_binary(repo_root: Path, dist_dir: Path, version: str) -> Path:
    rust_bin = rust_binary_path(repo_root)
    if not rust_bin.is_file():
        print(RUST_BUILD_ERROR, file=sys.stderr)
        raise SystemExit(2)
    output = dist_dir / f"bridge-host-{runner_os_name()}-{version}"
    shutil.copy2(rust_bin, output)
    output.chmod(output.stat().st_mode | 0o755)
    return output


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    dist_dir = Path(args.dist).expanduser().resolve()
    dist_dir.mkdir(parents=True, exist_ok=True)

    add_source_zip(repo_root, dist_dir, args.version)
    add_extension_zip(repo_root, dist_dir, args.version)
    copy_rust_binary(repo_root, dist_dir, args.version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
