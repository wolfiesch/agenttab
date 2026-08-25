from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.package_artifact_manifest import PackagingError, assemble, expected_assets


class ArtifactManifestTests(unittest.TestCase):
    tag = "v2.0.0-rc.1"
    version = "2.0.0-rc.1"
    python_version = "2.0.0rc1"

    @staticmethod
    def repository_root() -> Path:
        return Path(__file__).resolve().parent.parent

    def populate(self, directory: Path) -> None:
        directory.mkdir()
        for name in expected_assets(self.version, self.python_version):
            (directory / name).write_bytes(f"fixture:{name}\n".encode())

    def test_assembly_is_deterministic_and_emits_exact_host_trust_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = root / "inputs"
            self.populate(inputs)
            first = root / "first"
            second = root / "second"

            assemble(self.repository_root(), self.tag, inputs, first)
            assemble(self.repository_root(), self.tag, inputs, second)

            first_files = sorted(path.name for path in first.iterdir())
            self.assertEqual(first_files, sorted(path.name for path in second.iterdir()))
            for name in first_files:
                self.assertEqual((first / name).read_bytes(), (second / name).read_bytes(), name)

            manifest = json.loads((first / "artifact-manifest.json").read_text())
            self.assertEqual(manifest["repository"], "wolfiesch/agenttab")
            self.assertEqual(manifest["tag"], self.tag)
            self.assertEqual(
                [entry["target"] for entry in manifest["assets"]],
                [
                    "aarch64-apple-darwin",
                    "x86_64-apple-darwin",
                    "aarch64-unknown-linux-gnu",
                    "x86_64-unknown-linux-gnu",
                    "x86_64-pc-windows-msvc",
                ],
            )
            self.assertEqual(
                [entry["platformSignature"] for entry in manifest["assets"]],
                [
                    "apple_code_signing",
                    "apple_code_signing",
                    "signed_manifest",
                    "signed_manifest",
                    "authenticode",
                ],
            )
            checksums = (first / "SHA256SUMS").read_text()
            self.assertIn("  artifact-manifest.json\n", checksums)

    def test_rejects_missing_and_unlisted_release_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = root / "inputs"
            self.populate(inputs)
            missing = expected_assets(self.version, self.python_version)[0]
            (inputs / missing).unlink()
            with self.assertRaisesRegex(PackagingError, "missing required release assets"):
                assemble(self.repository_root(), self.tag, inputs, root / "missing-output")

            (inputs / missing).write_bytes(b"restored")
            (inputs / "unexpected-private-file").write_bytes(b"must not ship")
            with self.assertRaisesRegex(PackagingError, "unlisted release inputs are forbidden"):
                assemble(self.repository_root(), self.tag, inputs, root / "unexpected-output")


if __name__ == "__main__":
    unittest.main()
