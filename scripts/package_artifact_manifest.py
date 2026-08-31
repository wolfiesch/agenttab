#!/usr/bin/env python3
"""Assemble immutable release assets, a complete SPDX SBOM, and SHA256SUMS."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tomllib
from hashlib import sha256
from pathlib import Path
from typing import Any

try:
    from .verify_release_identity import IdentityError, version_from_tag
except ImportError:
    from verify_release_identity import IdentityError, version_from_tag

HOST_TARGETS = (
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
)

PLATFORM_SIGNATURES = {
    "aarch64-apple-darwin": "apple_code_signing",
    "x86_64-apple-darwin": "apple_code_signing",
    "aarch64-unknown-linux-gnu": "signed_manifest",
    "x86_64-unknown-linux-gnu": "signed_manifest",
    "x86_64-pc-windows-msvc": "authenticode",
}


class PackagingError(Exception):
    """Raised when an assembled release would be incomplete or ambiguous."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Assemble the deterministic AgentTab release asset set")
    parser.add_argument("--tag", required=True, help="Release tag in vX.Y.Z or vX.Y.Z-prerelease form")
    parser.add_argument("--input-dir", required=True, type=Path, help="Directory containing built release assets")
    parser.add_argument("--out-dir", required=True, type=Path, help="Empty destination directory")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    return parser.parse_args(argv)


def expected_assets(version: str, python_version: str) -> list[str]:
    hosts = [
        f"agenttab-host-v{version}-{target}.{'zip' if target.endswith('windows-msvc') else 'tar.gz'}"
        for target in HOST_TARGETS
    ]
    return hosts + [
        f"agenttab-extension-v{version}.zip",
        f"agenttab-sdk-{version}.tgz",
        f"agenttab-mcp-{version}.tgz",
        f"agenttab-omp-{version}.tgz",
        f"agenttab-gpt-control-driver-{version}.tgz",
        f"agenttab-{version}.tgz",
        f"agenttab-{python_version}-py3-none-any.whl",
        f"agenttab-{python_version}.tar.gz",
    ]


