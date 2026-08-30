from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from scripts.verify_release_asset_set import AssetSetError, verify


class ReleaseAssetSetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.expected = root / "expected"
        self.actual = root / "actual"
        self.expected.mkdir()
        self.actual.mkdir()

    def populate(self) -> None:
        for root in (self.expected, self.actual):
            (root / "agenttab.tar.gz").write_bytes(b"host archive")
            (root / "SHA256SUMS").write_bytes(b"checksums")

    def test_accepts_identical_flat_asset_sets(self) -> None:
        self.populate()
        assets = verify(self.expected, self.actual)
        self.assertEqual(set(assets), {"SHA256SUMS", "agenttab.tar.gz"})

    def test_rejects_missing_unexpected_and_changed_assets(self) -> None:
        self.populate()
        (self.actual / "agenttab.tar.gz").write_bytes(b"changed")
        (self.actual / "SHA256SUMS").unlink()
        (self.actual / "unlisted.txt").write_bytes(b"unexpected")

        with self.assertRaisesRegex(
            AssetSetError,
            r"missing assets: SHA256SUMS; unexpected assets: unlisted.txt; changed assets: agenttab.tar.gz",
        ):
            verify(self.expected, self.actual)

    def test_rejects_empty_nested_symlinked_and_hard_linked_inputs(self) -> None:
        with self.assertRaisesRegex(AssetSetError, "is empty"):
            verify(self.expected, self.actual)

        (self.expected / "nested").mkdir()
        (self.actual / "nested").mkdir()
        with self.assertRaisesRegex(AssetSetError, "must be flat"):
            verify(self.expected, self.actual)

        for root in (self.expected, self.actual):
            (root / "nested").rmdir()
            (root / "asset").write_bytes(b"asset")
        (self.actual / "link").symlink_to(self.actual / "asset")
        with self.assertRaisesRegex(AssetSetError, "must be flat"):
            verify(self.expected, self.actual)

        (self.actual / "link").unlink()
        os.link(self.actual / "asset", self.actual / "hard-link")
        with self.assertRaisesRegex(AssetSetError, "must not be hard-linked"):
            verify(self.expected, self.actual)


if __name__ == "__main__":
    unittest.main()
