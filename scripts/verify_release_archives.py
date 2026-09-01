#!/usr/bin/env python3
"""Install and smoke AgentTab release artifacts under isolated temporary roots."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from hashlib import sha256
from pathlib import Path

try:
    from .package_artifact_manifest import HOST_TARGETS, expected_assets
    from .verify_release_identity import IdentityError, version_from_tag
except ImportError:
    from package_artifact_manifest import HOST_TARGETS, expected_assets
    from verify_release_identity import IdentityError, version_from_tag


class SmokeError(Exception):
    """Raised when a release artifact cannot be installed or exercised safely."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify packaged AgentTab release artifacts")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--host-archive", type=Path, help="One host archive to extract and smoke")
    source.add_argument("--package-dir", type=Path, help="Directory containing JS, Python, and extension artifacts")
    source.add_argument("--release-dir", type=Path, help="Assembled release directory")
    parser.add_argument("--target", choices=HOST_TARGETS, help="Target for --host-archive")
    parser.add_argument("--tag", help="Release tag required for package and release verification")
    return parser.parse_args(argv)


def run(command: list[str], *, cwd: Path, env: dict[str, str]) -> None:
    completed = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise SmokeError(f"command failed ({' '.join(command[:2])}): {detail[-1000:]}")


def executable_names(target: str) -> tuple[str, str]:
    suffix = ".exe" if target.endswith("windows-msvc") else ""
    return f"agenttab-host{suffix}", f"agenttab-native{suffix}"


