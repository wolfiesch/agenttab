# Telemetry

Two unrelated things live under this name, and neither one sends anything anywhere by default:

- **Local usage diagnostics** - `usage_telemetry.py`, an offline script that mines local agent logs to count tool use.
- **OpenTelemetry request spans** - an opt-in host feature that emits one span per bridge request, off unless you switch it on.

## Local usage diagnostics

`usage_telemetry.py` is an advanced local diagnostic script. It mines local agent logs to count how often the bridge's browser tools are used and breaks the total down by source so you can see each one's magnitude as a share of the whole. It is not product telemetry: it only reads local files you point it at and never sends data anywhere.

- **claude** - Claude Code transcripts under `~/.claude/projects` (`--projects-dir`). MCP `tool_use` blocks matching `--server-match` (default `chrome[-_]devtools`).
- **codex** - Codex rollout sessions under `~/.codex/sessions` (`--codex-dir`). Canonical `mcp_tool_call_end` events (deduped by `call_id`; the bare `function_call` twin is ignored) whose `server`/`tool` match `--server-match`.
- **bridge** - the host's own `bridge_audit.jsonl` (`--bridge-audit`). Already bridge-specific, so `--server-match` is not applied; forwarded actions that log two rows under one `requestId` collapse to one call.

```bash
python3 usage_telemetry.py --format json --since 2025-01-01
```

Each report carries `total_calls`, a `by_source` map (`calls` + fractional `share`), and per-source/per-tool counts. Restrict sources with `--sources` (e.g. `--sources claude,codex`) and drop blocked bridge requests with `--exclude-denied`.

```bash
python3 usage_telemetry.py --sources codex,bridge --format text
```

It only reads transcript/audit files and never contacts the bridge or Chrome.

## OpenTelemetry request spans (opt-in)

Both hosts can emit one OpenTelemetry span per bridge request, with child spans for policy evaluation and the extension forward. This is **off by default**. With `BRIDGE_OTEL_ENABLED` unset the code path is inert: no extra module is imported, no file is opened, no socket is created, and the request behaves exactly as it does on a host that has no telemetry code at all.

### Configuration

Telemetry is **process-level configuration, not policy**. It is set with environment variables on the host process, so there is no new policy key and no per-client switch: a policy layer cannot turn tracing on for one client, and turning tracing on can never change a policy decision. (Policy stays the answer to "may this request run"; telemetry only describes requests that already got an answer.)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_OTEL_ENABLED` | unset (off) | `1`/`true`/`yes`/`on` enables span emission. Anything else, including unset, leaves the whole path inert. |
| `BRIDGE_OTEL_ENDPOINT` | unset | OTLP/HTTP endpoint to POST spans to, e.g. `http://127.0.0.1:4318`. `/v1/traces` is appended when the value does not already contain it. **Nothing leaves the machine unless this is set.** |
| `BRIDGE_OTEL_FILE` | unset | Local file sink. Each request appends one OTLP/HTTP JSON document as a JSON line. Purely local; useful without a collector and used by the guardrails contract. |
| `BRIDGE_OTEL_SERVICE_NAME` | `chrome-bridge` | `service.name` resource attribute. |

Both sinks may be set at once, and enabling the feature with neither set is valid (spans are built and discarded, which is how you measure the overhead).

```bash
BRIDGE_OTEL_ENABLED=1 BRIDGE_OTEL_FILE=/tmp/chrome-bridge-spans.jsonl python3 bridge.py
```

No `opentelemetry` SDK is required or installed: the document written or posted **is** the OTLP/HTTP JSON wire format, built with the standard library.

### Span model

One request produces one `SERVER` span named `execute_tool <action>`, following the OpenTelemetry GenAI tool-execution convention, plus one `INTERNAL` child span per instrumented stage:

- `bridge.policy_evaluate` - host-side policy evaluation
- `bridge.extension_forward` - the round trip to the extension

