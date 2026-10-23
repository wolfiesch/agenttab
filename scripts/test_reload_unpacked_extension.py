#!/usr/bin/env python3
"""Deterministic tests for the macOS wake-page fallback in reload_unpacked_extension.sh."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "reload_unpacked_extension.sh"
EXTENSION_ID = "dcnomehaghobngdhnbeafanhmlhdpnpl"
OTHER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
WAKE_URL = f"chrome-extension://{EXTENSION_ID}/wake.html?reload=1"

FAKE_OPEN = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_OPEN_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
"""


class ReloadScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "home"
        self.bin = root / "bin"
        self.bin.mkdir()
        fake_open = self.bin / "open"
        fake_open.write_text(FAKE_OPEN)
        fake_open.chmod(0o755)
        self.open_log = root / "open.log"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def make_user_data_dir(self, path: Path, profiles: dict[str, list[str]]) -> Path:
        path.mkdir(parents=True)
        (path / "Local State").write_text(
            json.dumps({"profile": {"info_cache": {name: {} for name in profiles}}})
        )
        for name, extension_ids in profiles.items():
            (path / name).mkdir()
            (path / name / "Secure Preferences").write_text(
                json.dumps({"extensions": {"settings": {ext: {"location": 4} for ext in extension_ids}}})
            )
        return path

    def run_script(self, *args: str) -> tuple[subprocess.CompletedProcess[str], list[list[str]]]:
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("AGENTTAB_CHROME_")
        }
        env.update(
            HOME=str(self.home),
            PATH=f"{self.bin}{os.pathsep}{env.get('PATH', '')}",
            FAKE_OPEN_LOG=str(self.open_log),
        )
        result = subprocess.run(
            ["bash", str(SCRIPT), "--extension-id", EXTENSION_ID, *args],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        calls = []
        if self.open_log.exists():
            calls = [json.loads(line) for line in self.open_log.read_text().splitlines()]
        return result, calls

    def test_opens_wake_page_in_each_profile_with_the_extension(self) -> None:
        self.make_user_data_dir(
            self.home / "Library/Application Support/Google/Chrome",
            {"Default": [OTHER_ID], "Profile 1": [EXTENSION_ID], "Profile 2": [EXTENSION_ID]},
        )

        result, calls = self.run_script()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                ["-g", "-n", "-a", "Google Chrome", "--args", f"--profile-directory={profile}", WAKE_URL]
                for profile in ("Profile 1", "Profile 2")
            ],
        )

    def test_fails_without_opening_when_no_profile_has_the_extension(self) -> None:
        self.make_user_data_dir(
            self.home / "Library/Application Support/Google/Chrome",
            {"Default": [OTHER_ID]},
        )

        result, calls = self.run_script()

        self.assertEqual(result.returncode, 69)
        self.assertIn("not installed in any Chrome profile", result.stderr)
        self.assertEqual(calls, [])

    def test_custom_user_data_dir_is_detected_and_forwarded(self) -> None:
        user_data_dir = self.make_user_data_dir(
            Path(self.tmp.name) / "custom-profile", {"Default": [EXTENSION_ID]}
        )

        result, calls = self.run_script(
            "--chrome-app", "Google Chrome for Testing", "--user-data-dir", str(user_data_dir)
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                [
                    "-g",
                    "-n",
                    "-a",
                    "Google Chrome for Testing",
                    "--args",
                    f"--user-data-dir={user_data_dir}",
                    "--profile-directory=Default",
                    WAKE_URL,
                ]
            ],
        )

    def test_explicit_profile_skips_detection(self) -> None:
        result, calls = self.run_script("--profile-directory", "Work")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [["-g", "-n", "-a", "Google Chrome", "--args", "--profile-directory=Work", WAKE_URL]],
        )

    def test_unknown_app_requires_user_data_dir(self) -> None:
        result, calls = self.run_script("--chrome-app", "Brave Browser")

        self.assertEqual(result.returncode, 64)
        self.assertIn("--user-data-dir", result.stderr)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
