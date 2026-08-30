#!/usr/bin/env python3
"""Verify that every shipped AgentTab version matches one release tag."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path
from typing import Any

SEMVER = re.compile(
    r"^(?P<base>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)\.(?P<patch>0|[1-9][0-9]*)(?:-(?P<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
PYTHON_PRE_RELEASE = re.compile(r"^(?P<kind>a|alpha|b|beta|rc)[.-]?(?P<number>[0-9]+)$", re.IGNORECASE)
PACKAGE_MANIFESTS = {
    "packages/extension/package.json": "@getagenttab/extension",
    "packages/sdk-typescript/package.json": "@getagenttab/sdk",
    "packages/mcp/package.json": "agenttab-mcp",
    "packages/omp/package.json": "@getagenttab/omp",
    "packages/installer/package.json": "agenttab",
}
EXTENSION_MANIFESTS = (
    "packages/extension/src/manifest.json",
)
RUST_PACKAGES = {
    "host-rs/crates/agenttab-host/Cargo.toml": "agenttab-host",
    "host-rs/crates/agenttab-protocol/Cargo.toml": "agenttab-protocol",
}


class IdentityError(Exception):
    """Raised when a release identity is inconsistent."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify AgentTab release identity against an annotated tag")
    parser.add_argument("--tag", required=True, help="Release tag in vX.Y.Z or vX.Y.Z-prerelease form")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--json", action="store_true", help="Print the validated identity as JSON")
    return parser.parse_args(argv)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IdentityError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise IdentityError(f"{path} must contain a JSON object")
    return value


def load_toml(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as handle:
            value = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise IdentityError(f"cannot read TOML {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise IdentityError(f"{path} must contain a TOML table")
    return value


def version_from_tag(tag: str) -> tuple[str, str, str]:
    if not tag.startswith("v"):
        raise IdentityError("release tag must begin with v")
    version = tag[1:]
    match = SEMVER.fullmatch(version)
    if not match:
        raise IdentityError("release tag must be an exact semantic version without build metadata")
    base = f"{match.group('base')}.{match.group('minor')}.{match.group('patch')}"
    pre = match.group("pre")
    if pre is None:
        return version, base, base
    python_match = PYTHON_PRE_RELEASE.fullmatch(pre)
    if python_match is None:
        raise IdentityError(
            "pre-release tag must use a Python-compatible a, alpha, b, beta, or rc identifier with a number",
        )
    kind = python_match.group("kind").lower()
    python_kind = {"alpha": "a", "beta": "b"}.get(kind, kind)
    return version, base, f"{base}{python_kind}{python_match.group('number')}"


def expect(errors: list[str], actual: object, expected: object, path: str) -> None:
    if actual != expected:
        errors.append(f"{path} is {actual!r}; expected {expected!r}")


def require_table(errors: list[str], value: object, path: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    errors.append(f"{path} must be an object")
    return {}


def verify(root: Path, tag: str) -> dict[str, str]:
    version, chrome_version, python_version = version_from_tag(tag)
    errors: list[str] = []

    root_package = load_json(root / "package.json")
    expect(errors, root_package.get("name"), "agenttab", "package.json:name")
    expect(errors, root_package.get("version"), version, "package.json:version")

    identity = load_json(root / "config" / "identity.json")
    expect(errors, identity.get("version"), version, "config/identity.json:version")
    expect(errors, identity.get("chromeManifestVersion"), chrome_version, "config/identity.json:chromeManifestVersion")
    packages = require_table(errors, identity.get("packages"), "config/identity.json:packages")
    for key, expected in {
        "cli": "agenttab",
        "mcp": "agenttab-mcp",
        "typescript": "@getagenttab/sdk",
        "python": "agenttab",
        "omp": "@getagenttab/omp",
    }.items():
        expect(errors, packages.get(key), expected, f"config/identity.json:packages.{key}")

    for relative, expected_name in PACKAGE_MANIFESTS.items():
        manifest = load_json(root / relative)
        expect(errors, manifest.get("name"), expected_name, f"{relative}:name")
        expect(errors, manifest.get("version"), version, f"{relative}:version")

    for relative in EXTENSION_MANIFESTS:
        manifest = load_json(root / relative)
        expect(errors, manifest.get("name"), "AgentTab", f"{relative}:name")
        expect(errors, manifest.get("version"), chrome_version, f"{relative}:version")
        expect(errors, manifest.get("version_name"), version, f"{relative}:version_name")

    python_project = load_toml(root / "packages" / "sdk-python" / "pyproject.toml").get("project")
    python_project = require_table(errors, python_project, "packages/sdk-python/pyproject.toml:project")
    expect(errors, python_project.get("name"), "agenttab", "packages/sdk-python/pyproject.toml:project.name")
    expect(errors, python_project.get("version"), python_version, "packages/sdk-python/pyproject.toml:project.version")

    workspace = load_toml(root / "host-rs" / "Cargo.toml")
    workspace_table = require_table(errors, workspace.get("workspace"), "host-rs/Cargo.toml:workspace")
    workspace_package = require_table(errors, workspace_table.get("package"), "host-rs/Cargo.toml:workspace.package")
    expect(errors, workspace_package.get("version"), version, "host-rs/Cargo.toml:workspace.package.version")
    expect(errors, workspace_package.get("license"), "MIT", "host-rs/Cargo.toml:workspace.package.license")

    for relative, expected_name in RUST_PACKAGES.items():
        cargo = load_toml(root / relative)
        package = require_table(errors, cargo.get("package"), f"{relative}:package")
        expect(errors, package.get("name"), expected_name, f"{relative}:package.name")
        version_field = require_table(errors, package.get("version"), f"{relative}:package.version")
        expect(errors, version_field.get("workspace"), True, f"{relative}:package.version.workspace")
        license_field = require_table(errors, package.get("license"), f"{relative}:package.license")
        expect(errors, license_field.get("workspace"), True, f"{relative}:package.license.workspace")

    if errors:
        raise IdentityError("\n".join(errors))
    return {
        "tag": tag,
        "version": version,
        "chrome_version": chrome_version,
        "python_version": python_version,
        "prerelease": str("-" in version).lower(),
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        identity = verify(args.root.resolve(), args.tag)
    except IdentityError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(identity, sort_keys=True))
    else:
        print(f"Release identity verified for {identity['tag']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
