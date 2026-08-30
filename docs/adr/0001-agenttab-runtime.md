# ADR 0001: AgentTab Runtime

- Status: Accepted
- Date: 2026-08-22
- Decision owners: AgentTab maintainers
- Applies to: AgentTab v2 runtime, extension, adapters, installer, and release surface

## Decision

AgentTab is a local browser runtime for AI agents.

- Product: **AgentTab**
- Category: **Local browser runtime for AI agents**
- Tagline: **Any agent. Your browser. Your rules.**
- Promise: **Give an agent a tab, not the keys to your browser.**

This ADR is the implementation contract for the v2 pivot. Implementations and tests MUST conform to it. Changes to these decisions require a later ADR that identifies the affected protocol, migration, security claim, and release evidence.

## User experience

### Automatic task workspaces

The default experience uses the user's existing Chrome profile and creates a task-owned browser workspace lazily on first browser use. Starting a task MUST NOT require a routine prompt for a site, capability, or duration. AgentTab MAY open Chrome when an installed supported browser is not running.

A task workspace is visible in Chrome. Task-owned tabs are grouped for display, but the group is not an authorization boundary.

### Your Turn

**Your Turn** is the human-only input boundary. AgentTab MUST hand control to the user for passwords, passkeys, two-factor authentication, CAPTCHA, payment secrets, and other input that automation must not observe or synthesize.

While any Your Turn handoff is active, AgentTab MUST enforce a global observation blackout across every task and client. The extension and host each fail closed. AgentTab MUST NOT capture human keystrokes. Handoff clears only after its declared completion condition or explicit Done, capture scrubbing, and host acknowledgement.

### Commit

**Commit** is a best-effort semantic review barrier for recognizable consequential controls, including send, publish, purchase, delete, upload, authorization, and permission grants.

Every Standard-mode mutation MUST pass through one extension-side `prepare -> classify -> revalidate -> execute` choke point. A recognizable consequential action is staged before any side effect. Its token is bound to the task, tab, effect class, exact element fingerprint, document revision, event, preview, and a five-minute expiry. The extension popup MUST send only an opaque review handle. Human approval MUST durably mark the corresponding stage approved without consuming it or dispatching the browser action. Only a later agent `browser_commit` carrying the private staged token may consume and execute the approved stage. Execution MUST reject an unapproved, changed, expired, foreign, or used stage, revalidate the target, and dispatch at most once.

Commit does not guarantee recognition of every page-triggered external effect. A page can attach a consequential effect to an innocently labelled control. Product and security copy MUST describe Commit as risk reduction, not proof of semantic safety.

Action batches are sequential and non-atomic. A batch stops before its first staged operation and returns the completed prefix plus staged index. Committing that staged operation MUST NOT execute later operations implicitly.

## Security boundary

Task ownership is an execution and coordination boundary. It is not cookie, identity, process, renderer, or Chrome-profile isolation. Standard mode may use the signed-in session in the existing profile.

Standard mode MUST NOT expose:

- raw cookies or browser storage
- passwords, passkeys, payment secrets, or human-only input
- arbitrary JavaScript execution
- raw Chrome DevTools Protocol access
- coordinate-based actions
- generic Chrome APIs
- network interception
- general-purpose browser-global mutations; Standard `browser_open` MAY create one unfocused normal window for the first tab of an empty task

Developer mode is a persistent, explicit opt-in and MUST remain visibly indicated on every task while enabled. Managed policy and developer configuration MAY expose internals, but Standard mode MUST remain closed.

AgentTab's real-profile trust model and residual prompt-injection and Commit risks MUST be stated in public security and onboarding material.

## Runtime and transport

Rust is the only production host implementation. Chrome Native Messaging starts one `agenttab-host` through `chrome.runtime.connectNative("dev.agenttab.host")`.

The host binds user-owned local IPC:

- macOS and Linux: Unix-domain socket
- Windows: current-user named pipe

