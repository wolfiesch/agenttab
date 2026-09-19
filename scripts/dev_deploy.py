#!/usr/bin/env python3
"""One-command development deploy workflow for AgentTab.

Orchestrates build -> safe local deploy -> reload -> readiness check,
with exact bundle/path verification, safe backups, atomic staging swap,
automatic rollback, and separate development receipts that preserve
signed install receipt truth.
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import sys
import time
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable

REQUIRED_EXTENSION_FILES: tuple[str, ...] = (
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

REQUIRED_PERMISSIONS: tuple[str, ...] = (
    "alarms",
    "debugger",
    "nativeMessaging",
    "storage",
    "tabGroups",
    "tabs",
)

OPTIONAL_PERMISSIONS: tuple[str, ...] = ("scripting",)
HOST_PERMISSIONS: tuple[str, ...] = ("<all_urls>",)

FORBIDDEN_MANIFEST_KEYS: tuple[str, ...] = (
    "content_scripts",
    "web_accessible_resources",
    "externally_connectable",
    "side_panel",
    "commands",
)

VERSION_REGEX = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
DEFAULT_READINESS_TIMEOUT = 90.0


class DeployError(Exception):
    """Raised when any step of development deployment fails."""


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def validate_timeout(timeout: float) -> float:
    if not isinstance(timeout, (int, float)) or math.isnan(timeout) or math.isinf(timeout) or timeout <= 0:
        raise DeployError(f"Timeout must be a finite positive number: {timeout}")
    return float(timeout)


def clean_version(version_str: str) -> str:
    cleaned = version_str.lstrip("v")
    if not VERSION_REGEX.match(cleaned):
        raise DeployError(f"Invalid version format: '{version_str}'. Must be semantic version without path traversal.")
    return cleaned


def get_git_metadata(root: Path) -> dict[str, Any]:
    metadata: dict[str, Any] = {"commit": None, "dirty": None}
    try:
        proc = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(root), capture_output=True, text=True, timeout=5.0)
        if proc.returncode == 0 and proc.stdout.strip():
            metadata["commit"] = proc.stdout.strip()
        status = subprocess.run(["git", "status", "--porcelain"], cwd=str(root), capture_output=True, text=True, timeout=5.0)
        if status.returncode == 0:
            metadata["dirty"] = bool(status.stdout.strip())
    except Exception:
        pass
    return metadata


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as f:
        while chunk := f.read(65536):
            digest.update(chunk)
    return digest.hexdigest()


def compute_bundle_digest(files: list[dict[str, Any]]) -> str:
    bundle_hash = sha256()
    for entry in sorted(files, key=lambda item: item["path"]):
        bundle_hash.update(entry["path"].encode("utf-8"))
        bundle_hash.update(entry["sha256"].encode("utf-8"))
    return bundle_hash.hexdigest()


def load_identity(root: Path) -> tuple[str, str, str, str]:
    identity_path = root / "config" / "identity.json"
    if not identity_path.is_file():
        raise DeployError(f"Required identity configuration missing at {identity_path}")
    try:
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        expected_key = identity["developmentExtension"]["publicKey"]
        expected_id = identity["developmentExtension"]["id"]
        expected_manifest_version = identity["chromeManifestVersion"]
        expected_version = identity["version"]
        return expected_key, expected_id, expected_manifest_version, expected_version
    except Exception as exc:
        raise DeployError(f"Failed to load required identity configuration: {exc}") from exc


def resolve_target_dir(
    target_dir: str | Path | None,
    state_dir: str | Path | None = None,
    version: str | None = None,
) -> Path:
    if target_dir is not None:
        return Path(target_dir)

    resolved_state_dir = (
        Path(state_dir).expanduser().resolve()
        if state_dir
        else Path(os.environ.get("AGENTTAB_STATE_DIR", Path.home() / ".agenttab")).expanduser().resolve()
    )
    versions_dir = resolved_state_dir / "versions"

    if version:
        return versions_dir / f"v{clean_version(version)}" / "extension"

    if not versions_dir.is_dir():
        raise DeployError(f"No versions directory found at {versions_dir}. Specify --target-dir or --version.")

    version_dirs = sorted([d for d in versions_dir.iterdir() if d.is_dir()])
    if len(version_dirs) == 0:
        raise DeployError(f"No version directories found in {versions_dir}. Specify --target-dir or --version.")
    if len(version_dirs) > 1:
        names = [d.name for d in version_dirs]
        raise DeployError(f"Ambiguous target: multiple versions found in {versions_dir}: {names}. Specify --version or --target-dir.")

    return version_dirs[0] / "extension"


def validate_target(target: Path, root: Path, source_dir: Path, expected_key: str) -> Path:
    # 1. Reject symlinks before resolve
    if target.is_symlink():
        raise DeployError(f"Target path cannot be a symbolic link: {target}")

    cur = target
    while cur != cur.parent:
        if cur in (Path("/var"), Path("/tmp"), Path("/etc")):
            cur = cur.parent
            continue
        if cur.is_symlink():
            raise DeployError(f"Target path cannot contain a symbolic link component: {cur}")
        cur = cur.parent

    # 2. Check overlap and sensitive paths
    res_target = target.resolve()
    res_root = root.resolve()
    res_source = source_dir.resolve()
    forbidden = {
        Path("/").resolve(), Path.home().resolve(), Path("/home").resolve(),
        Path("/Users").resolve(), Path("/tmp").resolve(), Path("/var").resolve(),
    }
    if res_target in forbidden:
        raise DeployError(f"Target cannot be a sensitive system or home directory: {res_target}")

    if res_target == res_root or res_root in res_target.parents or res_target in res_root.parents:
        raise DeployError(f"Target cannot overlap with or be an ancestor of repository root: {res_target}")

    if res_target == res_source or res_source in res_target.parents or res_target in res_source.parents:
        raise DeployError(f"Target cannot overlap with or be an ancestor of source directory: {res_target}")

    # 3. Require explicit existing AgentTab extension target validated by manifest key
    if not res_target.is_dir():
        raise DeployError(f"Target must be an existing directory: {res_target}")

    manifest_file = res_target / "manifest.json"
    if not manifest_file.is_file():
        raise DeployError(f"Target must be an existing AgentTab extension containing manifest.json: {res_target}")

    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except Exception as exc:
        raise DeployError(f"Target manifest.json is invalid JSON: {exc}") from exc

    if not isinstance(manifest, dict) or manifest.get("key") != expected_key:
        raise DeployError(f"Target manifest.key does not match AgentTab development extension key: {res_target}")

    # 4. Reject any symbolic link contents inside target directory
    for dirpath, dirnames, filenames in os.walk(res_target):
        dp = Path(dirpath)
        if dp.is_symlink():
            raise DeployError(f"Target contains symbolic link directory: {dp}")
        for d in dirnames:
            if (dp / d).is_symlink():
                raise DeployError(f"Target contains symbolic link subdirectory: {dp / d}")
        for f in filenames:
            if (dp / f).is_symlink():
                raise DeployError(f"Target contains symbolic link file: {dp / f}")

    return res_target


def validate_sibling_paths(version_root: Path) -> None:
    """Validate all writable sibling paths in the version directory using no-follow semantics."""
    if version_root.is_symlink():
        raise DeployError(f"Version root directory cannot be a symbolic link: {version_root}")

    # 1. Reject receipt path if it is a symbolic link (whether valid or dangling)
    receipt_path = version_root / "dev-deploy-receipt.json"
    if receipt_path.is_symlink():
        raise DeployError(f"Receipt path cannot be a symbolic link: {receipt_path}")

    # 2. Reject backups directory if it is a symbolic link
    backup_root = version_root / "backups"
    if backup_root.is_symlink():
        raise DeployError(f"Backups directory cannot be a symbolic link: {backup_root}")
    if backup_root.exists() and not backup_root.is_dir():
        raise DeployError(f"Backups path must be a directory: {backup_root}")

    # 3. Reject writable temporary staging and swap paths if they are symbolic links
    if version_root.is_dir():
        for item in version_root.iterdir():
            if item.name.startswith((".tmp_deploy_", ".old_deploy_", ".tmp_receipt_")) and item.is_symlink():
                raise DeployError(f"Temporary deployment path cannot be a symbolic link: {item}")


def write_receipt_atomic(receipt_path: Path, content: str) -> None:
    """Atomically write receipt content without following symbolic links."""
    if receipt_path.is_symlink():
        raise DeployError(f"Receipt path cannot be a symbolic link: {receipt_path}")
    version_root = receipt_path.parent
    if version_root.is_symlink():
        raise DeployError(f"Receipt parent directory cannot be a symbolic link: {version_root}")

    fd, tmp_path_str = tempfile.mkstemp(prefix=".tmp_receipt_", dir=str(version_root))
    tmp_path = Path(tmp_path_str)
    try:
        with open(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(fd)

        if receipt_path.is_symlink():
            raise DeployError(f"Receipt path cannot be a symbolic link: {receipt_path}")

        os.replace(tmp_path_str, str(receipt_path))
    finally:
        if tmp_path.is_symlink() or tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass

def check_platform_reload_support(args: argparse.Namespace, root: Path | None = None) -> None:
    """Validate platform reload support before mutating system or swapping files."""
    if sys.platform != "darwin":
        has_debugging_url = bool(getattr(args, "debugging_url", None) and str(args.debugging_url).strip())
        has_reload_command = bool(getattr(args, "reload_command", None) and str(args.reload_command).strip())
        has_custom_reload_script = False
        reload_script = getattr(args, "reload_script", None)
        if reload_script:
            default_script = ((root or repo_root()) / "scripts" / "reload_unpacked_extension.sh").resolve()
            has_custom_reload_script = Path(reload_script).resolve() != default_script

        if not (has_debugging_url or has_reload_command or has_custom_reload_script):
            raise DeployError(
                f"Default extension reload via macOS 'open' is unsupported on platform '{sys.platform}'. "
                "Specify an explicit --debugging-url (e.g. http://127.0.0.1:9222) or --reload-command to deploy on this platform."
            )


def verify_bundle(
    source_dir: Path,
    expected_key: str,
    expected_manifest_version: str,
    expected_version: str,
) -> tuple[list[dict[str, Any]], str]:
    if not source_dir.is_dir():
        raise DeployError(f"Source bundle directory does not exist: {source_dir}")

    # Check for symlinks on any dir or file
    for dirpath, dirnames, filenames in os.walk(source_dir):
        dp = Path(dirpath)
        if dp.is_symlink():
            raise DeployError(f"Bundle directory cannot be a symbolic link: {dp}")
        for d in dirnames:
            if (dp / d).is_symlink():
                raise DeployError(f"Bundle contains symbolic link subdirectory: {dp / d}")
        for f in filenames:
            if (dp / f).is_symlink():
                raise DeployError(f"Bundle file cannot be a symbolic link: {dp / f}")

    # Check required files
    for rel_name in REQUIRED_EXTENSION_FILES:
        expected_file = source_dir / rel_name
        if not expected_file.is_file():
            raise DeployError(f"Bundle missing required file: {rel_name}")

    manifest_path = source_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise DeployError(f"Bundle manifest.json is invalid JSON: {exc}") from exc

    if not isinstance(manifest, dict):
        raise DeployError("Bundle manifest.json must be a JSON object")

    # Strict manifest verification
    if manifest.get("key") != expected_key:
        raise DeployError("Bundle manifest.key missing or does not match developmentExtension.publicKey")

    if manifest.get("version") != expected_manifest_version or manifest.get("version_name") != expected_version:
        raise DeployError(
            f"Bundle manifest versions must match identity ({expected_manifest_version} / {expected_version}), "
            f"got ({manifest.get('version')} / {manifest.get('version_name')})"
        )

    for forbidden in FORBIDDEN_MANIFEST_KEYS:
        if forbidden in manifest:
            raise DeployError(f"Forbidden manifest surface detected: {forbidden}")

    manifest_permissions = manifest.get("permissions")
    if not isinstance(manifest_permissions, list) or sorted(manifest_permissions) != sorted(REQUIRED_PERMISSIONS):
        raise DeployError(f"Bundle manifest permissions must exactly match required set: {sorted(REQUIRED_PERMISSIONS)}")

    if manifest.get("optional_permissions") != list(OPTIONAL_PERMISSIONS):
        raise DeployError(f"Bundle manifest optional_permissions must be {list(OPTIONAL_PERMISSIONS)}")

    if manifest.get("host_permissions") != list(HOST_PERMISSIONS):
        raise DeployError(f"Bundle manifest host_permissions must be {list(HOST_PERMISSIONS)}")

    file_entries: list[dict[str, Any]] = []
    for dirpath, _, filenames in os.walk(source_dir):
        for f in sorted(filenames):
            fp = Path(dirpath) / f
            file_entries.append({
                "path": fp.relative_to(source_dir).as_posix(),
                "sha256": file_sha256(fp),
                "bytes": fp.stat().st_size,
            })
    file_entries.sort(key=lambda item: item["path"])

    bundle_digest = compute_bundle_digest(file_entries)
    return file_entries, bundle_digest


def verify_installed_bytes(source_dir: Path, target_dir: Path, expected_files: list[dict[str, Any]]) -> None:
    expected_paths = {item["path"] for item in expected_files}
    for item in expected_files:
        target_file = target_dir / item["path"]
        if not target_file.is_file():
            raise DeployError(f"Installed verification failed: missing file {item['path']}")
        if target_file.stat().st_size != item["bytes"]:
            raise DeployError(f"Installed verification failed: byte count mismatch for {item['path']}")
        if file_sha256(target_file) != item["sha256"]:
            raise DeployError(f"Installed verification failed: SHA256 mismatch for {item['path']}")

    for dirpath, _, filenames in os.walk(target_dir):
        for f in filenames:
            rel = (Path(dirpath) / f).relative_to(target_dir).as_posix()
            if rel not in expected_paths:
                raise DeployError(f"Installed verification failed: extraneous file {rel}")


def rollback(
    target_dir: Path,
    backup_dir: Path | None,
    prior_receipt_content: str | None,
    receipt_path: Path,
    reload_fn: Callable[[], None] | None,
) -> dict[str, Any]:
    if target_dir.is_symlink():
        raise DeployError(f"Target directory cannot be a symbolic link: {target_dir}")

    if backup_dir is None or not backup_dir.is_dir() or backup_dir.is_symlink():
        raise DeployError("Deployment failed; on-disk target could not be rolled back because no prior backup existed.")

    # Validate backups parent directory using no-follow semantics before reading it
    backups_parent = backup_dir.parent
    if backups_parent.is_symlink():
        raise DeployError(f"Backups parent directory cannot be a symbolic link: {backups_parent}")
    if not backups_parent.is_dir():
        raise DeployError(f"Backups parent path must be a directory: {backups_parent}")
    for dirpath, dirnames, filenames in os.walk(backup_dir):
        dp = Path(dirpath)
        if dp.is_symlink():
            raise DeployError(f"Backup directory contains symbolic link directory: {dp}")
        for d in dirnames:
            if (dp / d).is_symlink():
                raise DeployError(f"Backup directory contains symbolic link subdirectory: {dp / d}")
        for f in filenames:
            if (dp / f).is_symlink():
                raise DeployError(f"Backup directory contains symbolic link file: {dp / f}")

    for entry in list(target_dir.iterdir()):
        if entry.is_symlink():
            entry.unlink()
        elif entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()

    for entry in backup_dir.iterdir():
        if entry.is_symlink():
            raise DeployError(f"Backup directory contains symbolic link: {entry}")
        if entry.is_dir():
            shutil.copytree(entry, target_dir / entry.name, symlinks=False)
        else:
            shutil.copy2(entry, target_dir / entry.name, follow_symlinks=False)

    if receipt_path.is_symlink():
        receipt_path.unlink()

    if prior_receipt_content is not None:
        write_receipt_atomic(receipt_path, prior_receipt_content)
    elif receipt_path.is_symlink() or receipt_path.exists():
        receipt_path.unlink()

    reload_status = "not_attempted"
    if reload_fn is not None:
        try:
            reload_fn()
            reload_status = "reload_requested"
        except Exception as exc:
            reload_status = f"reload_failed: {exc}"

    return {
        "onDiskRestored": True,
        "backupDir": str(backup_dir),
        "reloadStatus": reload_status,
    }
def poll_readiness(doctor_argv: list[str], timeout_seconds: float, env: dict[str, str] | None = None) -> dict[str, Any]:
    start_time = time.monotonic()
    deadline = start_time + timeout_seconds
    attempts = 0
    last_errors: dict[str, str] = {}

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break

        attempts += 1
        all_passed = True

        for layer in ("ipc", "extension"):
            cmd = list(doctor_argv)
            if "--layer" not in cmd:
                cmd.extend(["--layer", layer])
            elif layer not in cmd:
                idx = cmd.index("--layer")
                if idx + 1 < len(cmd):
                    cmd[idx + 1] = layer

            remaining_call = max(0.1, deadline - time.monotonic())
            try:
                proc = subprocess.run(cmd, timeout=remaining_call, capture_output=True, text=True, env=env)
                if proc.returncode != 0:
                    all_passed = False
                    last_errors[layer] = f"exit {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}"
                    break

                out = proc.stdout.strip()
                if not out:
                    all_passed = False
                    last_errors[layer] = "empty output"
                    break

                try:
                    data = json.loads(out)
                except Exception:
                    all_passed = False
                    last_errors[layer] = f"invalid JSON: {out[:100]}"
                    break

                if not isinstance(data, dict) or data.get("success") is not True:
                    all_passed = False
                    last_errors[layer] = f"success not true: {data}"
                    break

                res = data.get("result")
                if not isinstance(res, dict):
                    all_passed = False
                    last_errors[layer] = f"missing or non-dict result: {data}"
                    break

                if res.get("state") != "ready":
                    all_passed = False
                    last_errors[layer] = f"state is not ready (got {res.get('state')}): {data}"
                    break

                if layer == "extension":
                    if res.get("probe") != "browser_tabs" or not isinstance(res.get("tabs_count"), int):
                        all_passed = False
                        last_errors[layer] = f"missing or invalid extension probe: {data}"
                        break

            except subprocess.TimeoutExpired:
                all_passed = False
                last_errors[layer] = "timed out"
                break

        if all_passed:
            return {
                "passed": True,
                "elapsedSeconds": round(time.monotonic() - start_time, 3),
                "attempts": attempts,
            }

        time.sleep(0.25)

    raise DeployError(
        f"Readiness check failed after {timeout_seconds:.1f}s ({attempts} attempts). "
        f"Errors: {last_errors}. "
        "Recovery: ensure Chrome is running with AgentTab extension enabled and run 'agenttab doctor --layer ipc'."
    )


def deploy(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    timeout_seconds = validate_timeout(args.timeout)
    source_dir = Path(args.source_dir).expanduser() if args.source_dir else (root / "packages" / "extension" / "dist")

    # Step 1: Strictly load identity
    expected_key, expected_id, expected_manifest_version, expected_version = load_identity(root)

    # Step 2: Pre-build target resolution and validation
    raw_target = resolve_target_dir(args.target_dir, args.state_dir, args.version)
    target_dir = validate_target(raw_target, root=root, source_dir=source_dir, expected_key=expected_key)

    version_root = target_dir.parent
    validate_sibling_paths(version_root)
    receipt_path = version_root / "dev-deploy-receipt.json"
    # Step 3: Dry-run check (handles missing dist gracefully)
    if args.dry_run:
        dist_exists = source_dir.is_dir()
        if dist_exists:
            files, bundle_digest = verify_bundle(source_dir, expected_key, expected_manifest_version, expected_version)
            file_count = len(files)
        else:
            files = []
            bundle_digest = "pending-build"
            file_count = 0
        return {
            "dryRun": True,
            "status": "planned",
            "targetDir": str(target_dir),
            "sourceDir": str(source_dir),
            "fileCount": file_count,
            "bundleSha256": bundle_digest,
            "sourceDistExists": dist_exists,
            "backupPlanned": True,
            "signedInstallReceiptPreserved": (version_root / "install-receipt.json").exists(),
        }

    # Guard default reload on unsupported platforms before mutation or swapping
    check_platform_reload_support(args, root)

    # Step 4: Build before bundle verification (unless build is skipped)
    if not args.skip_build:
        build_cmd = shlex.split(args.build_command) if args.build_command else ["bun", "run", "--cwd", "packages/extension", "build"]
        proc = subprocess.run(build_cmd, cwd=str(root), timeout=60.0, capture_output=True, text=True)
        if proc.returncode != 0:
            raise DeployError(f"Extension build failed (exit {proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}")
        # Re-validate target boundary after build
        target_dir = validate_target(raw_target, root=root, source_dir=source_dir, expected_key=expected_key)
        validate_sibling_paths(version_root)

    # Step 5: Verify bundle after build
    files, bundle_digest = verify_bundle(source_dir, expected_key, expected_manifest_version, expected_version)

    # Git metadata (called once)
    git_info = get_git_metadata(root)

    # Step 6: Safe backup
    validate_sibling_paths(version_root)
    backup_root = version_root / "backups"
    if backup_root.is_symlink():
        raise DeployError(f"Backups directory cannot be a symbolic link: {backup_root}")
    if backup_root.exists() and not backup_root.is_dir():
        raise DeployError(f"Backups path must be a directory: {backup_root}")
    backup_root.mkdir(parents=True, exist_ok=True)
    if backup_root.is_symlink():
        raise DeployError(f"Backups directory cannot be a symbolic link: {backup_root}")
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
    backup_dir = backup_root / f"extension_backup_{timestamp}"
    if backup_dir.is_symlink():
        raise DeployError(f"Backup directory cannot be a symbolic link: {backup_dir}")
    shutil.copytree(target_dir, backup_dir, symlinks=False)

    prior_receipt_content = None
    if receipt_path.is_symlink():
        raise DeployError(f"Receipt path cannot be a symbolic link: {receipt_path}")
    if receipt_path.is_file():
        prior_receipt_content = receipt_path.read_text(encoding="utf-8")

    # Reload helper (uses validated expected_id from identity)
    def do_reload(timeout: float = 10.0) -> None:
        if args.reload_command:
            cmd = shlex.split(args.reload_command)
        else:
            reload_script = Path(args.reload_script) if args.reload_script else (root / "scripts" / "reload_unpacked_extension.sh")
            cmd = ["bash", str(reload_script), "--extension-id", expected_id]
            if args.chrome_app:
                cmd.extend(["--chrome-app", args.chrome_app])
            if args.debugging_url:
                cmd.extend(["--debugging-url", args.debugging_url])
        proc = subprocess.run(cmd, timeout=timeout, capture_output=True, text=True)
        if proc.returncode != 0:
            raise DeployError(f"Reload failed (exit {proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}")

    # Step 7: Deploy files with rename staging swap and rollback on failure
    staging_dir = version_root / f".tmp_deploy_{os.getpid()}_{int(time.time() * 1000)}"
    old_target_swap = version_root / f".old_deploy_{os.getpid()}_{int(time.time() * 1000)}"
    if staging_dir.is_symlink():
        raise DeployError(f"Staging directory cannot be a symbolic link: {staging_dir}")
    if old_target_swap.is_symlink():
        raise DeployError(f"Swap directory cannot be a symbolic link: {old_target_swap}")
    try:
        shutil.copytree(source_dir, staging_dir, symlinks=False)
        target_dir.rename(old_target_swap)
        staging_dir.rename(target_dir)
        shutil.rmtree(old_target_swap, ignore_errors=True)

        # Independent byte verification
        verify_installed_bytes(source_dir, target_dir, files)

        # Write distinct development receipt (preserving install-receipt.json)
        receipt_data = {
            "schemaVersion": 1,
            "receiptType": "development-deploy",
            "deployedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "sourceDir": str(source_dir.resolve()),
            "targetDir": str(target_dir.resolve()),
            "bundleSha256": bundle_digest,
            "fileCount": len(files),
            "gitCommit": git_info.get("commit"),
            "gitDirty": git_info.get("dirty"),
            "backupPath": str(backup_dir.resolve()),
            "signedInstallReceiptPreserved": (version_root / "install-receipt.json").exists(),
            "files": files,
        }
        write_receipt_atomic(receipt_path, json.dumps(receipt_data, indent=2) + "\n")

        # Reload
        do_reload(timeout=10.0)

        # Doctor readiness environment setup
        doctor_env = dict(os.environ)
        if args.state_dir:
            resolved_state = Path(args.state_dir).expanduser().resolve()
            doctor_env["AGENTTAB_STATE_DIR"] = str(resolved_state)
            sock_candidate = resolved_state / "run" / "agenttab.sock"
            if sock_candidate.exists():
                doctor_env["AGENTTAB_SOCKET"] = str(sock_candidate)

        if args.doctor_command:
            doctor_argv = shlex.split(args.doctor_command)
        else:
            doctor_argv = ["bun", "run", str(root / "packages" / "installer" / "src" / "cli.ts"), "doctor"]

        readiness = poll_readiness(doctor_argv, timeout_seconds=timeout_seconds, env=doctor_env)

    except Exception as exc:
        # Clean up transient swap directories if left behind
        if old_target_swap.exists() and not target_dir.exists():
            old_target_swap.rename(target_dir)
        if staging_dir.is_symlink():
            staging_dir.unlink()
        elif staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        report = rollback(target_dir, backup_dir, prior_receipt_content, receipt_path, lambda: do_reload(timeout=5.0))
        raise DeployError(
            f"Deploy failed: {exc}. "
            f"On-disk state: restored from {report['backupDir']}. "
            f"Runtime state: {report['reloadStatus']} (runtime healthy unproven)."
        ) from exc

    return {
        "status": "deployed",
        "targetDir": str(target_dir),
        "sourceDir": str(source_dir),
        "backupDir": str(backup_dir),
        "receiptPath": str(receipt_path),
        "bundleSha256": bundle_digest,
        "filesDeployed": len(files),
        "readiness": readiness,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build, deploy, reload, and verify AgentTab extension for local development iteration",
    )
    parser.add_argument("--target-dir", help="Explicit existing AgentTab extension destination directory")
    parser.add_argument("--state-dir", help="AgentTab state directory root (defaults to ~/.agenttab or $AGENTTAB_STATE_DIR)")
    parser.add_argument("--version", help="Version directory to target when --target-dir is omitted (e.g. 2.0.0-rc.1)")
    parser.add_argument("--source-dir", help="Source directory of built extension files (defaults to packages/extension/dist)")
    parser.add_argument("--dry-run", action="store_true", help="Simulate deployment and output planned actions without mutating filesystem or Chrome")
    parser.add_argument("--skip-build", action="store_true", help="Skip executing the build command")
    parser.add_argument("--build-command", help="Custom build command (defaults to 'bun run --cwd packages/extension build')")
    parser.add_argument("--reload-script", help="Path to reload script (defaults to scripts/reload_unpacked_extension.sh)")
    parser.add_argument("--reload-command", help="Custom reload command to execute instead of reload_unpacked_extension.sh")
    parser.add_argument("--chrome-app", help="Chrome application name on macOS (defaults to $AGENTTAB_CHROME_APP or 'Google Chrome')")
    parser.add_argument("--debugging-url", help="Loopback DevTools HTTP endpoint for reloading via CDP")
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_READINESS_TIMEOUT,
        help=f"Readiness check timeout in seconds (default: {DEFAULT_READINESS_TIMEOUT})",
    )
    parser.add_argument("--doctor-command", help="Custom doctor command to run for readiness verification")
    parser.add_argument("--json", action="store_true", help="Emit output as formatted JSON")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = deploy(args)
        if args.json:
            print(json.dumps(result, indent=2))
        elif result.get("dryRun"):
            print("[dry-run] AgentTab Development Deploy Simulation Plan:")
            print(f"  Target:        {result['targetDir']}")
            print(f"  Source:        {result['sourceDir']}")
            print(f"  Bundle files:  {result['fileCount']} verified ({'dist exists' if result['sourceDistExists'] else 'dist pending build'})")
            print(f"  Bundle SHA256: {result['bundleSha256']}")
            print(f"  Backup:        Would be created at {Path(result['targetDir']).parent / 'backups'}")
            print(f"  Receipt:       dev-deploy-receipt.json would be written; install-receipt.json preserved")
        else:
            print("AgentTab Development Deploy Succeeded:")
            print(f"  Target:        {result['targetDir']}")
            print(f"  Receipt:       {result['receiptPath']}")
            print(f"  Backup:        {result['backupDir']}")
            print(f"  Bundle SHA256: {result['bundleSha256']}")
            print(f"  Files:         {result['filesDeployed']} deployed")
            readiness = result["readiness"]
            print(f"  Readiness:     proven in {readiness['elapsedSeconds']}s ({readiness['attempts']} attempts)")
        return 0
    except DeployError as exc:
        if args.json:
            print(json.dumps({"success": False, "error": str(exc)}, indent=2), file=sys.stderr)
        else:
            print(f"Error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        if args.json:
            print(json.dumps({"success": False, "error": f"Unexpected error: {exc}"}, indent=2), file=sys.stderr)
        else:
            print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
