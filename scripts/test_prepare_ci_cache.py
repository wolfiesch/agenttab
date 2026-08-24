#!/usr/bin/env python3

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.prepare_ci_cache import prepare_ci_cache


class PrepareCiCacheTests(unittest.TestCase):
    def fixture(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        home = Path(temporary.name)
        root = home / "Library" / "Caches" / "agenttab-ci" / "v-test"
        (root / "cargo-target").mkdir(parents=True)
        self.addCleanup(temporary.cleanup)
        return temporary, root

    def test_rejects_paths_outside_project_cache(self) -> None:
        with self.assertRaisesRegex(ValueError, "agenttab-ci"):
            prepare_ci_cache(Path("/tmp/cargo-target"))

    def test_keeps_a_healthy_cache(self) -> None:
        temporary, root = self.fixture()
        del temporary
        cached = root / "cargo-target" / "artifact"
        cached.write_text("warm", encoding="utf-8")
        with patch("scripts.prepare_ci_cache.Path.home", return_value=root.parents[3]):
            report = prepare_ci_cache(
                root,
                max_bytes=100,
                min_free_bytes=10,
                measure_available_bytes=lambda _: 100,
            )
        self.assertEqual(report["resetReason"], "none")
        self.assertEqual(cached.read_text(encoding="utf-8"), "warm")

    def test_prunes_only_the_generated_target(self) -> None:
        temporary, root = self.fixture()
        del temporary
        cached = root / "cargo-target" / "artifact"
        cached.write_text("oversized", encoding="utf-8")
        sibling = root / "preserved"
        sibling.write_text("keep", encoding="utf-8")
        with patch("scripts.prepare_ci_cache.Path.home", return_value=root.parents[3]):
            report = prepare_ci_cache(
                root,
                max_bytes=1,
                min_free_bytes=10,
                measure_available_bytes=lambda _: 100,
            )
        self.assertEqual(report["resetReason"], "size-limit")
        self.assertFalse(cached.exists())
        self.assertEqual(sibling.read_text(encoding="utf-8"), "keep")

    def test_fails_when_pruning_cannot_restore_free_space(self) -> None:
        temporary, root = self.fixture()
        del temporary
        with (
            patch("scripts.prepare_ci_cache.Path.home", return_value=root.parents[3]),
            self.assertRaisesRegex(RuntimeError, "requires 1 GiB"),
        ):
            prepare_ci_cache(
                root,
                min_free_bytes=1024**3,
                measure_available_bytes=lambda _: 0,
            )


if __name__ == "__main__":
    unittest.main()
