# AgentTab security and trust model

AgentTab is a **local browser runtime for AI agents**. It gives an agent task-owned tabs in the user's signed-in Chrome profile. Its boundary is execution coordination, not a separate Chrome profile, cookie jar, identity, or sandbox.

## Trust boundary and local attacker model

A task may use the profile already signed in to websites. An agent can therefore act with the permissions of the currently signed-in user on a task-owned tab. AgentTab does not expose raw cookies, storage, saved-password lists, or credential values through Standard mode. When managed policy explicitly enables the 1Password broker, the host may obtain one origin-matching Login item and send selected values directly to the owned page through the extension. That narrow path does not make the signed-in session untrusted or isolated.

The host authenticates its local IPC peers as the current OS user. This prevents a different local user from connecting through the user socket or named pipe. It does **not** distinguish benign and malicious processes running as that same user. A local attacker that can execute as the account, read AgentTab state, control the browser, or modify the extension/host installation is outside this protection. Use an OS account and a browser profile appropriate for the work, protect the account, and treat local malware as a full compromise.

Task-owned groups constrain ordinary AgentTab execution. They do not prevent a page, extension, process, or human with broader profile access from accessing the same signed-in account.

## Standard and Developer mode

Standard mode exposes exactly these nine MCP tools:

- `browser_open`
- `browser_snapshot`
- `browser_act`
- `browser_wait`
- `browser_tabs`
- `browser_handoff`
- `browser_commit`
- `browser_credentials`
- `browser_finish`

Developer mode additionally exposes `browser_developer`. It is disabled by default in the host's local managed policy and is visibly marked on a task. Developer mode is intentionally a broader trust decision.

Standard mode has no raw CDP method, arbitrary JavaScript API, raw cookie or storage API, coordinate action, generic browser-global mutation API, or credential-value API. The narrow exceptions are `browser_open` with `placement: "new_window"`, which creates one unfocused normal window for the first tab of an empty task, and policy-gated `browser_credentials`, which passes an origin-matched login field from 1Password directly to a selected field ref without returning the value. Internally, the extension uses Chrome debugging APIs for task-scoped accessibility snapshots and precise ref-based actions. Those implementation details are not a Standard-mode escape hatch.

Passkeys, security keys, CAPTCHA, payment secrets, account recovery, and unsupported verification require `browser_handoff`. The human completes the step in Chrome; no secret is placed in an AgentTab request.

## 1Password credential broker

The broker is disabled unless `policy.json` sets `one_password.enabled` to `true`. The host derives the current origin from its verified task-tab inventory, queries only 1Password Login items, and accepts an item only when a URL on that item matches the current host or a recognized authentication subdomain of the same registrable domain. Item titles and unrelated fields do not authorize a match.

`one_password.max_candidates` and `one_password.max_attempts` are each restricted to `1..3`. More than the configured candidate limit returns `needs_user` without selecting or exposing an item. A prepared attempt receives a random, short-lived token bound to the task, tab, origin, candidate position, and attempt count. Tokens are one-use for fill or advance, expire after five minutes, and are invalidated by navigation.

The host invokes the absolute `one_password.executable` when configured, or `op` from its process `PATH` otherwise. JSON output is captured in memory. The broker selects only username, password, and one-time-code fields, then sends them through the private host-to-extension credential method. Core RPC, MCP, OMP, Pi, and audit responses contain only candidate counts, booleans, attempt counters, and opaque tokens. Credential values are neither serialized into an adapter request nor written to audit output. A 1Password authentication timeout, no match, unsupported item, provider failure, exhausted attempts, or ambiguous candidate set returns `needs_user`.

## Permissions

The manifest declares `nativeMessaging`, `debugger`, `tabs`, `tabGroups`, `storage`, and `alarms`, with `<all_urls>` host access. Chrome does not permit `debugger` in `optional_permissions`, so it is a required install-time permission. `scripting` remains optional: the popup requests it when automation is enabled and removes it when automation is turned off.

