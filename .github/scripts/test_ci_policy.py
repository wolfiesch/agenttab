#!/usr/bin/env python3
"""Direct tests for the CI lane policy and public-text scanner."""

from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import ci_policy


def run_git(repo: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return completed.stdout.strip()


class PathClassificationTests(unittest.TestCase):
    def test_each_allowlisted_category_uses_fast_lane(self) -> None:
        cases = {
            "readme": ("README.md",),
            "changelog": ("CHANGELOG.md",),
            "license": ("LICENSE",),
            "docs": ("docs/operations/runbook.txt",),
            "github-markdown": (".github/pull_request_template.md",),
        }
        for category, paths in cases.items():
            with self.subTest(category=category):
                self.assertEqual(ci_policy.classify_paths(paths).lane, ci_policy.FAST_LANE)

    def test_mixed_paths_use_full_lane(self) -> None:
        result = ci_policy.classify_paths(("README.md", "src/main.rs"))
        self.assertEqual(result.lane, ci_policy.FULL_LANE)

    def test_unknown_source_manifest_workflow_and_policy_paths_use_full_lane(self) -> None:
        sensitive_paths = (
            "src/lib.rs",
            "Cargo.toml",
            "Cargo.lock",
            ".github/workflows/ci.yml",
            ".github/scripts/ci_policy.py",
            ".github/nested/guide.md",
            "notes.txt",
            "docs/migration/_compat_spec.py",
            "docs/contracts/runtime.json",
        )
        for path in sensitive_paths:
            with self.subTest(path=path):
                self.assertEqual(ci_policy.classify_paths((path,)).lane, ci_policy.FULL_LANE)

    def test_empty_paths_fail_closed_to_full(self) -> None:
        self.assertEqual(ci_policy.classify_paths(()).lane, ci_policy.FULL_LANE)

    def test_invalid_zero_sha_fails_closed_to_full(self) -> None:
        result = ci_policy.classify_changed_range("0" * 40, "a" * 40)
        self.assertEqual(result.lane, ci_policy.FULL_LANE)
        self.assertEqual(result.reason, "range-error")

    def test_noncanonical_sha_length_fails_closed_to_full(self) -> None:
        result = ci_policy.classify_changed_range("a" * 48, "b" * 48)
        self.assertEqual(result.lane, ci_policy.FULL_LANE)
        self.assertEqual(result.reason, "range-error")

    def test_git_error_fails_closed_to_full(self) -> None:
        with mock.patch.object(ci_policy, "changed_paths", side_effect=ci_policy.PolicyError("bad range")):
            result = ci_policy.classify_changed_range("a" * 40, "b" * 40)
        self.assertEqual(result.lane, ci_policy.FULL_LANE)
        self.assertEqual(result.reason, "range-error")


class PublicTextScannerTests(unittest.TestCase):
    def test_scans_high_confidence_sensitive_added_content(self) -> None:
        github_token = "ghp_" + "a" * 36
        private_key_header = "-" * 5 + "BEGIN PRIVATE KEY" + "-" * 5
        home_path = "/" + "Users" + "/alice/.ssh/id_ed25519"
        omp_session = "omp-" + "session-" + "deadbeefcafebabe"
        omp_uuid = "01a059fe" + "-94e4-7000-b1a6-b0bd935219c3"
        private_host = "https://" + "hostinger" + "-devbox"
        generic_credential = "API_KEY=" + "A" * 24
        sensitive_value = "ThisIsARealSecretValue123"
        prefixed_key = "DATABASE_" + "PASSWORD"
        diff = "\n".join(
            (
                "diff --git a/README.md b/README.md",
                "+++ b/README.md",
                "@@ -0,0 +1,8 @@",
                "+token=" + github_token,
                "+" + private_key_header,
                "+path=" + home_path,
                "+session=" + omp_session,
                "+session-url=history://" + omp_uuid,
                "+endpoint=" + private_host,
                "+" + generic_credential,
                f"+{prefixed_key}={sensitive_value}",
            )
        )

        kinds = {finding.kind for finding in ci_policy.scan_added_diff(diff)}
        self.assertTrue(
            {
                "github-token",
                "private-key",
                "absolute-home-path",
                "omp-session-id",
                "private-host",
                "credential-assignment",
            }.issubset(kinds)
        )

    def test_scans_quoted_credential_keys(self) -> None:
        key = "API_" + "KEY"
        sensitive_value = "ThisIsARealSecretValue123"
        for quote in ('"', "'"):
            with self.subTest(quote=quote):
                diff = "\n".join(
                    (
                        "diff --git a/docs/config.md b/docs/config.md",
                        "+++ b/docs/config.md",
                        "@@ -0,0 +1 @@",
                        f"+{quote}{key}{quote}: {quote}{sensitive_value}{quote}",
                    )
                )

                kinds = {finding.kind for finding in ci_policy.scan_added_diff(diff)}
                self.assertIn("credential-assignment", kinds)

    def test_scans_private_hosts_inside_domain_names(self) -> None:
        private_host = "hostinger" + "-devbox"
        diff = "\n".join(
            (
                "diff --git a/docs/hosts.md b/docs/hosts.md",
                "+++ b/docs/hosts.md",
                "@@ -0,0 +1,2 @@",
                f"+host={private_host}.local",
                f"+host=worker.{private_host}.example",
            )
        )

        findings = ci_policy.scan_added_diff(diff)
        self.assertEqual(sum(finding.kind == "private-host" for finding in findings), 2)

    def test_scans_encrypted_and_pgp_private_key_headers(self) -> None:
        for label in ("ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"):
            with self.subTest(label=label):
                header = "-" * 5 + "BEGIN " + label + "-" * 5
                diff = "\n".join(
                    (
                        "diff --git a/docs/key.md b/docs/key.md",
                        "+++ b/docs/key.md",
                        "@@ -0,0 +1 @@",
                        "+" + header,
                    )
                )

                kinds = {finding.kind for finding in ci_policy.scan_added_diff(diff)}
                self.assertIn("private-key", kinds)

    def test_forces_binary_marked_files_through_text_scanner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            run_git(repo, "init", "--quiet")
            run_git(repo, "config", "user.name", "CI Policy Test")
            run_git(repo, "config", "user.email", "ci-policy@example.invalid")
            (repo / "README.md").write_text("baseline\n", encoding="utf-8")
            run_git(repo, "add", "README.md")
            run_git(repo, "commit", "--quiet", "-m", "baseline")
            base = run_git(repo, "rev-parse", "HEAD")

            (repo / "docs").mkdir()
            (repo / ".gitattributes").write_text("docs/*.md -text\n", encoding="utf-8")
            token = ("ghp_" + "a" * 36).encode()
            (repo / "docs" / "binary.md").write_bytes(b"\0token=" + token + b"\n")
            run_git(repo, "add", ".gitattributes", "docs/binary.md")
            run_git(repo, "commit", "--quiet", "-m", "binary fixture")
            head = run_git(repo, "rev-parse", "HEAD")

            kinds = {finding.kind for finding in ci_policy.scan_changed_range(base, head, repo)}
            self.assertIn("github-token", kinds)

    def test_ignores_metadata_and_safe_placeholders(self) -> None:
        diff = "\n".join(
            (
                "diff --git a/docs/example.md b/docs/example.md",
                "+++ /" + "Users" + "/alice/docs/example.md",
                "@@ -0,0 +1,4 @@",
                "+API_KEY=replace-me",
                "+Use ~/project rather than an absolute home path.",
                "+The sk- prefix is documented without a credential value.",
                "+hostinger is a hosting provider name, not a private hostname.",
                "+https://hooks.wolfie.gg is a public endpoint.",
            )
        )
        self.assertEqual(ci_policy.scan_added_diff(diff), ())


if __name__ == "__main__":
    unittest.main()