On macOS and Linux, use `$XDG_RUNTIME_DIR/agenttab/agenttab.sock` only when the runtime parent is owned by the current UID. Otherwise use `$HOME/.agenttab/run/agenttab.sock`. The directory mode is `0700`; the socket mode is `0600`. Authenticate peers with `getpeereid` on macOS/BSD and `SO_PEERCRED` on Linux.

On Windows, use `\\.\pipe\agenttab-<current-user-SID>` with a DACL limited to that SID and `SYSTEM`.

Native Messaging and socket or pipe frames use an unsigned 32-bit little-endian length followed by UTF-8 JSON. Oversize declarations MUST be rejected before allocation. Enforce Chrome direction limits of 64 MiB for extension-to-host requests and 1 MiB for host-to-extension responses.

TCP and bearer-token access are not Standard transport. They exist only behind the explicit advanced command `agenttab proxy --listen 127.0.0.1:<port>` and MUST be labelled advanced or remote.

## Protocols and adapters

AgentTab Core RPC and the host-to-extension native protocol are separately versioned. They MUST NOT silently downgrade across an incompatible version.

MCP, OMP, CLI, TypeScript, and Python are adapters over Core RPC. They are not alternate hosts. The public Standard surface has exactly seven tools:

1. `browser_open`
2. `browser_snapshot`
3. `browser_act`
4. `browser_wait`
5. `browser_tabs`
6. `browser_handoff`
7. `browser_commit`

`browser_developer` is the eighth tool and is absent unless Developer mode is enabled.

Core RPC schemas are normative. Unknown fields and methods fail closed. Every mutation requires a UUIDv7 `idempotency_key`. Existing-page mutations also require the authoritative `tab_id` and expected `page_revision`. `browser_commit` is bound by its staged record rather than caller-supplied tab or revision.

The server derives IPC peer identity, connection identity, and task ownership. A client-supplied owner, origin, or `conversation_id` MUST NOT authorize access.

A stdio adapter opens one Core connection and receives a host-created task on first browser use. An HTTP MCP adapter opens one Core connection per authenticated MCP session. Different HTTP sessions MUST NOT share a task through the adapter process.

The host issues a random 256-bit resume capability once and persists only its hash. The adapter stores it in owner-only private state. A successful resume rotates it. A connection without a valid capability receives a new task.

## Ownership and concurrency

Ownership can be granted only by:

1. a tab created by the host for the task
2. a child tab with an owned `openerTabId`
3. explicit `browser_open({ mode: "adopt_active" })`

Adoption MUST be visible. It groups the active tab and shows a brief non-blocking indicator. If grouping fails, creation or adoption rolls back with `outcome: "not_started"`. AgentTab MUST NOT retain invisible ownership with `groupId: null`.

Dedicated-window eligibility MUST be derived from the persisted task record, never from a caller-supplied ownership claim. `placement: "new_window"` MUST fail after the task owns a tab, MUST reject foreground creation, and MUST roll back the created tab if visible grouping fails. Standard mode MUST NOT expose generic focus, resize, move, state-change, or close-window operations. `browser_handoff` remains the sole normal focus transition.

Tab groups are display-only. Manual grouping never grants ownership. Ungrouping or moving a tab out of its task group immediately revokes ownership, cancels queued mutations, and notifies the host.

Each tab has one serialized writer queue. Separate-tab mutations may overlap. Reads may overlap only when they cannot observe half-applied mutation state. Ordered task mutations preserve delivery order. Browser-global state uses a separate automatic lock. Agent-facing global lease operations do not exist.

Task cleanup persists deletion before calling `chrome.tabs.remove` so `tabs.onRemoved` cannot recreate an empty task record.

## Page revisions and references

`page_revision` is a monotonic per-tab document generation. It remains stable across snapshots of the same renderer document and increments on navigation or load start, or when the document or loader identity changes. Reading a snapshot does not increment it.