`debugger` is retained because the current task-scoped implementation needs Chrome's accessibility tree, ref-based action support, inactive captures, dialog handling, network-idle observation, and exact download completion attribution. Attachments are lazy, limited to owned tabs, reused briefly, and detached after idle work or optional `scripting` revocation. The permission is not evidence that Standard mode grants generic debugging access.

## Browser-restricted origins

Chrome refuses extension page scripting or debugger access on browser-owned surfaces, including `chrome://`, `chrome-extension://`, `devtools://`, and the Chrome Web Store. Local host policy and extension permissions cannot remove that platform boundary.

AgentTab classifies every opened or listed task tab as `automation_route: "full"` or `"tab_only"`. Ownership remains required for both routes. On `tab_only`, agent-driven controls are limited to tab-lifecycle operations that Chrome still exposes: explicit navigation, reload, close, and load or URL waits. History movement is also available when managed origin constraints are absent. When constraints exist, AgentTab rejects history movement because Chrome does not expose its destination for authorization before navigation; callers must navigate explicitly to an allowed URL. Download waits require the `full` route because Chrome's browser-global downloads API does not identify the initiating tab, while the debugger events used for exact attribution are unavailable on restricted origins. `browser_handoff` remains available because AgentTab blacks out observation while the human controls the task tab. Snapshot, page-content wait, element action, page-dependent Commit, and raw Developer-mode CDP requests fail before script or debugger execution with `browser_restricted_origin` and `outcome: "not_started"`. A staged close remains executable through `browser_commit` because it uses Chrome's tab-lifecycle API without page access; ownership, revision, approval, token, and expiry checks still apply. Managed origin policy still validates HTTP and HTTPS tab-only pages and every explicit navigation target. Browser-owned non-HTTP pages cannot match an origin allowlist, so AgentTab admits only the same tab-only recovery operations there. In-page interaction requires an exact-tab human handoff; do not escalate to desktop-wide or browser-window-scoped input.

## Ownership, revisions, and human control

A tab becomes owned only when AgentTab creates it, when Chrome reports it as a child of an owned opener, or through `browser_open` with `mode: "adopt_active"`. The visible Chrome group is evidence of that ownership, not an authority grant by itself. Moving or ungrouping a tab revokes ownership and cancels queued work. A grouping failure rolls creation or adoption back rather than retaining invisible ownership. A caller may request `placement: "new_window"`, but the extension derives eligibility from its stored task record: the task must own no tabs, the window is created unfocused in normal state, and a failed group grant removes the created tab. A client-supplied ownership claim cannot authorize an existing window.

Actions that operate on an existing page carry an expected page revision. Navigation and document replacement advance that revision; stale refs and stale revisions fail instead of being applied to a later document.

**Pause agents** closes admission, waits for already-dispatched work to settle, rejects queued work as not started, and persists the paused state before reporting it. Resume reconciles ownership first.

## Prompt injection and Commit limitations

Page text, HTML, labels, screenshots, accessibility names, and downloads are untrusted data. A page can attempt to persuade an agent to reveal data, broaden access, ignore policy, or act outside the user's purpose. AgentTab cannot decide whether instructions embedded in page content are trustworthy. Agents and their operators must treat page content as data, constrain their task, inspect consequential previews, and stop when the page asks for unrelated access or secrets.

Before a Standard mutation, the extension prepares the target, classifies recognizable effects, revalidates it, and then executes it. Recognizable send, publish, purchase, delete, upload, authorization, and permission-grant controls instead stage a five-minute, one-use Commit record. The record binds the task, tab, page revision, event, target fingerprint, effect, and preview. The extension popup sends only an opaque review handle. A successful popup approval durably marks the stage approved but does not consume its token or dispatch the browser action. Only a later agent `browser_commit` can consume that approved stage; execution rechecks ownership, revision, expiry, and fingerprint.

