#!/usr/bin/env python3
"""Verify that two flat release-asset directories contain identical bytes."""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path


class AssetSetError(Exception):
    """Raised when a release asset set is incomplete or has changed."""


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def inventory(root: Path) -> dict[str, tuple[int, str]]:
    if not root.is_dir():
        raise AssetSetError(f"release asset directory does not exist: {root}")

    entries = sorted(root.iterdir(), key=lambda path: path.name)
    if not entries:
        raise AssetSetError(f"release asset directory is empty: {root}")

    assets: dict[str, tuple[int, str]] = {}
    for path in entries:
        if path.is_symlink() or not path.is_file():
            raise AssetSetError(f"release asset directory must be flat and contain regular files: {path}")
        stat = path.stat()
        if stat.st_nlink != 1:
            raise AssetSetError(f"release asset must not be hard-linked: {path}")
        assets[path.name] = (stat.st_size, digest(path))
    return assets


def verify(expected_dir: Path, actual_dir: Path) -> dict[str, tuple[int, str]]:
    expected = inventory(expected_dir)
    actual = inventory(actual_dir)

    missing = sorted(set(expected) - set(actual))
    unexpected = sorted(set(actual) - set(expected))
    changed = sorted(name for name in expected.keys() & actual.keys() if expected[name] != actual[name])
    errors: list[str] = []
    if missing:
        errors.append(f"missing assets: {', '.join(missing)}")
    if unexpected:
        errors.append(f"unexpected assets: {', '.join(unexpected)}")
    if changed:
        errors.append(f"changed assets: {', '.join(changed)}")
    if errors:
        raise AssetSetError("; ".join(errors))
    return expected


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-dir", required=True, type=Path)
    parser.add_argument("--actual-dir", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        assets = verify(args.expected_dir.resolve(), args.actual_dir.resolve())
    except (AssetSetError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    total_bytes = sum(size for size, _ in assets.values())
    print(f"Verified {len(assets)} immutable release assets ({total_bytes} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