Accessibility references are revisioned. A reference from generation 42 used against generation 43 returns `stale_ref`. DOM-node disappearance within the same generation also returns `stale_ref`. Commit additionally detects same-document changes through its element fingerprint.

The extension persists a per-tab generation floor so a host or service-worker restart never reuses an earlier generation.

## Pause and lifecycle

The host lifecycle is:

`STARTING -> RECONCILING -> READY -> PAUSING -> PAUSED`

The host binds IPC early but accepts only status operations until a compatible extension hello and full reconciliation complete. A protocol mismatch is terminal.

Pause is linearizable and persistent. It closes admission atomically, allows already-dispatched work to reach a terminal outcome, returns queued work as `not_started`, persists PAUSED before UI acknowledgement, and restores PAUSED before reconciliation after restart. Resume reconciles before READY.

The host is guarded by one per-user OS lock. A stale socket is unlinked only after lock ownership and a failed live probe. Old-host exit retry is bounded.

## Automation permissions

Chrome deterministically rejects `debugger` in `optional_permissions`; it must be a required install-time permission. AgentTab v2 Standard therefore requires `debugger` and makes only `scripting` optional. Current accessibility snapshots, precise click, type, and fill behavior, inactive screenshots, and task-scoped CDP helpers require debugger; a separately implemented non-debugger runtime is required before that install-time tradeoff can change.

The one-time install disclosure warns that AgentTab can use debugger, native messaging, downloads, and host access. This is deliberate: the popup's Automation control requests and removes only optional `scripting`, directly in its click gesture. Denial or revocation leaves the required debugger grant installed, but immediately detaches every AgentTab debugger target, clears debugger-backed runtime state, and fails Standard operations closed until scripting is re-granted. `chrome.permissions.onRemoved` performs the same cleanup for revocation outside the popup; AgentTab never attempts to remove required `debugger`.

Chrome Split View is not an ownership or workspace boundary. Chrome 140 and later can place a newly created tab into the active Split View of the last-focused window. That tab cannot join a tab group, and a split paired with another extension can reject a debugger attachment. Background navigation therefore chooses the most recently accessed normal window whose active tab has `splitViewId == chrome.tabs.SPLIT_VIEW_ID_NONE`. If no such window exists, AgentTab creates an unfocused normal window. AgentTab never modifies the user's existing Split View to make a task tab usable.

Top-document target resolution MUST pin an explicit main-frame isolated execution context. Chrome's implicit `Runtime.evaluate` context is not stable after another extension injects a frame. On inactive task tabs, `type` and `fill` update the resolved DOM target and dispatch input events without synthesizing browser focus; active tabs retain `Input.insertText`. This prevents password-manager and other extension frames from capturing task input or detaching the task debugger.

Debugger attachment MUST be lazy and limited to task-owned tabs, and the task connection is reused only until its idle timeout. The installed debugger grant is not an attachment grant: Standard mode exposes no raw CDP escape hatch and no attachment may remain while optional scripting is off. The Chrome Web Store rationale MUST disclose this exact limited use.

The stable target requires `nativeMessaging`, `tabs`, `tabGroups`, `storage`, `alarms`, and `debugger`, with exactly `scripting` optional and `<all_urls>` host access. `cookies`, `history`, `bookmarks`, `contentSettings`, `activeTab`, and browser-global `downloads` access are absent from that target. PR1 locks and statically verifies this transformation without changing or reloading the installed v1 extension.

Permission evidence follows the implementation boundary. PR1 proves the deterministic required/optional manifest split, the installed-debugger versus live-attachment boundary, and the platform IPC security primitives. Its three-run live matrix varies optional scripting while requiring debugger to remain granted; it verifies zero AgentTab debugger attachments when scripting is off or revoked, then preserves denial, re-grant, Pause, reload, disable, and cleanup checks. PR2 verifies the production host lifecycle and IPC implementation. PR3 implements the full ownership/UI lifecycle. A failed `activeTab` matrix run records the exact Chrome API call before retention. The live probe never changes Chrome permissions itself, rejects raw CDP at the non-configurable Standard boundary, and cleans only task-owned tabs plus its exact fixture download.

