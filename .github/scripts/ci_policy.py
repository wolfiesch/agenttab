#!/usr/bin/env python3
"""Fail-closed policy for selecting the lightweight CI verification lane."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import sys
from typing import Iterable, Sequence


FAST_LANE = "fast"
FULL_LANE = "full"

_SHA_PATTERN = re.compile(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\Z")
_GITHUB_TOKEN_PATTERN = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b"
)
_SLACK_TOKEN_PATTERN = re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")
_AWS_ACCESS_KEY_PATTERN = re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")
_OPENAI_KEY_PATTERN = re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")
_PRIVATE_KEY_PATTERN = re.compile(
    r"-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY|"
    r"ENCRYPTED PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----"
)
_HOME_PATH_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_.-])/(?:Users|home)/[A-Za-z0-9][A-Za-z0-9_.-]*(?:/|\b)"
)
_OMP_SESSION_PATTERN = re.compile(
    r"\bomp[-_](?:session|task|agent)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}\b",
    re.IGNORECASE,
)
_OMP_SESSION_ASSIGNMENT_PATTERN = re.compile(
    r"\bomp_(?:session|task|agent)_id\s*(?:=|:)\s*[\"']?[A-Za-z0-9_-]{8,}\b",
    re.IGNORECASE,
)
_OMP_UUID_PATTERN = re.compile(
    r"\b01a[0-9a-f]{5}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
_PRIVATE_HOST_MARKERS = (
    "hostinger" + "-devbox",
    "wolfie" + "-vps",
    "contabo" + "-vps",
    "m1" + "-worker",
)
_PRIVATE_HOST_PATTERN = re.compile(
    r"(?i)(?<![A-Za-z0-9])(?:"
    + "|".join(re.escape(marker) for marker in _PRIVATE_HOST_MARKERS)
    + r")(?![A-Za-z0-9])"
)
_CREDENTIAL_ASSIGNMENT_PATTERN = re.compile(
    r"""(?ix)
    (?<![A-Za-z0-9])(?P<key_quote>["'])?(?:[A-Za-z0-9]+[_-])*(?:
        api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|
        client[_-]?secret|secret(?:[_-]?key)?|password|private[_-]?key
    )\b
    (?(key_quote)(?P=key_quote))
    \s*(?:=|:)\s*["']?
    (?P<value>[A-Za-z0-9][A-Za-z0-9._~+/=-]{19,})
    """
)
_PLACEHOLDER_MARKERS = ("example", "placeholder", "replace", "changeme", "your-")


class PolicyError(RuntimeError):
    """A comparison range that cannot be evaluated safely."""


@dataclass(frozen=True)
class Classification:
    lane: str
    reason: str


@dataclass(frozen=True)
class Finding:
    kind: str
    diff_line: int


def is_fast_path(path: str) -> bool:
    """Return whether one repository-relative path is safe for the fast lane."""
    if path in {"README.md", "CHANGELOG.md", "LICENSE"}:
        return True
    if path.startswith("docs/") and Path(path).suffix.lower() in {".md", ".rst", ".txt"}:
        return True
    return path.startswith(".github/") and "/" not in path[len(".github/") :] and path.endswith(
        ".md"
    )


def classify_paths(paths: Iterable[str]) -> Classification:
    """Classify changed paths; any unknown, empty, or malformed input is full."""
    materialized = tuple(paths)
    if not materialized:
        return Classification(FULL_LANE, "empty-range")

    for path in materialized:
        if (
            not path
            or path.startswith("/")
            or path.startswith("../")
            or "\x00" in path
            or "\n" in path
            or "\r" in path
        ):
            return Classification(FULL_LANE, "ambiguous-path")
        if not is_fast_path(path):
            return Classification(FULL_LANE, "full-path")

    return Classification(FAST_LANE, "docs-only")


def _validate_sha(sha: str) -> None:
    if not _SHA_PATTERN.fullmatch(sha) or set(sha) == {"0"}:
        raise PolicyError("comparison SHA is invalid")


def _git_output(repo: Path, arguments: Sequence[str]) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(repo), *arguments],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise PolicyError("git could not be executed") from error

    if completed.returncode != 0:
        raise PolicyError("git could not resolve the comparison range")
    return completed.stdout.decode("utf-8", errors="surrogateescape")


def changed_paths(base: str, head: str, repo: Path = Path(".")) -> tuple[str, ...]:
    """Read paths from an explicit, unambiguous commit range."""
    _validate_sha(base)
    _validate_sha(head)
    repo = repo.resolve()
    _git_output(repo, ["rev-parse", "--verify", f"{base}^{{commit}}"])
    _git_output(repo, ["rev-parse", "--verify", f"{head}^{{commit}}"])
    raw_paths = _git_output(
        repo, ["diff", "--no-ext-diff", "--name-only", "-z", "--no-renames", base, head]
    )
    return tuple(path for path in raw_paths.split("\0") if path)


def classify_changed_range(base: str, head: str, repo: Path = Path(".")) -> Classification:
    """Fail closed to full when the explicit range cannot be classified."""
    try:
        return classify_paths(changed_paths(base, head, repo))
    except Exception:
        return Classification(FULL_LANE, "range-error")


def added_lines(diff: str) -> Iterable[tuple[int, str]]:
    """Yield only added content lines, excluding unified-diff metadata."""
    in_hunk = False
    for diff_line, line in enumerate(diff.splitlines(), start=1):
        if line.startswith("diff --git "):
            in_hunk = False
            continue
        if line.startswith("@@ "):
            in_hunk = True
            continue
        if in_hunk and line.startswith("+"):
            yield diff_line, line[1:]


def _has_credential_assignment(line: str) -> bool:
    for match in _CREDENTIAL_ASSIGNMENT_PATTERN.finditer(line):
        value = match.group("value").lower()
        if not any(marker in value for marker in _PLACEHOLDER_MARKERS):
            return True
    return False


def scan_added_diff(diff: str) -> tuple[Finding, ...]:
    """Find sensitive public text in added diff content without echoing it."""
    findings: list[Finding] = []
    patterns = (
        ("github-token", _GITHUB_TOKEN_PATTERN),
        ("slack-token", _SLACK_TOKEN_PATTERN),
        ("aws-access-key", _AWS_ACCESS_KEY_PATTERN),
        ("openai-api-key", _OPENAI_KEY_PATTERN),
        ("private-key", _PRIVATE_KEY_PATTERN),
        ("absolute-home-path", _HOME_PATH_PATTERN),
        ("omp-session-id", _OMP_SESSION_PATTERN),
        ("omp-session-id", _OMP_SESSION_ASSIGNMENT_PATTERN),
        ("omp-session-id", _OMP_UUID_PATTERN),
        ("private-host", _PRIVATE_HOST_PATTERN),
    )
    for diff_line, line in added_lines(diff):
        for kind, pattern in patterns:
            if pattern.search(line):
                findings.append(Finding(kind, diff_line))
        if _has_credential_assignment(line):
            findings.append(Finding("credential-assignment", diff_line))
    return tuple(findings)


def scan_changed_range(base: str, head: str, repo: Path = Path(".")) -> tuple[Finding, ...]:
    """Scan only added content from an explicit range."""
    _validate_sha(base)
    _validate_sha(head)
    repo = repo.resolve()
    _git_output(repo, ["rev-parse", "--verify", f"{base}^{{commit}}"])
    _git_output(repo, ["rev-parse", "--verify", f"{head}^{{commit}}"])
    diff = _git_output(
        repo,
        [
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--text",
            "--unified=0",
            "--no-renames",
            base,
            head,
        ],
    )
    return scan_added_diff(diff)


def write_github_output(path: Path, classification: Classification) -> None:
    """Publish a fixed-format lane selection for a GitHub Actions step."""
    with path.open("a", encoding="utf-8") as output:
        output.write(f"lane={classification.lane}\n")
        output.write(f"reason={classification.reason}\n")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="explicit base commit SHA")
    parser.add_argument("--head", required=True, help="explicit head commit SHA")
    parser.add_argument("--repo", type=Path, default=Path("."), help="repository root")
    parser.add_argument(
        "--github-output", type=Path, default=None, help="optional GitHub Actions output file"
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    classification = classify_changed_range(args.base, args.head, args.repo)

    try:
        findings = scan_changed_range(args.base, args.head, args.repo)
    except Exception as error:
        classification = Classification(FULL_LANE, "scan-error")
        if args.github_output is not None:
            write_github_output(args.github_output, classification)
        else:
            print(classification.lane)
        print(f"public-text scan failed closed: {error}", file=sys.stderr)
        return 1

    if args.github_output is not None:
        write_github_output(args.github_output, classification)
    else:
        print(classification.lane)

    if findings:
        descriptions = ", ".join(
            f"{finding.kind} at diff line {finding.diff_line}" for finding in findings
        )
        print(f"public-text scan found sensitive content: {descriptions}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
