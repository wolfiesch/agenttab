# AgentTab MCP

AgentTab exposes a small local MCP adapter for task-owned browser work. v2 is currently unreleased source at `2.0.0-rc.1`. Neither `agenttab` nor `agenttab-mcp` is a public package today, so the configurations below describe the exact future and approved-local setup rather than a live install.

The adapter is stdio only. Standard mode uses local AgentTab IPC behind the adapter, not TCP, a bearer token, a manual JSON protocol, a Python host, resources, prompts, or a legacy 67-tool surface.

## Prerequisites

Before starting the adapter, an approved local installation must have:

1. An enabled AgentTab extension in Chrome 127 or later.
2. Chrome's required `debugger` permission present from installation and the optional `scripting` permission granted from the AgentTab popup.
3. A running `dev.agenttab.host` connected to the extension through Native Messaging.
4. Local IPC readiness. Check it with `agenttab doctor --layer ipc` after the command is available.

The current installer plans supported client configurations transactionally. It stages an unpacked extension for prerelease testing and does not claim that a Chrome Web Store extension is live. See [Setup](setup.md).

## Exact stdio setup

The MCP server command is:

```text
agenttab mcp
```
The adapter implements MCP protocol version `2025-03-26` over newline-delimited JSON-RPC 2.0 on stdin and stdout. MCP clients manage that transport; do not send Core RPC frames to the stdio process by hand.


After a local installer run, supported client configuration receives an absolute AgentTab wrapper command with the single argument `mcp`. For a manual configuration, use the following only when `agenttab` resolves to that installed wrapper in the client process environment:

```json
{
  "mcpServers": {
    "agenttab": {
      "command": "agenttab",
      "args": ["mcp"]
    }
  }
}
```

The installer recognizes and updates the existing JSON configuration locations for Claude Desktop, Cursor, Windsurf, and `~/.config/mcp/mcp.json` when the file or client directory exists and the configuration is valid. It adds the same `mcpServers.agenttab` entry and preserves other entries. A malformed file is skipped without mutation.

The package coordinate for the direct stdio binary is `agenttab-mcp`; its executable is `agenttab-mcp`, with no command-line options. The installer package coordinate and CLI are both `agenttab`. These names are reserved in the local release contract but are not evidence of public registry availability.

### Client examples

The same `agenttab mcp` entry is the manual shape for Claude Desktop, Cursor, Windsurf, and another stdio-MCP client. Do not put a profile path, port, token, or `AGENTTAB_SOCKET` override in routine client configuration.

For OMP and Pi, the release's public package coordinate is `@getagenttab/omp`. The package advertises both `omp.extensions` and `pi.extensions`, each pointing to the same built adapter. OMP receives native Zod schemas, approval metadata, and discoverable strict tools; Pi receives native TypeBox schemas. Both runtimes register the same seven Standard tools and render the same browser operation cards. Cards identify task and tab ownership, separate intent, policy decision, execution, and observation, surface browser effects and recovery instructions, and keep sensitive inputs out of collapsed output. Expanded results remain bounded and redact tokens, credentials, cookies, authorization, passwords, and secrets. The installer adds the local built extension path to OMP `config.extension` and Pi `packages`; the executable path remains local and does not assume a public registry install.

## Connection and durable resume

An MCP server process opens one AgentTab Core connection when it first calls a tool. The host lazily creates the task on the first browser operation. That connection owns the task and may list or mutate only that task's tabs.

Set `AGENTTAB_CONVERSATION_ID` only when the MCP client can provide one stable, private conversation scope. With it, the adapter stores a resume capability in an owner-only local state file under the AgentTab state directory. On reconnect it offers the stored capability, the host returns a replacement capability, the adapter durably records it, confirms it on that connection, and then activates the replacement. A failed durable confirmation closes the connection instead of treating the task as resumed.

`AGENTTAB_CONVERSATION_ID` is non-authoritative metadata. The opaque resume capability is the authorization proof and must never be copied into a client config, prompt, log, or shared state. Without a valid capability, a new connection receives a new task; the previous task is not silently shared. The host can rotate a capability with task responses, and the adapter persists the replacement before resolving that response to the caller.