## Persistence and crash behavior

Mutation idempotency is stored in `$HOME/.agenttab/state.sqlite3` using WAL. Records are keyed by `(task_id, idempotency_key)` and include a canonical method and parameter hash.

The host durably records `started` before native dispatch. It durably records `completed` plus the terminal response before acknowledgement. After restart:

- `completed` returns the cached terminal response
- `started` returns `outcome: "unknown"` and is never replayed
- reuse with different input returns `idempotency_conflict`

Terminal records are retained for seven days and at most 10,000 entries per task. Expired UUIDv7 keys are rejected rather than treated as new.

## Identity and migration

The v2 identity set is fixed:

- product: `AgentTab`
- native host: `dev.agenttab.host`
- CLI and npm package: `agenttab`
- MCP package: `agenttab-mcp`
- environment prefix: `AGENTTAB_*`
- manifest and action name: `AgentTab`

A checked-in `config/identity.json` is the single source for manifests, installers, packaging, tests, and release jobs. It contains the stable local-development extension ID and the separately assigned Web Store item ID after the unpublished item is created. Store packaging strips the manifest `key`. Native-host `allowed_origins` contains only the exact development and store IDs.

Migration from unpacked Chrome Bridge v1 is side-by-side and recoverable. AgentTab installs and proves v2 before instructing the user to disable v1. It MUST NOT silently remove the old extension, native-host registration, token, policy, logs, or private files.

PR 4 is an atomic no-alias cutover. It switches native-host registration and every CLI, MCP, OMP, SDK, and installer caller, then removes v1 code. The rollback unit is the PR, not compatibility shims.

## Review and release train

Partial v2 behavior MUST NOT reach the default branch. The review train is:

1. `architecture-gates` into `pivot/agenttab`: passing feasibility probes and this ADR
2. `runtime-core` into `pivot/agenttab`: unreleased v2 host and protocols beside the installed v1 path
3. `workspace-safety` into `pivot/agenttab`: v2 extension, ownership, Pause, Your Turn, Commit, and frozen development identity using disposable manifests
4. Create the unpublished AgentTab Chrome Web Store item and record its immutable ID
5. `cutover-install` into `pivot/agenttab`: atomic caller and registration cutover with v1 code removal
6. `brand-release-prep` into `pivot/agenttab`: assets, docs, site, packaging, migration guide, and release automation while v1.0.1 remains labelled current stable
7. `agenttab-v2` from `pivot/agenttab` into `main`: full integration review after controlled Web Store approval and complete green verification
8. `launch-cutover` into updated `main`: docs and metadata only, exposing stable quickstart after every public dependency is reachable

The numbered list includes the Web Store identity checkpoint; the seven PRs are PR 1 through PR 7 as named above.

PRs 1 through 5 merge only into `pivot/agenttab`. PRs 2 through 5 branch from the updated integration head after the prior unit merges. Every unit records base and head SHAs, passes exact-head CI, and clears every actionable review thread before merge.

## Consequences

AgentTab gains a small, stable public contract and server-derived ownership at the cost of a coordinated breaking cutover. Standard mode is intentionally less powerful than the current broad Chrome Bridge surface. Developer mode carries advanced escape hatches behind an explicit persistent opt-in.

The debugger permission remains a material store-review concern. Its retained functionality, lazy task-owned attachment, and lack of raw Standard CDP access are required evidence, not marketing claims.

Stable v2 publication is blocked by missing mandatory signing credentials or a failed platform, registry, site, or store identity check. Local implementation and prerelease verification continue independently of that publication boundary.
