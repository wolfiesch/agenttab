#!/usr/bin/env python3
"""Generate small cross-language protocol catalogs from protocol/agenttab-v1.json."""

from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "protocol" / "agenttab-v1.json"
RPC_SCHEMA_ROOT = ROOT / "schemas" / "rpc" / "v1"


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def quoted(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def rust_slice(values: list[str]) -> str:
    return "&[\n" + "".join(f"    {quoted(value)},\n" for value in values) + "]"


def ts_array(values: list[str]) -> str:
    return "[\n" + "".join(f"  {quoted(value)},\n" for value in values) + "] as const"


def py_tuple(values: list[str]) -> str:
    if not values:
        return "()"
    return "(\n" + "".join(f"    {quoted(value)},\n" for value in values) + ")"


def validate_manifest(manifest: dict[str, Any]) -> None:
    expected_top = {
        "$schema",
        "schema_version",
        "rpc",
        "native",
        "outcomes",
        "rpc_methods",
        "schema_assets",
    }
    if set(manifest) != expected_top:
        raise ValueError("protocol manifest has missing or unknown top-level fields")
    if manifest["schema_version"] != 1:
        raise ValueError("unsupported protocol manifest schema_version")
    if manifest["outcomes"] != list(dict.fromkeys(manifest["outcomes"])):
        raise ValueError("outcomes must be unique")

    methods = manifest["rpc_methods"]
    if not isinstance(methods, list) or not methods:
        raise ValueError("rpc_methods must be a non-empty array")
    names: list[str] = []
    schemas: list[str] = []
    for method in methods:
        if not isinstance(method, dict) or set(method) != {
            "name",
            "mutation",
            "schema",
            "exposure",
            "description",
        }:
            raise ValueError("each rpc method must contain the canonical five fields")
        if method["exposure"] not in {"standard", "developer", "internal"}:
            raise ValueError(f"invalid exposure for {method['name']}")
        names.append(method["name"])
        schemas.append(method["schema"])
    if len(names) != len(set(names)):
        raise ValueError("rpc method names must be unique")
    if len(schemas) != len(set(schemas)):
        raise ValueError("rpc method schemas must be unique")

    for section_name in ("rpc", "native"):
        section = manifest[section_name]
        versions = section["supported_versions"]
        if (
            not isinstance(versions, list)
            or not versions
            or versions != sorted(set(versions))
            or section["version"] not in versions
        ):
            raise ValueError(f"{section_name}.supported_versions must be sorted, unique, and include version")
        features = section["features"]
        if features != sorted(set(features)):
            raise ValueError(f"{section_name}.features must be sorted and unique")
        if not section["name"] or not isinstance(section["name"], str):
            raise ValueError(f"{section_name}.name must be a non-empty string")
        if any(
            not isinstance(limit, int) or limit < 1
            for limit in section["frame_limits"].values()
        ):
            raise ValueError(f"{section_name}.frame_limits must be positive integers")
    native = manifest["native"]
    for field in ("methods", "events"):
        values = native[field]
        if not values or values != list(dict.fromkeys(values)):
            raise ValueError(f"native.{field} must be non-empty and unique")

    request = load_json(RPC_SCHEMA_ROOT / "request.schema.json")
    rpc = manifest["rpc"]
    for envelope_name in ("request", "response"):
        envelope = load_json(RPC_SCHEMA_ROOT / f"{envelope_name}.schema.json")
        if (
            envelope["properties"]["protocol"].get("const") != rpc["name"]
            or envelope["properties"]["version"].get("const") != rpc["version"]
        ):
            raise ValueError(f"{envelope_name}.schema.json protocol/version must match the manifest")
    request_methods = request["properties"]["method"]["enum"]
    if request_methods != names:
        raise ValueError("request.schema.json method order must match protocol manifest")
    mutation_branch = request["allOf"][0]["if"]["properties"]["method"]["enum"]
    mutations = [method["name"] for method in methods if method["mutation"]]
    if mutation_branch != mutations:
        raise ValueError("request.schema.json mutation methods must match protocol manifest")
    branch_refs = {
        branch["if"]["properties"]["method"]["const"]: branch["then"]["properties"]["params"]["$ref"]
        for branch in request["allOf"][1:]
    }
    if branch_refs != {method["name"]: method["schema"] for method in methods}:
        raise ValueError("request.schema.json parameter refs must match protocol manifest")

    response = load_json(RPC_SCHEMA_ROOT / "response.schema.json")
    if response["properties"]["outcome"]["enum"] != manifest["outcomes"]:
        raise ValueError("response.schema.json outcomes must match protocol manifest")
    for filename in [*manifest["schema_assets"], *schemas]:
        path = RPC_SCHEMA_ROOT / filename
        if not path.is_file():
            raise ValueError(f"missing registered RPC schema: {filename}")
        schema = load_json(path)
        expected_id = f"https://agenttab.dev/schemas/rpc/v1/{filename}"
        if schema.get("$id") != expected_id:
            raise ValueError(f"{filename} has a non-canonical $id")
    native_schema = load_json(ROOT / "schemas" / "native" / "v1" / "message.schema.json")
    native_base = native_schema["$defs"]["base"]["properties"]
    if native_base["protocol"].get("const") != native["name"]:
        raise ValueError("native message schema protocol must match the manifest")
    for branch in native_schema["oneOf"]:
        properties = branch["allOf"][-1]["properties"]
        kind = properties["kind"]["const"]
        if kind != "hello" and properties["version"].get("const") != native["version"]:
            raise ValueError(f"native {kind} schema version must match the manifest")


def render_rust(manifest: dict[str, Any]) -> str:
    rpc = manifest["rpc"]
    native = manifest["native"]
    methods = manifest["rpc_methods"]
    mutations = [method["name"] for method in methods if method["mutation"]]
    schema_names = [*manifest["schema_assets"], *[method["schema"] for method in methods]]
    assets = []
    for filename in schema_names:
        logical_name = filename.removesuffix(".schema.json").replace("-", "_")
        assets.append(
            "    (\n"
            f"        {quoted(logical_name)},\n"
            f'        include_str!("../../../../schemas/rpc/v1/{filename}"),\n'
            "    ),\n"
        )
    return "".join(
        [
            "// @generated by scripts/generate_protocol.py; do not edit.\n\n",
            f"pub const RPC_PROTOCOL: &str = {quoted(rpc['name'])};\n",
            f"pub const NATIVE_PROTOCOL: &str = {quoted(native['name'])};\n",
            f"pub const RPC_VERSION: u16 = {rpc['version']};\n",
            f"pub const NATIVE_VERSION: u16 = {native['version']};\n",
            "pub const PROTOCOL_VERSION: u16 = RPC_VERSION;\n",
            f"pub const RPC_SUPPORTED_VERSIONS: &[u16] = &{rpc['supported_versions']};\n",
            f"pub const NATIVE_SUPPORTED_VERSIONS: &[u16] = &{native['supported_versions']};\n",
            f"pub const RPC_FEATURES: &[&str] = {rust_slice(rpc['features'])};\n",
            f"pub const NATIVE_FEATURES: &[&str] = {rust_slice(native['features'])};\n",
            f"pub const RPC_METHOD_NAMES: &[&str] = {rust_slice([method['name'] for method in methods])};\n",
            f"pub const MUTATING_RPC_METHOD_NAMES: &[&str] = {rust_slice(mutations)};\n",
            f"pub const NATIVE_METHOD_NAMES: &[&str] = {rust_slice(native['methods'])};\n",
            f"pub const NATIVE_EVENT_NAMES: &[&str] = {rust_slice(native['events'])};\n",
            f"pub const OUTCOME_NAMES: &[&str] = {rust_slice(manifest['outcomes'])};\n",
            f"pub const CLIENT_TO_HOST_MAX_BYTES: usize = {rpc['frame_limits']['client_to_host']};\n",
            f"pub const HOST_TO_CLIENT_MAX_BYTES: usize = {rpc['frame_limits']['host_to_client']};\n",
            f"pub const HOST_TO_EXTENSION_MAX_BYTES: usize = {native['frame_limits']['host_to_extension']};\n",
            f"pub const EXTENSION_TO_HOST_MAX_BYTES: usize = {native['frame_limits']['extension_to_host']};\n\n",
            "pub const RPC_SCHEMA_ASSETS: &[(&str, &str)] = &[\n",
            *assets,
            "];\n\n",
            'pub const NATIVE_SCHEMA: &str = include_str!("../../../../schemas/native/v1/message.schema.json");\n',
        ]
    )


def render_sdk_ts(manifest: dict[str, Any]) -> str:
    rpc = manifest["rpc"]
    methods = manifest["rpc_methods"]
    mutations = [method["name"] for method in methods if method["mutation"]]
    metadata = {
        method["name"]: {
            "mutation": method["mutation"],
            "schema": method["schema"],
            "exposure": method["exposure"],
            "description": method["description"],
        }
        for method in methods
    }
    return "".join(
        [
            "// @generated by scripts/generate_protocol.py; do not edit.\n\n",
            f"export const RPC_PROTOCOL = {quoted(rpc['name'])} as const;\n",
            f"export const RPC_VERSION = {rpc['version']} as const;\n",
            f"export const RPC_SUPPORTED_VERSIONS = {ts_array(rpc['supported_versions'])};\n",
            f"export const RPC_FEATURES = {ts_array(rpc['features'])};\n",
            f"export const RPC_METHODS = {ts_array([method['name'] for method in methods])};\n",
            f"export const MUTATING_RPC_METHODS = {ts_array(mutations)};\n",
            f"export const OUTCOMES = {ts_array(manifest['outcomes'])};\n",
            f"export const CLIENT_TO_HOST_MAX_BYTES = {rpc['frame_limits']['client_to_host']};\n",
            f"export const HOST_TO_CLIENT_MAX_BYTES = {rpc['frame_limits']['host_to_client']};\n\n",
            "export const RPC_TOOL_METADATA = ",
            json.dumps(metadata, indent=2, ensure_ascii=False),
            " as const;\n\n",
            "export type GeneratedRpcMethod = typeof RPC_METHODS[number];\n",
            "export type GeneratedMutationMethod = typeof MUTATING_RPC_METHODS[number];\n",
            "export type GeneratedOutcome = typeof OUTCOMES[number];\n",
        ]
    )


def render_extension_ts(manifest: dict[str, Any]) -> str:
    native = manifest["native"]
    method_record = {value: True for value in native["methods"]}
    event_record = {value: True for value in native["events"]}
    return "".join(
        [
            "// @generated by scripts/generate_protocol.py; do not edit.\n\n",
            f"export const NATIVE_PROTOCOL = {quoted(native['name'])} as const;\n",
            f"export const PROTOCOL_VERSION = {native['version']} as const;\n",
            f"export const NATIVE_SUPPORTED_VERSIONS = {ts_array(native['supported_versions'])};\n",
            f"export const NATIVE_FEATURES = {ts_array(native['features'])};\n",
            f"export const OUTCOMES = {ts_array(manifest['outcomes'])};\n",
            "export const NATIVE_METHODS = ",
            json.dumps(method_record, indent=2),
            " as const;\n",
            "export const NATIVE_EVENTS = ",
            json.dumps(event_record, indent=2),
            " as const;\n\n",
            "export type NativeMethod = keyof typeof NATIVE_METHODS;\n",
            "export type NativeEventName = keyof typeof NATIVE_EVENTS;\n",
            "export type GeneratedOutcome = typeof OUTCOMES[number];\n",
        ]
    )


def render_python(manifest: dict[str, Any]) -> str:
    rpc = manifest["rpc"]
    methods = manifest["rpc_methods"]
    mutations = [method["name"] for method in methods if method["mutation"]]
    return "".join(
        [
            "# @generated by scripts/generate_protocol.py; do not edit.\n\n",
            f"RPC_PROTOCOL = {quoted(rpc['name'])}\n",
            f"RPC_VERSION = {rpc['version']}\n",
            f"RPC_SUPPORTED_VERSIONS = {py_tuple(rpc['supported_versions'])}\n",
            f"RPC_FEATURES = {py_tuple(rpc['features'])}\n",
            f"RPC_METHODS = {py_tuple([method['name'] for method in methods])}\n",
            f"MUTATIONS = frozenset({py_tuple(mutations)})\n",
            f"OUTCOMES = {py_tuple(manifest['outcomes'])}\n",
            f"CLIENT_TO_HOST_MAX_BYTES = {rpc['frame_limits']['client_to_host']}\n",
            f"HOST_TO_CLIENT_MAX_BYTES = {rpc['frame_limits']['host_to_client']}\n",
        ]
    )


def outputs(manifest: dict[str, Any]) -> dict[Path, str]:
    return {
        ROOT / "host-rs" / "crates" / "agenttab-protocol" / "src" / "generated.rs": render_rust(manifest),
        ROOT / "packages" / "sdk-typescript" / "src" / "generated" / "protocol.ts": render_sdk_ts(manifest),
        ROOT / "packages" / "extension" / "src" / "generated" / "protocol.ts": render_extension_ts(manifest),
        ROOT / "packages" / "sdk-python" / "agenttab" / "_generated_protocol.py": render_python(manifest),
    }


def check(rendered: dict[Path, str]) -> int:
    changed = False
    for path, expected in rendered.items():
        actual = path.read_text(encoding="utf-8") if path.exists() else ""
        if actual == expected:
            continue
        changed = True
        print(f"generated protocol artifact is stale: {path.relative_to(ROOT)}", file=sys.stderr)
        diff = difflib.unified_diff(
            actual.splitlines(),
            expected.splitlines(),
            fromfile=str(path.relative_to(ROOT)),
            tofile=f"generated:{path.relative_to(ROOT)}",
            lineterm="",
        )
        for line in list(diff)[:80]:
            print(line, file=sys.stderr)
    if changed:
        print("run: python3 scripts/generate_protocol.py", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail instead of updating stale generated files")
    args = parser.parse_args()
    try:
        manifest = load_json(MANIFEST_PATH)
        validate_manifest(manifest)
        rendered = outputs(manifest)
        if args.check:
            return check(rendered)
        for path, content in rendered.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            print(path.relative_to(ROOT))
        return 0
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"protocol generation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
