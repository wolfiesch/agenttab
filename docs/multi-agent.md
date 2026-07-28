# Multi-agent tokens and leasing

## Multi-client tokens and leasing

The bridge accepts multiple named client tokens and offers a cooperative, host-side lease so several agents can share one real Chrome profile without colliding. Both the Python and Rust hosts implement this identically; it is enforced entirely in the host (lease actions are never forwarded to the extension).

### Named tokens

`bridge_token.txt` (the legacy single token) is always accepted under the client name `default`. Additionally, if `bridge_tokens.txt` (override with `BRIDGE_TOKENS_FILE`) exists, each non-empty, non-`#` line is parsed as `name:token` (split on the first colon) and registered as an extra named client. See `bridge_tokens.txt.example`. A request is authorized if its token matches any known token; the matched token determines the requesting client's name. `bridge_tokens.txt` is a secret registry and is git-ignored.

### Lease protocol

Three host-answered actions (also exposed as MCP tools `browser_lease`, `browser_release`, `browser_lease_status`):

- `lease` - payload optional `{"ttlMs": int}` (default 300000). Acquires the lease when free, expired, or already yours; otherwise returns `leased by <owner>`.
- `release` - releases your lease (`released: true`); `released: false` when no live lease; `not lease owner` when another client holds it.
- `leaseStatus` - non-mutating snapshot `{owner, expiresAt, now}` (epoch ms; `owner` null when unheld).

While a live lease is held, every non-lease action from a different client (including `batch`) is rejected with `leased by <owner>` before forwarding, so the lease cannot be bypassed. Leases auto-expire after their TTL. `BRIDGE_SOCKET_IDLE_TIMEOUT` (default 300s) bounds how long a persistent connection may idle.

`verify_lease_contract.py` covers the basic named-token and lease semantics. `verify_lease_stress_contract.py` adds race/load coverage for simultaneous lease acquisition, non-owner denial without extension forwarding, owner concurrency, TTL expiry, release races, and TCP disconnect behavior.

### Parallel work under one token

The lease arbitrates *between token identities*, not between concurrent requests from the same identity. The host records the lease owner as the client *name* resolved from the presented token, and only rejects an action when `owner is not None and owner != name`. So a second workstream running under the same token is never blocked by its own lease - and gains nothing from taking one.

Within one identity the supported concurrency primitive is **task sessions**: `createTaskSession` / `navigateTaskSession` / `getTaskSessions` / `closeTaskSession` (MCP: `browser_task_session_*`). A task session owns only its own tabs, opens them inactive, and closes only what it owns, so two sessions do not steal focus from each other or tear down each other's tabs.

Guidance:

- One task session per workstream. Never interleave two workstreams inside one session's tabs.
- Non-conflicting reads (`getTabs`, `observe`, `extractText`, `getHtml`, `screenshot`) across distinct session-owned tabs need no lease.
- Take the lease around a *mutating burst* that must not interleave with another identity - a login flow, a form submit sequence, a `githubAttachPrBody` upload - and release it immediately after. Keep the TTL short; it is a courtesy window, not a mutex against yourself.
- Anything that changes global browser state rather than one tab (window/tab activation, `waitForHandoff`, profile-wide emulation) still conflicts within a single identity. Serialize those in your own agent; the host will not do it for you.

Recipe (MCP tool names; the lease actions have no CLI subcommand, so mixed CLI/MCP agents drive the lease through MCP):

```
browser_task_session_create   name="research"   -> sessionId R
browser_task_session_create   name="publish"    -> sessionId P
browser_task_session_navigate session_id=R url="https://example.com/docs"
browser_task_session_navigate session_id=P url="https://github.com/owner/repo/pull/1"

# interleave reads freely across R's and P's tabs - no lease needed
browser_snapshot / browser_extract_text on either session's tabs

browser_lease   ttl_ms=60000        # only around the mutating burst
browser_click   tab_id=<P tab> selector="button[type=submit]"
browser_release

browser_task_session_close session_id=R
browser_task_session_close session_id=P
```

When policy sets `traceDir`, each of those session-scoped requests also lands in its own local trace artifact: the host keys the JSONL file on the request's `sessionId` (or `taskSessionId`), so `<traceDir>/R.jsonl` and `<traceDir>/P.jsonl` separate the two workstreams automatically. A request that names no session can join a trace by carrying an explicit `traceId` in its payload, which also lets several identities write to one shared trace - useful when a hand-off crosses tokens. `traceId` wins over `sessionId`, and both are metadata only: read the result with `chrome-bridge trace summary <traceId>` / `trace tail`, or MCP `browser_trace_summary` / `browser_trace_tail`. See `docs/security.md` for what a trace does and does not store.

When two workstreams genuinely need to *exclude* each other, give them separate named tokens (`bridge_tokens.txt`) rather than separate task sessions - that is the only configuration the lease can arbitrate. Over HTTP transport this no longer requires separate MCP servers: see per-request bridge tokens in `docs/mcp.md`.

### Per-client site modes and scheduled workflows

`siteModes` is part of the per-client policy layer, so different identities can hold different trust on the same origin: put the shared modes in `default` and override single origins under `clients.<name>`. The map is merged **per pattern**, so `clients.publisher: {"siteModes": {"https://github.com": "skip"}}` overrides only GitHub and inherits every other origin's mode from `default`. Set them with `chrome-bridge policy site-mode <originPattern> manual|auto|skip <client>` - naming a client always edits that client's own section, so a grant for one agent never widens the shared default. Give an unattended identity its own token and its own `clients.<name>` layer; do not relax `default` to make one scheduled agent work.

Scheduling is deliberately outside this coordination surface. `chrome-bridge schedule` only writes local metadata to git-ignored `bridge_schedules.json`; it runs nothing, holds no lease, and has no daemon, so a registered schedule cannot participate in lease arbitration. When an OS scheduler eventually invokes the run command, that run is an ordinary client like any other: it presents a token, resolves to a client name, and takes the lease around its own mutating burst if it needs to exclude the interactive agents. Two schedules that must not interleave need distinct named tokens and explicit leases, exactly like two live agents.
