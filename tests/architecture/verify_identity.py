#!/usr/bin/env python3
"""Verify AgentTab product, package, extension, and release coordinates."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"{path.relative_to(ROOT)} must contain an object")
    return value


def chrome_id(public_key: str) -> str:
    digest = hashlib.sha256(base64.b64decode(public_key, validate=True)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(nibble, 16)) for nibble in digest)


def verify(*, release: bool) -> None:
    identity = load_json(ROOT / "config" / "identity.json")
    trust = load_json(ROOT / "config" / "release-trust.json")
    migration = load_json(ROOT / "config" / "migration-v1.json")
    version = identity["version"]
    assert version == "2.0.0-rc.1"
    assert identity["product"] == "AgentTab"
    assert identity["nativeHost"] == "dev.agenttab.host"
    assert identity["cli"] == "agenttab"
    assert identity["environmentPrefix"] == "AGENTTAB_"
    assert identity["manifestName"] == "AgentTab"
    assert identity["packages"] == {
        "cli": "agenttab",
        "mcp": "agenttab-mcp",
        "typescript": "@getagenttab/sdk",
        "python": "agenttab",
        "omp": "@getagenttab/omp",
    }
    development = identity["developmentExtension"]
    assert chrome_id(development["publicKey"]) == development["id"]
    assert migration["tag"] == "v1.0.1"
    assert migration["nativeHost"] == "com.automation.bridge"
    assert migration["developmentExtensionId"] == "idnlffjfkgcnjfdhocemdeihhejpamkc"
    assert trust["repository"] == "wolfiesch/agenttab"
    assert trust["algorithm"] == "ed25519"

    package_expectations = {
        ROOT / "package.json": ("agenttab", version),
        ROOT / "packages" / "extension" / "package.json": ("@getagenttab/extension", version),
        ROOT / "packages" / "installer" / "package.json": (identity["packages"]["cli"], version),
        ROOT / "packages" / "mcp" / "package.json": (identity["packages"]["mcp"], version),
        ROOT / "packages" / "omp" / "package.json": (identity["packages"]["omp"], version),
        ROOT / "packages" / "sdk-typescript" / "package.json": (identity["packages"]["typescript"], version),
    }
    for path, expected in package_expectations.items():
        package = load_json(path)
        assert (package["name"], package["version"]) == expected, path.relative_to(ROOT)

    extension_manifest = load_json(ROOT / "packages" / "extension" / "src" / "manifest.json")
    assert extension_manifest["name"] == identity["manifestName"]
    assert extension_manifest["version"] == identity["chromeManifestVersion"]
    assert extension_manifest["version_name"] == version

    with (ROOT / "packages" / "sdk-python" / "pyproject.toml").open("rb") as handle:
        python_project = tomllib.load(handle)["project"]
    assert python_project["name"] == identity["packages"]["python"]
    assert python_project["version"] == "2.0.0rc1"
    with (ROOT / "host-rs" / "Cargo.toml").open("rb") as handle:
        cargo = tomllib.load(handle)
    assert cargo["workspace"]["package"]["version"] == version

    if release:
        assert identity["webStoreExtensionId"], "release requires a frozen Chrome Web Store extension ID"
        assert trust["stablePublicKeyPem"], "release requires a frozen stable artifact signing key"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    verify(release=args.release)
    print("AgentTab identity and package coordinates verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
