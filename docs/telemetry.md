# Telemetry and local operational records

AgentTab has no product telemetry. The v2 host, extension, and shipped adapters contain no analytics, usage reporting, OpenTelemetry exporter, crash-reporting endpoint, or automatic network sink for operational data. AgentTab does not send task, browser, audit, or usage data to a product service.

This statement does not mean no local records exist, and it does not govern traffic that a user explicitly causes through a browser page, an advanced proxy, package download, or a separately configured tool.

## Local audit log

The Rust host writes a local `audit.jsonl` by default under the AgentTab state directory. On Unix it is mode `0600`. The host records:

- start and completion time;
- connection ID, task ID when assigned, and request ID;
- RPC method, outcome, duration, and replay status;
- target origins parsed from request URLs;
- structural argument and result summaries;
- a SHA-256 digest of canonical request parameters;
- error code and recovery text when present.

It intentionally does not write raw request values or raw result values. Structural metadata can still be sensitive: origins, object keys, string lengths, error text, and parameter digests can reveal useful context. A digest is not a promise that low-entropy data cannot be guessed. Keep the state directory private and do not upload an audit log as support evidence without review.

The local policy can disable audit writing. Disabling it changes local accountability, not product telemetry, and does not cause data to be sent elsewhere.

## SQLite state and receipts

`state.sqlite3` is local runtime state, not telemetry. It contains task/ownership state, page-revision floors, hashes of resume capabilities and staged Commit tokens, idempotency records, handoff state, and native-event receipts. It supports crash recovery and one-use operations. It is not a proof that a remote website accepted an action.

A user-visible website confirmation, transaction receipt, or download is independent evidence. The host's audit entry and journal receipt record only AgentTab's local processing.

## Extension local state

The extension keeps task state, paused state, active handoff marker, staged Commit records, and revision information in Chrome extension storage. This lets it restore safety barriers after service-worker restart. Chrome may sync or back up browser-profile data according to the user's browser/account configuration; AgentTab does not initiate a telemetry upload.

## Explicit network paths

AgentTab can drive a signed-in browser tab to a website. That website receives traffic according to the user's account and the page's behavior. This is browser activity requested by the task, not AgentTab product telemetry.

The advanced `agenttab proxy` command is an explicit loopback TCP bridge with a private token file. It is not enabled by Standard mode and does not turn on reporting. Package acquisition and future publication systems are external services whose own privacy terms apply when the user chooses to use them.

## Operational handling

Treat the following as sensitive local operational data:

- `audit.jsonl` and `state.sqlite3`;
- policy files and upload staging files;
- adapter configuration containing resume capabilities or proxy token paths;
- browser profile and extension storage;
- terminal output, screenshots, and browser traces.

Before sharing diagnostics, minimize the time window, remove secret values, identity, paths, URLs, capabilities, and page content, then retain only the fields needed to reproduce the issue. No central AgentTab service exists to request, aggregate, or retain these records.