Commit is a best-effort semantic barrier, not proof that an action is harmless. It requires two distinct events, human approval in the popup and the agent's later Commit request. A page can hide an external effect behind an innocent label, alter meaning through script, or use an effect AgentTab does not recognize. Harmless-looking controls may execute without review. Batches are sequential and non-atomic: work stops before a staged action and never runs later actions implicitly.

YOLO mode is an explicit, disabled-by-default opt-out from Commit review. When enabled, recognized consequential controls execute during the original `browser_act` call, and pending staged actions are discarded when the setting changes on. The mode does not bypass task ownership, origin policy, expected revisions, restricted-origin routing, handoff blackout, credential isolation, or action validation.

## Your Turn blackout

During a `browser_handoff`, AgentTab pauses browser work and applies a global blackout across tasks. Page observations and captures are denied while the human enters information. The extension persists the active handoff before focusing the tab; the host restores the blackout from durable state after restart. Completion requires the declared condition or explicit completion, capture scrubbing, and host acknowledgement before automation resumes.

This reduces exposure during handoff. It cannot protect secrets from a compromised device, a malicious webpage, or browser extensions with their own access.

## Upload guardrails

`upload_file` is available only for regular files below a configured `dlp_allowed_roots` path and under the configured size limit. The host canonicalizes the path, rejects symlink races and Unix hard-linked files, verifies the opened file, copies it into a private staging directory, and uses the staged copy for the action. On Unix, staging files are mode `0600`; staged files are removed after the terminal Commit path when cleanup succeeds.

These checks limit accidental path selection. They do not establish that a permitted file is safe to disclose or that the destination is trustworthy. Upload is a recognizable Commit effect and should be reviewed by the human.

## Resume capabilities and durable state

A Core connection receives a task lazily on first browser work. A resume capability is a 256-bit random bearer secret: the host returns it once and persists only its SHA-256 hash, and the client must durably persist and confirm it before another RPC. A successful resume returns a rotated capability under the same persist-then-confirm barrier. `conversation_id` is metadata only and never authorizes a task.

Adapters must store a capability in owner-only private state and must not log, display, or share it. Losing it does not expose a task, but reconnecting without it creates a new task. Treat a capability like a local session secret.

The host stores task state, ownership, revision floors, handoff state, staged Commit records, event receipts, and idempotency records in local SQLite with WAL and full synchronous writes. Mutations use UUIDv7 idempotency keys. A completed record returns its cached result; a durable started record after a crash returns `unknown` and is never replayed.

## Local audit data and operational records

Audit is local, enabled by default, and written to `audit.jsonl` under the AgentTab state directory. On Unix the file is mode `0600`. Each record contains timestamps, connection ID, task ID when assigned, request ID, method, outcome, duration, replay flag, target origins, a structural argument summary, an argument digest, structural result summary, error code, and recovery text. It does not intentionally store raw argument or result values, but origins, object keys, string lengths, error text, and digests can still be sensitive operational metadata. Restrict access to the state directory.

SQLite event receipts and idempotency records are local reliability data, not user-visible proof that an external side effect occurred. Audit can be disabled only through the local managed policy. Neither record type is a replacement for reviewing the website or its own receipt.

## Signing and release status

The source includes installer verification for signed artifact manifests and platform signatures, but the checked-in release-trust configuration has no development or stable public key. No signed v2 artifact, registry package, Web Store listing, hosted privacy page, or stable release is established by this source tree. `2.0.0-rc.1` is prerelease and unreleased. Do not infer publication, notarization, Authenticode, provenance, or store approval from local code.

## Responsible disclosure

Do not publish exploitable details, credentials, capability values, or user data in an issue. Send a minimal reproduction, affected version or commit, platform, impact, and suggested mitigation through a private maintainer channel. This repository does not declare a separate security contact in source; use private GitHub reporting only if the repository enables it, otherwise contact the maintainers privately before public disclosure. Allow time for acknowledgement and a fix before coordinated public disclosure.