def archive_binaries(archive: Path, target: str) -> dict[str, bytes]:
    expected = executable_names(target)
    try:
        if target.endswith("windows-msvc"):
            with zipfile.ZipFile(archive) as contents:
                members = contents.infolist()
                if len(members) != 2 or tuple(member.filename for member in members) != expected:
                    raise SmokeError(f"{archive.name} must contain exactly {' and '.join(expected)}")
                if any(
                    member.is_dir()
                    or member.filename.startswith("/")
                    or ".." in Path(member.filename).parts
                    for member in members
                ):
                    raise SmokeError(f"{archive.name} has an unsafe or non-file member")
                return {member.filename: contents.read(member) for member in members}
        with tarfile.open(archive, "r:gz") as contents:
            members = contents.getmembers()
            if len(members) != 2 or tuple(member.name for member in members) != expected:
                raise SmokeError(f"{archive.name} must contain exactly {' and '.join(expected)}")
            if any(
                not member.isfile()
                or member.name.startswith("/")
                or ".." in Path(member.name).parts
                for member in members
            ):
                raise SmokeError(f"{archive.name} has an unsafe or non-file member")
            payloads: dict[str, bytes] = {}
            for member in members:
                extracted = contents.extractfile(member)
                if extracted is None:
                    raise SmokeError(f"{archive.name} does not contain {member.name}")
                payloads[member.name] = extracted.read()
            return payloads
    except (OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
        raise SmokeError(f"cannot read host archive {archive}: {exc}") from exc


def current_target() -> str | None:
    system = platform.system().lower()
    machine = platform.machine().lower()
    architecture = {
        "arm64": "aarch64",
        "aarch64": "aarch64",
        "x86_64": "x86_64",
        "amd64": "x86_64",
    }.get(machine)
    if architecture is None:
        return None
    os_suffix = {
        "darwin": "apple-darwin",
        "linux": "unknown-linux-gnu",
        "windows": "pc-windows-msvc",
    }.get(system)
    return f"{architecture}-{os_suffix}" if os_suffix else None


def smoke_host(archive: Path, target: str, root: Path) -> None:
    if not archive.is_file():
        raise SmokeError(f"missing host archive: {archive}")
    payloads = archive_binaries(archive, target)
    if any(not payload for payload in payloads.values()):
        raise SmokeError(f"host archive contains an empty executable: {archive}")
    if current_target() != target:
        return
    root.mkdir(parents=True, exist_ok=True)
    for name, payload in payloads.items():
        binary = root / name
        binary.write_bytes(payload)
        binary.chmod(0o755)
    binary = root / executable_names(target)[0]
    home = root / "home"
    home.mkdir()
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / "config"),
        "XDG_RUNTIME_DIR": str(home / "runtime"),
    })
    env.pop("PYTHONPATH", None)
    completed = subprocess.run(
        [str(binary)],
        cwd=root,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        raise SmokeError(f"extracted host did not exit cleanly: {detail[-1000:]}")


def extension_members(root: Path) -> tuple[str, ...]:
    script = root / "scripts" / "package_extension_store.py"
    spec = importlib.util.spec_from_file_location("package_extension_store", script)
    if spec is None or spec.loader is None:
        raise SmokeError("cannot load canonical extension package definition")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    members = getattr(module, "EXTENSION_FILES", None)
    if not isinstance(members, tuple):
        raise SmokeError("canonical extension package definition has no file list")
    return members


def smoke_extension(archive: Path, version: str, root: Path) -> None:
    try:
        with zipfile.ZipFile(archive) as contents:
            names = tuple(sorted(contents.namelist()))
            expected = tuple(sorted(extension_members(root)))
            if names != expected:
                raise SmokeError("extension archive does not match the canonical store package member list")
            manifest = json.loads(contents.read("manifest.json"))
    except (OSError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        raise SmokeError(f"cannot validate extension archive {archive}: {exc}") from exc
    if manifest.get("version_name") != version:
        raise SmokeError("extension archive version_name does not match the release version")
    if "key" in manifest:
        raise SmokeError("store extension archive must not contain a development key")


def smoke_packages(directory: Path, root: Path, tag: str, temporary_root: Path) -> None:
    try:
        version, _, python_version = version_from_tag(tag)
    except IdentityError as exc:
        raise SmokeError(str(exc)) from exc
    names = expected_assets(version, python_version)[5:]
    missing = [name for name in names if not (directory / name).is_file()]
    if missing:
        raise SmokeError(f"missing packaged artifacts: {', '.join(missing)}")
    npm = shutil.which("npm")
    node = shutil.which("node")
    if npm is None or node is None:
        raise SmokeError("npm and node are required for JavaScript package smoke tests")
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    npm_root = temporary_root / "npm"
    package_archives = [
        directory / f"agenttab-sdk-{version}.tgz",
        directory / f"agenttab-mcp-{version}.tgz",
        directory / f"agenttab-omp-{version}.tgz",
        directory / f"agenttab-gpt-control-driver-{version}.tgz",
        directory / f"agenttab-{version}.tgz",
    ]
    run(
        [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", str(npm_root), *map(str, package_archives)],
        cwd=temporary_root,
        env=env,
    )
    run([node, "--input-type=module", "--eval", "await import('@getagenttab/sdk');"], cwd=npm_root, env=env)
    for relative in (
        "node_modules/agenttab-mcp/dist/server.mjs",
        "node_modules/@getagenttab/omp/dist/index.mjs",
        "node_modules/@getagenttab/gpt-control-driver/dist/driver.mjs",
        "node_modules/agenttab/dist/cli.mjs",
    ):
        run([node, "--check", relative], cwd=npm_root, env=env)

    venv = temporary_root / "python-venv"
    run([sys.executable, "-m", "venv", str(venv)], cwd=temporary_root, env=env)
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run(
        [str(python), "-m", "pip", "install", "--no-deps", "--no-index", str(directory / f"agenttab-{python_version}-py3-none-any.whl")],
        cwd=temporary_root,
        env=env,
    )
    run([str(python), "-c", "import agenttab; assert agenttab.RPC_PROTOCOL == 'agenttab.rpc'"], cwd=temporary_root, env=env)
    smoke_extension(directory / f"agenttab-extension-v{version}.zip", version, root)


def verify_checksums(release_dir: Path) -> None:
    checksum_path = release_dir / "SHA256SUMS"
    if not checksum_path.is_file():
        raise SmokeError("assembled release is missing SHA256SUMS")
    signature_names = {"artifact-manifest.json.sig", "SHA256SUMS.sig"}
    missing_signatures = [name for name in sorted(signature_names) if not (release_dir / name).is_file()]
    if missing_signatures:
        raise SmokeError(f"assembled release is missing signatures: {', '.join(missing_signatures)}")
    entries: dict[str, str] = {}
    for line in checksum_path.read_text(encoding="utf-8").splitlines():
        try:
            digest, name = line.split("  ", 1)
        except ValueError as exc:
            raise SmokeError("SHA256SUMS contains a malformed line") from exc
        if len(digest) != 64 or not all(char in "0123456789abcdef" for char in digest):
            raise SmokeError("SHA256SUMS contains an invalid SHA-256 digest")
        if not name or name in entries:
            raise SmokeError("SHA256SUMS contains an invalid or duplicate asset name")
        entries[name] = digest
    files = {
        path.name
        for path in release_dir.iterdir()
        if path.is_file() and path.name != "SHA256SUMS" and path.name not in signature_names
    }
    if set(entries) != files:
        raise SmokeError("SHA256SUMS must cover every assembled asset exactly once")
    for name, expected in entries.items():
        actual = sha256((release_dir / name).read_bytes()).hexdigest()
        if actual != expected:
            raise SmokeError(f"SHA256SUMS does not match {name}")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.host_archive is not None and args.target is None:
        print("ERROR: --target is required with --host-archive", file=sys.stderr)
        return 2
    if args.target is not None and args.host_archive is None:
        print("ERROR: --target is only valid with --host-archive", file=sys.stderr)
        return 2
    if (args.package_dir is not None or args.release_dir is not None) and not args.tag:
        print("ERROR: --tag is required with --package-dir or --release-dir", file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parent.parent
    try:
        short_temp_parent = Path("/tmp") if os.name != "nt" and Path("/tmp").is_dir() else None
        with tempfile.TemporaryDirectory(prefix="agenttab-", dir=short_temp_parent) as temporary:
            temporary_root = Path(temporary)
            if args.host_archive is not None:
                smoke_host(args.host_archive.resolve(), args.target, temporary_root)
            elif args.package_dir is not None:
                smoke_packages(args.package_dir.resolve(), root, args.tag, temporary_root)
            else:
                release_dir = args.release_dir.resolve()
                verify_checksums(release_dir)
                smoke_packages(release_dir, root, args.tag, temporary_root)
                version, _, python_version = version_from_tag(args.tag)
                for target in HOST_TARGETS:
                    archive = release_dir / f"agenttab-host-v{version}-{target}.{'zip' if target.endswith('windows-msvc') else 'tar.gz'}"
                    smoke_host(archive, target, temporary_root / target)
                inventory = json.loads((release_dir / "release-inventory.json").read_text(encoding="utf-8"))
                if inventory.get("tag") != args.tag or inventory.get("version") != version:
                    raise SmokeError("release inventory does not match the requested tag")
    except (IdentityError, OSError, SmokeError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print("Release archive smoke checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