Attributes on the request span:

| Attribute | Value |
| --- | --- |
| `gen_ai.tool.name` | the action name |
| `gen_ai.tool.type` | `extension` |
| `bridge.action` | the action name |
| `bridge.client` | the resolved client name (from the token registry, never the token) |
| `bridge.decision` | the same decision string the audit log records (`allow`, `deny`, `dry_run`, `lease_deny`, `confirmation_required`, `extension_success`, ...) |
| `bridge.effective_tier` | `read_only` or `mutating`, computed from the payload and not the action name alone |
| `bridge.duration_ms` | wall-clock duration of the whole request |
| `bridge.tab_id_count` | how many distinct tab ids the request touched |
| `bridge.success` | whether the client received a success |
| `bridge.request_id` | the host-generated forward id, when the request reached the extension |
| `bridge.trace_id` | the session trace id, when the request is trace-eligible |
| `bridge.host` | `python` or `rust` |

Span status is `OK` on success and `ERROR` otherwise.

### What is and is not exported

Exported: action names, the resolved client name, host decision strings, the effective tier, timings, a count of touched tab ids, success, the host's own request id, and the caller's session/trace id.

Never exported, under any configuration:

- request payloads or any field of one (no selectors, no URLs, no typed text, no file paths)
- response bodies, page content, accessibility snapshots, or screenshots
- cookies, storage values, credential values, bridge tokens, or confirmation tokens
- denial reason strings and extension error strings (they can quote caller- or page-supplied text, so spans carry the decision instead)

The only attribute value that originates outside the host is the caller's own trace/session id, and every string attribute - that one included - is run through the same `secretMaskFile` masking the audit log uses before export, so a known secret appears as `<masked:name>` or not at all.

Nothing leaves the machine unless `BRIDGE_OTEL_ENDPOINT` is set. With only `BRIDGE_OTEL_FILE` set, spans stay in a local file you chose.

### Correlating spans with session trace artifacts

When policy also sets `traceDir` (see `docs/security.md`), the session trace artifact and the exported span describe the same request from two directions. With telemetry enabled, each JSONL event additionally carries `otelTraceId` and `otelSpanId` next to its existing `traceId`, naming exactly the span that was exported for that request. With telemetry disabled those fields are absent and the artifact is byte-identical to an untraced host's.

### W3C trace context

A caller can name the trace a request belongs to, and the host continues that trace rather than starting a new one:

- **TCP request envelope** - a `traceparent` field alongside `action`, `payload`, and `token`. Like the token and `dryRun`, it is host-only: it is stripped before anything is forwarded to the extension.
- **MCP over HTTP** - the incoming request's `traceparent` header, read next to the per-request bridge token and passed through unchanged.
- **MCP over stdio** - there is no incoming header, so a root trace is minted per tool call, but only when `BRIDGE_OTEL_ENABLED` is set.
- **CLI** - the global `--traceparent <value>` flag, for scripted runs.

```bash
chrome-bridge --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 getTabs
```

A malformed or absent `traceparent` starts a fresh trace; it never fails the request.

### Failure handling

Export is best effort, exactly like an audit-log write: a failure is logged once and the request continues unaffected. The OTLP POST runs on a background thread with a bounded queue and a short timeout, so a slow or dead collector cannot add latency to browser automation, and a broken sink is disabled for the rest of the process instead of being retried on every request.

### Rust host scope

The Rust host emits the same spans, with the same names, the same attribute keys, and the same OTLP/HTTP JSON document as the Python host. Its exporter is a minimal `std::net` HTTP/1.1 writer rather than a TLS-capable client, so `BRIDGE_OTEL_ENDPOINT` must be a cleartext `http://` endpoint (the usual local-collector case, `http://127.0.0.1:4318`). An `https://` endpoint is refused with one log line rather than linking a TLS stack into the host; `BRIDGE_OTEL_FILE` behaves identically on both hosts.
