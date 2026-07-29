#!/usr/bin/env python3
"""Bound the persistent Cargo cache used by the trusted M1 CI runner."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path
from typing import Callable

GIB = 1024**3


def directory_bytes(path: Path) -> int:
    total = 0
    for entry in os.scandir(path):
        if entry.is_dir(follow_symlinks=False):
            total += directory_bytes(Path(entry.path))
        else:
            total += entry.stat(follow_symlinks=False).st_size
    return total


def available_bytes(path: Path) -> int:
    stats = os.statvfs(path)
    return stats.f_bavail * stats.f_frsize


def prepare_ci_cache(
    cache_root: Path,
    *,
    max_bytes: int = 4 * GIB,
    min_free_bytes: int = 11 * GIB,
    measure_available_bytes: Callable[[Path], int] = available_bytes,
    measure_directory_bytes: Callable[[Path], int] = directory_bytes,
) -> dict[str, int | str]:
    root = cache_root.expanduser().resolve()
    owned_base = (Path.home() / "Library" / "Caches" / "chrome-bridge-ci").resolve()
    if root.parent != owned_base:
        raise ValueError(
            "cache root must be one versioned child of "
            "~/Library/Caches/chrome-bridge-ci"
        )

    target = root / "cargo-target"
    target.mkdir(parents=True, exist_ok=True)
    cache_bytes_before = measure_directory_bytes(target)
    free_bytes_before = measure_available_bytes(root)
    reset_reason = "none"
    if cache_bytes_before > max_bytes:
        reset_reason = "size-limit"
    elif free_bytes_before < min_free_bytes:
        reset_reason = "free-space-floor"

    if reset_reason != "none":
        shutil.rmtree(target)
        target.mkdir()

    free_bytes_after = measure_available_bytes(root)
    if free_bytes_after < min_free_bytes:
        raise RuntimeError(
            f"CI requires {min_free_bytes // GIB} GiB free after cache pruning; "
            f"{free_bytes_after // GIB} GiB remain"
        )

    return {
        "cacheBytesBefore": cache_bytes_before,
        "freeBytesBefore": free_bytes_before,
        "freeBytesAfter": free_bytes_after,
        "resetReason": reset_reason,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--max-gib", type=int, default=4)
    parser.add_argument("--min-free-gib", type=int, default=11)
    args = parser.parse_args()
    if args.max_gib <= 0 or args.min_free_gib <= 0:
        parser.error("cache bounds must be positive")
    report = prepare_ci_cache(
        args.root,
        max_bytes=args.max_gib * GIB,
        min_free_bytes=args.min_free_gib * GIB,
    )
    print(f"prepare-ci-cache: {json.dumps(report, sort_keys=True)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
