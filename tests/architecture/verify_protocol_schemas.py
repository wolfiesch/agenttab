#!/usr/bin/env python3
"""Validate AgentTab protocol schemas and representative Core RPC messages."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_ROOT = ROOT / "schemas"
RPC_ROOT = SCHEMA_ROOT / "rpc" / "v1"

NATIVE_ROOT = SCHEMA_ROOT / "native" / "v1"

def load_schemas() -> tuple[dict[Path, dict], Registry]:
    schemas: dict[Path, dict] = {}
    resources: list[tuple[str, Resource]] = []
    identifiers: set[str] = set()
    for path in sorted(SCHEMA_ROOT.rglob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        identifier = schema.get("$id")
        if not isinstance(identifier, str) or not identifier.startswith(
            "https://agenttab.dev/schemas/"
        ):
            raise ValueError(f"{path}: missing canonical AgentTab $id")
        if identifier in identifiers:
            raise ValueError(f"duplicate schema $id: {identifier}")
        identifiers.add(identifier)
        schemas[path] = schema
        resources.append((identifier, Resource.from_contents(schema)))
    if not schemas:
        raise ValueError("no AgentTab protocol schemas found")
    return schemas, Registry().with_resources(resources)


def validator(path: Path, schemas: dict[Path, dict], registry: Registry) -> Draft202012Validator:
    return Draft202012Validator(
        schemas[path],
        registry=registry,
        format_checker=FormatChecker(),
    )


def expect_invalid(schema_validator: Draft202012Validator, value: object, label: str) -> None:
    try:
        schema_validator.validate(value)
    except ValidationError:
        return
    raise AssertionError(f"{label}: schema unexpectedly accepted invalid message")


def core_request(method: str, params: dict, *, mutation: bool) -> dict:
    request = {
        "protocol": "agenttab.rpc",
        "version": 1,
        "request_id": f"verify-{method}",
        "method": method,
        "params": params,
    }
    if mutation:
        request["idempotency_key"] = "018f47a0-7b10-7abc-8def-0123456789ab"
    return request


def verify_core_messages(schemas: dict[Path, dict], registry: Registry) -> int:
    request_validator = validator(RPC_ROOT / "request.schema.json", schemas, registry)
    response_validator = validator(RPC_ROOT / "response.schema.json", schemas, registry)
    connection_validator = validator(RPC_ROOT / "connection.schema.json", schemas, registry)

    requests = [
        core_request("agenttab.status", {}, mutation=False),
        core_request("browser_open", {"mode": "create", "background": True}, mutation=True),
        core_request(
            "browser_snapshot",
            {"tab_id": 1, "mode": "accessibility", "max_nodes": 100},
            mutation=False,
        ),
        core_request(
            "browser_snapshot",
            {
                "tab_id": 1,
                "mode": "screenshot",
                "format": "webp",
                "quality": 72,
                "max_width": 1280,
                "max_height": 720,
                "max_bytes": 500_000,
            },
            mutation=False,
        ),
        core_request(
            "browser_act",
            {
                "tab_id": 1,
                "expected_page_revision": 2,
                "actions": [{"kind": "click", "ref": "e7"}],
            },
            mutation=True,
        ),
        core_request(
            "browser_wait",
            {"tab_id": 1, "condition": {"kind": "load"}, "timeout_ms": 30_000},
            mutation=False,
        ),
        core_request("browser_tabs", {}, mutation=False),
        core_request(
            "browser_handoff",
            {
                "tab_id": 1,
                "expected_page_revision": 2,
                "prompt": "Complete sign-in, then choose Done.",
                "completion": {"kind": "manual_done"},
            },
            mutation=True,
        ),
        core_request(
            "browser_commit",
            {"staged_token": "t" * 32},
            mutation=True,
        ),
        core_request(
            "browser_developer",
            {"action": "inspect_runtime", "params": {}},
            mutation=True,
        ),
    ]
    for request in requests:
        request_validator.validate(request)

    missing_key = core_request(
        "browser_act",
        {
            "tab_id": 1,
            "expected_page_revision": 2,
            "actions": [{"kind": "click", "ref": "e7"}],
        },
        mutation=False,
    )
    expect_invalid(request_validator, missing_key, "mutation idempotency")
    forbidden_viewport = core_request(
        "browser_act",
        {
            "tab_id": 1,
            "expected_page_revision": 2,
            "actions": [{"kind": "set_viewport", "width": 1280, "height": 720}],
        },
        mutation=True,
    )
    expect_invalid(request_validator, forbidden_viewport, "Standard browser-global action")
    invalid_screenshot_quality = core_request(
        "browser_snapshot",
        {"tab_id": 1, "mode": "screenshot", "format": "png", "quality": 80},
        mutation=False,
    )
    expect_invalid(
        request_validator,
        invalid_screenshot_quality,
        "PNG screenshot quality",
    )
    oversized_screenshot = core_request(
        "browser_snapshot",
        {"tab_id": 1, "mode": "screenshot", "max_bytes": 750_001},
        mutation=False,
    )
    expect_invalid(request_validator, oversized_screenshot, "screenshot response budget")
    unknown = dict(requests[0], unexpected=True)
    expect_invalid(request_validator, unknown, "unknown request field")

    response_validator.validate(
        {
            "protocol": "agenttab.rpc",
            "version": 1,
            "request_id": "verify-success",
            "ok": True,
            "outcome": "completed",
            "result": {"ready": True},
        }
    )
    response_validator.validate(
        {
            "protocol": "agenttab.rpc",
            "version": 1,
            "request_id": "verify-failure",
            "ok": False,
            "outcome": "not_started",
            "error": {"code": "automation_paused", "message": "AgentTab is paused"},
        }
    )
    expect_invalid(
        response_validator,
        {
            "protocol": "agenttab.rpc",
            "version": 1,
            "request_id": "verify-ambiguous",
            "ok": True,
            "outcome": "completed",
            "result": {},
            "error": {"code": "bad", "message": "bad"},
        },
        "ambiguous response",
    )

    connection_validator.validate(
        {"protocol": "agenttab.rpc", "version": 1, "kind": "connect"}
    )
    connected = {
        "protocol": "agenttab.rpc",
        "version": 1,
        "kind": "connected",
        "connection_id": "018f47a0-7b10-7abc-8def-0123456789ab",
        "resumed": False,
        "state": "ready",
    }
    connection_validator.validate(connected)
    missing_state = dict(connected)
    missing_state.pop("state")
    expect_invalid(connection_validator, missing_state, "connected state")
    resumed_without_binding = dict(connected, resumed=True)
    expect_invalid(
        connection_validator,
        resumed_without_binding,
        "resumed connection task binding",
    )
    connection_validator.validate(
        dict(
            resumed_without_binding,
            task_id="018f47a0-7b10-7abc-8def-0123456789ac",
            resume_capability="r" * 32,
        )
    )
    return len(requests) + 10


def verify_native_messages(schemas: dict[Path, dict], registry: Registry) -> int:
    native_validator = validator(NATIVE_ROOT / "message.schema.json", schemas, registry)
    close_task = {
        "protocol": "agenttab.native",
        "version": 1,
        "kind": "close_task",
        "request_id": "018f47a0-7b10-7abc-8def-0123456789ab",
        "task_id": "018f47a0-7b10-7abc-8def-0123456789ac",
    }
    native_validator.validate(close_task)
    expect_invalid(
        native_validator,
        dict(close_task, connection_id="018f47a0-7b10-7abc-8def-0123456789ad"),
        "close_task unknown field",
    )
    missing_task = dict(close_task)
    missing_task.pop("task_id")
    expect_invalid(native_validator, missing_task, "close_task task binding")
    return 3


def main() -> int:
    try:
        schemas, registry = load_schemas()
        messages = verify_core_messages(schemas, registry) + verify_native_messages(
            schemas, registry
        )
    except (AssertionError, OSError, ValueError, ValidationError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1
    print(f"PASS {len(schemas)} schemas and {messages} Core RPC fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