For MCP, the capability store namespace is `mcp`; OMP uses `omp`; Pi uses `pi`. Each hashes the supplied conversation scope into the owner-only filename. See [Commands](commands.md#adapter-environment) for environment variables and [Core RPC connection schema](../schemas/rpc/v1/connection.schema.json) for the connection envelope.

## Seven Standard tools

| Tool | Required input and behavior |
|---|---|
| `browser_open` | `mode: "create"` optionally accepts an `http`, `https`, or `about` URL, `background`, and `placement`. The default `placement: "task"` creates a tab in the task's existing window when possible. `placement: "new_window"` creates the first tab of an otherwise empty task in a separate unfocused normal window and rejects `background: false`. `mode: "adopt_active"` explicitly adopts only the currently active tab. The result includes task, tab, window, page-revision, and `automation_route` identifiers. |
| `browser_snapshot` | Requires `tab_id`. Modes are `accessibility`, `text`, `html`, and `screenshot`. Only accessibility snapshots return revisioned node references. Snapshots require the `full` automation route. |
| `browser_act` | Requires `tab_id`, `expected_page_revision`, and one to 64 typed actions. Actions are click, type, fill, select, scroll, drag, navigate, history movement, reload, close, dialog decision, and staged file upload. No coordinate action exists in Standard mode. A `tab_only` route accepts navigation, history movement, reload, and close only. |
| `browser_wait` | Requires `tab_id` and one load, URL, text, selector, network-idle, or download condition. `timeout_ms` is at most 120 seconds. A `tab_only` route accepts load, URL, and download conditions only. |
| `browser_tabs` | Takes an empty object and lists only the current task's tabs, including each tab's `automation_route`. |
| `browser_handoff` | Requires a task tab, expected page revision, prompt, completion condition, and optional timeout. Completion can be navigation, manual completion, a URL, or a selector. It remains available on a `tab_only` route because AgentTab blocks agent observation while the human controls the tab, but selector completion requires the `full` route. |
| `browser_commit` | Requires the staged token returned by a prior `commit_required` action and executes that one staged operation. |

Every existing-page mutation carries its expected page revision. If navigation or document replacement makes that revision stale, AgentTab rejects the operation rather than selecting a new target.

`automation_route` is `full` for ordinary HTTP, HTTPS, and `about:blank` tabs. It is `tab_only` with `route_reason: "browser_restricted_origin"` for Chrome system pages, extension pages, DevTools, the Chrome Web Store, malformed URLs, and unknown schemes. Page inspection or interaction requested on a `tab_only` tab returns `browser_restricted_origin` with `outcome: "not_started"` and recovery that explicitly says not to retry the same AgentTab route. This is a browser platform boundary, not a policy denial and not permission that can be granted through AgentTab.

### Developer mode

`browser_developer` is the only additional tool. MCP lists it only when the adapter starts with `AGENTTAB_DEVELOPER=1`; the extension also requires persistent Developer mode to be enabled in the AgentTab popup. It takes an `action` string and a bounded `params` object. It is intentionally outside the Standard tool surface and should not be enabled for ordinary browser work.

## Result, error, handoff, and Commit semantics

### Results and errors

The Core response has `protocol: "agenttab.rpc"`, `version: 1`, matching `request_id`, `ok`, and an `outcome`. A successful MCP tool call returns both readable MCP text content and `structuredContent`. A Core error is returned as an MCP tool error with `isError: true`; when available, its structured content contains `code`, `outcome`, `recovery`, and `details`.

| Outcome | Meaning |
|---|---|
| `completed` | The operation completed and has a result. |
| `not_started` | The operation did not begin. Inspect the structured error and recovery before retrying. |
| `unknown` | The operation may have run but a durable terminal result is unavailable. Do not blindly replay it. |
| `needs_user` | The operation requires human involvement. Follow the returned recovery or handoff state. |
| `commit_required` | A recognizable consequential action was staged instead of executed. |

Mutation methods carry a UUIDv7 idempotency key in Core RPC. The adapter generates one when a caller has not supplied a Core request. Reusing a completed key for identical work returns the durable response; reusing it with different input is a conflict. A mutation found only as started after recovery returns `unknown` and is not replayed.

### Your Turn handoff

Call `browser_handoff` before the user enters credentials or completes another human-only step. AgentTab activates a global blackout, focuses the declared tab, opens its user-facing handoff state, and denies browser observation and capture for every task while the handoff is active. Automation resumes only after the declared navigation, URL, selector, or manual completion condition is satisfied and the handoff is cleared.

The agent must not attempt snapshots, page reads, or mutations during this interval. It should report the handoff prompt to the user and wait for the terminal tool result or an explicit user completion.

### Staged Commit

`browser_act` is the Standard mutation choke point. For recognizable send, publish, purchase, delete, upload, authorization, and permission-grant controls, AgentTab can stop before the side effect and return:

```json
{
  "outcome": "commit_required",
  "result": {
    "staged_token": "…",
    "tab_id": 42,
    "page_revision": 7,
    "effect": "…",
    "fingerprint": "…",
    "expires_at_ms": 0
  }
}
```

The token is bound to the task, tab, effect, page revision, and element fingerprint. It expires after at most five minutes and is one-use. The extension popup must first record a human approval for that exact stage. Approval does not execute the action and does not expose the native token. The agent must then call `browser_commit`, which takes only the staged token, revalidates the target, and executes only an approved stage. A changed page, ownership change, expiry, unapproved stage, or repeated token makes the commit fail.

A `browser_act` batch is sequential and non-atomic. The extension stops before the first recognizable staged action and does not execute later actions implicitly. The current host response preserves the staged token and binding metadata, but does not publicly return the extension's completed-prefix list or staged index. Clients must not infer how many preceding actions ran from a `commit_required` response; inspect the page before deciding the next action. This is a source limitation, not a guarantee of an atomic batch.

Commit reduces recognizable risk only. It requires both the popup's human approval and the agent's later `browser_commit`, but it cannot prove that a page's labels, event handlers, or side effects are benign.

## Schemas and related documentation

- [Core request schema](../schemas/rpc/v1/request.schema.json)
- [Core response schema](../schemas/rpc/v1/response.schema.json)
- [Open parameters](../schemas/rpc/v1/browser-open.schema.json)
- [Snapshot parameters](../schemas/rpc/v1/browser-snapshot.schema.json)
- [Act parameters](../schemas/rpc/v1/browser-act.schema.json)
- [Wait parameters](../schemas/rpc/v1/browser-wait.schema.json)
- [Handoff parameters](../schemas/rpc/v1/browser-handoff.schema.json)
- [Commit parameters](../schemas/rpc/v1/browser-commit.schema.json)
- [Commands](commands.md)
- [Setup](setup.md)