def digest(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    return {"name": path.name, "bytes": len(data), "sha256": sha256(data).hexdigest()}


def build_artifact_manifest(
    root: Path,
    tag: str,
    version: str,
    artifacts: list[dict[str, object]],
) -> dict[str, object]:
    try:
        trust = json.loads((root / "config" / "release-trust.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PackagingError(f"cannot read config/release-trust.json: {exc}") from exc
    repository = trust.get("repository") if isinstance(trust, dict) else None
    if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise PackagingError("config/release-trust.json repository must be an owner/name coordinate")
    by_name = {str(entry["name"]): entry for entry in artifacts}
    hosts = []
    for target in HOST_TARGETS:
        name = f"agenttab-host-v{version}-{target}.{'zip' if target.endswith('windows-msvc') else 'tar.gz'}"
        entry = by_name[name]
        hosts.append({
            "name": name,
            "kind": "host",
            "target": target,
            "sha256": entry["sha256"],
            "bytes": entry["bytes"],
            "platformSignature": PLATFORM_SIGNATURES[target],
            "url": f"https://github.com/{repository}/releases/download/{tag}/{name}",
        })
    return {
        "schemaVersion": 1,
        "repository": repository,
        "version": version,
        "tag": tag,
        "assets": hosts,
    }


def safe_spdx_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9.-]+", "-", value).strip("-") or "artifact"


def artifact_package(entry: dict[str, object]) -> dict[str, object]:
    name = str(entry["name"])
    return {
        "SPDXID": f"SPDXRef-Artifact-{safe_spdx_id(name)}",
        "name": name,
        "versionInfo": "NOASSERTION",
        "downloadLocation": "NOASSERTION",
        "filesAnalyzed": False,
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": "NOASSERTION",
        "copyrightText": "NOASSERTION",
        "checksums": [{"algorithm": "SHA256", "checksumValue": entry["sha256"]}],
    }


def cargo_package(entry: dict[str, Any], index: int) -> dict[str, object]:
    name = entry.get("name")
    version = entry.get("version")
    if not isinstance(name, str) or not isinstance(version, str):
        raise PackagingError("host-rs/Cargo.lock contains a package without name and version")
    return {
        "SPDXID": f"SPDXRef-Cargo-{index}-{safe_spdx_id(name)}",
        "name": name,
        "versionInfo": version,
        "downloadLocation": str(entry.get("source", "NOASSERTION")),
        "filesAnalyzed": False,
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": "NOASSERTION",
        "copyrightText": "NOASSERTION",
    }


def build_sbom(root: Path, tag: str, version: str, artifacts: list[dict[str, object]]) -> dict[str, object]:
    try:
        with (root / "host-rs" / "Cargo.lock").open("rb") as handle:
            cargo_lock = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise PackagingError(f"cannot read host-rs/Cargo.lock: {exc}") from exc
    cargo_entries = cargo_lock.get("package")
    if not isinstance(cargo_entries, list):
        raise PackagingError("host-rs/Cargo.lock must contain package entries")

    release_package = {
        "SPDXID": "SPDXRef-Package-AgentTab",
        "name": "AgentTab",
        "versionInfo": version,
        "downloadLocation": f"https://github.com/wolfiesch/agenttab/releases/tag/{tag}",
        "filesAnalyzed": False,
        "licenseConcluded": "MIT",
        "licenseDeclared": "MIT",
        "copyrightText": "NOASSERTION",
    }
    packages = [release_package]
    packages.extend(artifact_package(entry) for entry in artifacts)
    packages.extend(cargo_package(entry, index) for index, entry in enumerate(cargo_entries, start=1))
    relationships = [{
        "spdxElementId": "SPDXRef-DOCUMENT",
        "relationshipType": "DESCRIBES",
        "relatedSpdxElement": "SPDXRef-Package-AgentTab",
    }]
    relationships.extend({
        "spdxElementId": "SPDXRef-Package-AgentTab",
        "relationshipType": "CONTAINS",
        "relatedSpdxElement": package["SPDXID"],
    } for package in packages[1:])
    return {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"AgentTab-{version}",
        "documentNamespace": f"https://github.com/wolfiesch/agenttab/releases/tag/{tag}#sbom",
        "creationInfo": {
            "created": "1970-01-01T00:00:00Z",
            "creators": ["Organization: AgentTab"],
        },
        "packages": packages,
        "relationships": relationships,
    }


def write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")


def assemble(root: Path, tag: str, input_dir: Path, out_dir: Path) -> list[dict[str, object]]:
    try:
        version, _, python_version = version_from_tag(tag)
    except IdentityError as exc:
        raise PackagingError(str(exc)) from exc
    if not input_dir.is_dir():
        raise PackagingError(f"input directory does not exist: {input_dir}")
    if out_dir.exists() and any(out_dir.iterdir()):
        raise PackagingError(f"refusing to replace existing release directory: {out_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)

    primary_names = expected_assets(version, python_version)
    missing = [name for name in primary_names if not (input_dir / name).is_file()]
    if missing:
        raise PackagingError(f"missing required release assets: {', '.join(missing)}")
    entries = list(input_dir.iterdir())
    non_files = sorted(path.name for path in entries if not path.is_file())
    unexpected = sorted(path.name for path in entries if path.is_file() and path.name not in primary_names)
    if non_files or unexpected:
        names = non_files + unexpected
        raise PackagingError(f"unlisted release inputs are forbidden: {', '.join(names)}")
    for name in primary_names:
        shutil.copyfile(input_dir / name, out_dir / name)

    primary = [digest(out_dir / name) for name in primary_names]
    artifact_manifest_name = "artifact-manifest.json"
    write_json(
        out_dir / artifact_manifest_name,
        build_artifact_manifest(root, tag, version, primary),
    )
    sbom_name = f"agenttab-v{version}-sbom.spdx.json"
    write_json(out_dir / sbom_name, build_sbom(root, tag, version, primary))
    inventory_name = "release-inventory.json"
    inventory = {
        "schemaVersion": 1,
        "tag": tag,
        "version": version,
        "artifacts": primary
        + [
            digest(out_dir / artifact_manifest_name),
            digest(out_dir / sbom_name),
        ],
    }
    write_json(out_dir / inventory_name, inventory)

    checksum_names = primary_names + [artifact_manifest_name, sbom_name, inventory_name]
    checksums = [digest(out_dir / name) for name in checksum_names]
    (out_dir / "SHA256SUMS").write_text(
        "".join(f"{entry['sha256']}  {entry['name']}\n" for entry in checksums),
        encoding="utf-8",
    )
    return checksums


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        entries = assemble(args.root.resolve(), args.tag, args.input_dir.resolve(), args.out_dir.resolve())
    except PackagingError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"assets": entries, "sha256sums": "SHA256SUMS"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
