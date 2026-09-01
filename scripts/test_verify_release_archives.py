from __future__ import annotations

import io
import tarfile
import tempfile
import unittest
from pathlib import Path

from scripts.package_host_archive import package
from scripts.verify_release_archives import SmokeError, archive_binaries


class ReleaseArchiveSmokeTests(unittest.TestCase):
    def test_reads_the_exact_daemon_and_shim_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            host = root / "agenttab-host"
            shim = root / "agenttab-native"
            host.write_bytes(b"host-fixture")
            shim.write_bytes(b"shim-fixture")
            metadata = package(
                "2.0.0", "x86_64-unknown-linux-gnu", host, shim, root / "release"
            )
            payloads = archive_binaries(
                root / "release" / str(metadata["name"]),
                "x86_64-unknown-linux-gnu",
            )
            self.assertEqual(
                payloads,
                {"agenttab-host": b"host-fixture", "agenttab-native": b"shim-fixture"},
            )

    def test_rejects_a_legacy_single_binary_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "legacy.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                member = tarfile.TarInfo("agenttab-host")
                member.size = 4
                archive.addfile(member, io.BytesIO(b"host"))
            with self.assertRaisesRegex(SmokeError, "agenttab-native"):
                archive_binaries(archive_path, "x86_64-unknown-linux-gnu")


if __name__ == "__main__":
    unittest.main()
