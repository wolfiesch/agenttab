#!/usr/bin/env python3
"""Create deterministic host archives that preserve installer extraction semantics."""

from __future__ import annotations

import argparse
import gzip
import io
import json
import re
import sys
import tarfile
import zipfile
from hashlib import sha256
from pathlib import Path

SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$")
TARGETS = {
    "aarch64-apple-darwin": "tar.gz",
    "x86_64-apple-darwin": "tar.gz",
    "aarch64-unknown-linux-gnu": "tar.gz",
    "x86_64-unknown-linux-gnu": "tar.gz",
    "x86_64-pc-windows-msvc": "zip",
}
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class ArchiveError(Exception):
    """Raised when a host archive cannot satisfy the installer contract."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Package the AgentTab daemon and native shim")
    parser.add_argument("--version", required=True, help="Exact semantic version without v")
    parser.add_argument("--target", required=True, choices=sorted(TARGETS))
    parser.add_argument("--binary", required=True, type=Path, help="Built agenttab-host executable")
    parser.add_argument("--shim", required=True, type=Path, help="Built agenttab-native executable")
    parser.add_argument("--out-dir", required=True, type=Path, help="Directory for the release asset")
    return parser.parse_args(argv)


def asset_name(version: str, target: str) -> str:
    return f"agenttab-host-v{version}-{target}.{TARGETS[target]}"


def package_tar(output: Path, entries: list[tuple[str, bytes]]) -> None:
    with output.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive:
                for name, data in entries:
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o755
                    member.mtime = 0
                    member.uid = 0
                    member.gid = 0
                    member.uname = ""
                    member.gname = ""
                    archive.addfile(member, io.BytesIO(data))


def package_zip(output: Path, entries: list[tuple[str, bytes]]) -> None:
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            member = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
            member.create_system = 3
            member.compress_type = zipfile.ZIP_DEFLATED
            member.external_attr = 0o100755 << 16
            archive.writestr(member, data)


def package(
    version: str,
    target: str,
    binary: Path,
    shim: Path,
    out_dir: Path,
) -> dict[str, object]:
    if SEMVER.fullmatch(version) is None:
        raise ArchiveError("--version must be an exact semantic version without build metadata")
    if target not in TARGETS:
        raise ArchiveError(f"unsupported host target: {target}")
    expected_binary = "agenttab-host.exe" if TARGETS[target] == "zip" else "agenttab-host"
    expected_shim = "agenttab-native.exe" if TARGETS[target] == "zip" else "agenttab-native"
    if binary.name != expected_binary:
        raise ArchiveError(f"{target} requires binary name {expected_binary}")
    if shim.name != expected_shim:
        raise ArchiveError(f"{target} requires shim name {expected_shim}")
    entries: list[tuple[str, bytes]] = []
    for path, name in ((binary, expected_binary), (shim, expected_shim)):
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise ArchiveError(f"cannot read {path}: {exc}") from exc
        if not data:
            raise ArchiveError(f"packaged executable is empty: {path}")
        entries.append((name, data))

    out_dir.mkdir(parents=True, exist_ok=True)
    output = out_dir / asset_name(version, target)
    if output.exists():
        raise ArchiveError(f"refusing to replace existing release asset: {output}")
    if TARGETS[target] == "zip":
        package_zip(output, entries)
    else:
        package_tar(output, entries)
    digest = sha256(output.read_bytes()).hexdigest()
    return {
        "path": output.as_posix(),
        "name": output.name,
        "target": target,
        "bytes": output.stat().st_size,
        "sha256": digest,
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        metadata = package(args.version, args.target, args.binary, args.shim, args.out_dir)
    except ArchiveError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(metadata, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
