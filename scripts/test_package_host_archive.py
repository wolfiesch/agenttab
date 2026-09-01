from __future__ import annotations

import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.package_host_archive import ArchiveError, package


class HostArchiveTests(unittest.TestCase):
    def test_archives_are_deterministic_and_preserve_the_exact_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "agenttab-host"
            binary.write_bytes(b"agenttab-host-fixture\n")
            shim = root / "agenttab-native"
            shim.write_bytes(b"agenttab-native-fixture\n")
            first = root / "first"
            second = root / "second"

            first_metadata = package("2.0.0-rc.1", "aarch64-apple-darwin", binary, shim, first)
            second_metadata = package("2.0.0-rc.1", "aarch64-apple-darwin", binary, shim, second)
            first_archive = first / str(first_metadata["name"])
            second_archive = second / str(second_metadata["name"])

            self.assertEqual(first_archive.read_bytes(), second_archive.read_bytes())
            with tarfile.open(first_archive, "r:gz") as archive:
                members = archive.getmembers()
                self.assertEqual(
                    [member.name for member in members],
                    ["agenttab-host", "agenttab-native"],
                )
                self.assertTrue(all(member.mode == 0o755 for member in members))
                self.assertEqual(archive.extractfile(members[0]).read(), binary.read_bytes())
                self.assertEqual(archive.extractfile(members[1]).read(), shim.read_bytes())

    def test_windows_archive_uses_the_installer_filename(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "agenttab-host.exe"
            binary.write_bytes(b"signed-windows-fixture\n")
            shim = root / "agenttab-native.exe"
            shim.write_bytes(b"signed-windows-shim-fixture\n")
            metadata = package(
                "2.0.0", "x86_64-pc-windows-msvc", binary, shim, root / "release"
            )
            with zipfile.ZipFile(root / "release" / str(metadata["name"])) as archive:
                self.assertEqual(
                    archive.namelist(), ["agenttab-host.exe", "agenttab-native.exe"]
                )
                self.assertEqual(archive.read("agenttab-host.exe"), binary.read_bytes())
                self.assertEqual(archive.read("agenttab-native.exe"), shim.read_bytes())

    def test_refuses_empty_or_preexisting_release_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "agenttab-host"
            shim = root / "agenttab-native"
            shim.write_bytes(b"shim")
            binary.write_bytes(b"")
            with self.assertRaisesRegex(ArchiveError, "empty"):
                package("2.0.0", "x86_64-unknown-linux-gnu", binary, shim, root / "release")

            binary.write_bytes(b"host")
            package("2.0.0", "x86_64-unknown-linux-gnu", binary, shim, root / "release")
            with self.assertRaisesRegex(ArchiveError, "refusing to replace"):
                package("2.0.0", "x86_64-unknown-linux-gnu", binary, shim, root / "release")


if __name__ == "__main__":
    unittest.main()
