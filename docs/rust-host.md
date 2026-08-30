# AgentTab Rust host

`agenttab-host` is the production AgentTab host. It is a Rust workspace with `agenttab-protocol` and `agenttab-host` crates. There is no Python production host or Python fallback in the v2 runtime.

## Architecture

| Component | Responsibility |
| --- | --- |
| Core RPC | Validates versioned `agenttab.rpc` v1 requests, attaches connection identity and task scope server-side, and returns a structured outcome. |
| Runtime | Applies lifecycle, task scope, handoff blackout, origin and upload guardrails, idempotency, audit, and request locks. |
| Journal | Maintains durable task, ownership, revision-floor, handoff, staged Commit, event receipt, and idempotency state in SQLite. |
| Native transport | Exchanges versioned `agenttab.native` v1 messages with the Chrome extension over Native Messaging. |
| Local IPC server | Accepts authenticated same-user Core clients over a Unix socket or Windows named pipe. |
| Extension | Owns Chrome tabs, groups, revisions, debugger attachment, handoff UI, and Commit classification/execution. |

Core RPC and the native bridge are separate protocols. Both reject unsupported versions and unknown fields rather than silently downgrading.

## Native bridge

Chrome launches the native host named `dev.agenttab.host`; the extension maintains the Native Messaging connection. Native frames are an unsigned 32-bit little-endian length followed by UTF-8 JSON. Host-to-extension messages are capped at 1 MiB and extension-to-host messages at 64 MiB. The extension sends `hello` inventory, paused state, handoff state, and staged Commit state. The host becomes ready only after compatible hello and reconciliation, then returns `ready` with `ready` or `paused` state.

A native disconnect returns the host to reconciliation. A protocol mismatch is terminal rather than a compatibility fallback.

## Local Core IPC

Core RPC frames use the same unsigned 32-bit little-endian length and UTF-8 JSON format, with a 1 MiB limit in each direction. The server continuously reads frames, dispatches requests independently, and serializes output per connection. Request IDs are scoped to a connection, so responses can complete out of order.

On macOS and other BSD targets, AgentTab uses a Unix-domain socket and checks peer credentials with `getpeereid`. On Linux it checks `SO_PEERCRED`. The preferred Unix endpoint is `$XDG_RUNTIME_DIR/agenttab/agenttab.sock` only when that runtime directory is owned by the current UID; otherwise it is `$HOME/.agenttab/run/agenttab.sock`. Private directories are mode `0700`, socket and lock files are mode `0600`, and a lock prevents a second host. The host refuses unsafe replacement paths and only removes a stale, current-user socket after a failed live probe.

On Windows, the endpoint is `\\.\pipe\agenttab-<current-user-SID>`. The pipe DACL permits only that SID and `SYSTEM`, rejects remote clients, and verifies the client process SID. A per-user named mutex prevents a second host.

Standard mode has no TCP listener or bearer token. The advanced `agenttab proxy --token-file PATH [--port 9224]` command is the explicit loopback-only TCP bridge. It is outside the Standard trust model and requires a private token file.

## Lifecycle and admission

The implemented lifecycle states are `starting`, `reconciling`, `ready`, `paused`, and terminal. Browser work is admitted only in `ready`. In `starting` or `reconciling` it returns `runtime_not_ready`; in `paused` it returns `automation_paused`; in terminal state it returns a protocol-recovery error.

Pause admission is also enforced by the extension scheduler. It closes new admission, waits for in-flight work, persists pause state, and rejects queued work before dispatch. Handoff is a global write barrier and causes a host-side blackout check both before and after request admission.

## Durable state

By default, Unix state lives under `$HOME/.agenttab`; Windows uses `%LOCALAPPDATA%\AgentTab`. `AGENTTAB_STATE_DIR` can select a different root. The host creates a user-owned private root, run directory, and upload staging directory.

`state.sqlite3` uses WAL, full synchronous writes, foreign keys, and a busy timeout. It stores only hashes of resume capabilities and staged tokens. It also stores task ownership, monotonic page-revision floors, active handoff state, native-event receipts, staged Commit bindings, and idempotency entries.

Mutation idempotency is keyed by task and UUIDv7 key with a canonical method/parameter hash. The host records `started` before native dispatch and a terminal response after completion. A matching completed record replays the cached response. A durable started record after a crash returns `unknown` and is never re-executed. Terminal records are retained for seven days, with at most 10,000 records per task.

`audit.jsonl` is a separate local audit record. It contains structural summaries and digests rather than raw request and result values. See [security.md](security.md) for the precise privacy implications.

## Guardrails and effects

The host validates optional origin policy before dispatch and revalidates the known current origin for later actions. Uploads must be regular files under configured allowed roots and size limits; they are copied into private staging before the extension receives them.

The extension classifies recognizable consequential actions and the host durably binds the resulting Commit stage to its task, tab, revision, effect, fingerprint, expiry, one-use token, and popup review handle. Popup approval marks that host record approved without dispatch. Only a later public `browser_commit` with the private token can consume the approved record and execute it. The host does not infer that a staged label makes the underlying page effect safe.

## Build and test scope

The source workspace is checked with `cargo test --workspace --locked --manifest-path host-rs/Cargo.toml`; the dedicated IPC probe uses `cargo test --locked --manifest-path tests/architecture/ipc-probe/Cargo.toml`. These are local source gates, not evidence of a signed, published, or browser-installed release. See [verification.md](verification.md) for the full evidence boundary.
