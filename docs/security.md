# AgentTab security and trust model

AgentTab is a **local browser runtime for AI agents**. It gives an agent task-owned tabs in the user's signed-in Chrome profile. Its boundary is execution coordination, not a separate Chrome profile, cookie jar, identity, or sandbox.

## Trust boundary and local attacker model

A task may use the profile already signed in to websites. An agent can therefore act with the permissions of the currently signed-in user on a task-owned tab. AgentTab does not expose raw cookies, storage, saved-password lists, or credential values through Standard mode. It does give a connected agent the profile's bookmarks, browsing history, recently closed and synced sessions, and download list, including saved file paths, through `browser_profile` (see [Profile operations](#profile-operations)). The 1Password broker is available by default unless owner-only policy disables it; the host may obtain one origin-matching Login item and send selected values directly to the owned page through the extension. That narrow path does not make the signed-in session untrusted or isolated.

The host authenticates its local IPC peers as the current OS user. This prevents a different local user from connecting through the user socket or named pipe. It does **not** distinguish benign and malicious processes running as that same user. A local attacker that can execute as the account, read AgentTab state, control the browser, or modify the extension/host installation is outside this protection. Use an OS account and a browser profile appropriate for the work, protect the account, and treat local malware as a full compromise.

Task-owned groups constrain ordinary AgentTab execution. They do not prevent a page, extension, process, or human with broader profile access from accessing the same signed-in account.

## Standard and Developer mode

Standard mode exposes exactly these ten MCP tools:

- `browser_open`
- `browser_snapshot`
- `browser_act`
- `browser_wait`
- `browser_tabs`
- `browser_handoff`
- `browser_commit`
- `browser_credentials`
- `browser_profile`
- `browser_finish`

Developer mode additionally exposes `browser_developer`. It is disabled by default in the host's local managed policy and is visibly marked on a task. Developer mode is intentionally a broader trust decision.

Standard mode has no raw CDP method, arbitrary JavaScript API, raw cookie or storage API, coordinate action, generic browser-global mutation API, or credential-value API. The narrow exceptions are `browser_open` with `placement: "new_window"`, which creates one unfocused normal window for the first tab of an empty task; `browser_credentials`, for private origin-matched 1Password fills or explicitly granted email-verification fills; and `browser_profile`, for the fixed bookmark, history, session, and download operations described below. Credential values are never returned. Internally, the extension uses Chrome debugging APIs for task-scoped accessibility snapshots and precise ref-based actions. Those implementation details are not a Standard-mode escape hatch.

Passkeys, security keys, CAPTCHA, payment secrets, account recovery, and unsupported verification require `browser_handoff`. The human completes the step in Chrome; no secret is placed in an AgentTab request.

## 1Password credential broker

The broker is available unless `policy.json` sets `one_password.enabled` to `false`. The host derives the current origin from its verified task-tab inventory, queries only 1Password Login items, and accepts an item only when a URL on that item matches the current host or a recognized authentication subdomain of the same registrable domain. Item titles and unrelated fields do not authorize a match.

`one_password.max_candidates` and `one_password.max_attempts` are each restricted to `1..3`. More than the configured candidate limit returns `needs_user` without selecting or exposing an item. A prepared attempt receives a random, short-lived token bound to the task, tab, origin, candidate position, and attempt count. Tokens are one-use for fill or advance, expire after five minutes, and are invalidated by navigation.

The host invokes the absolute `one_password.executable` when configured, or `op` from its process `PATH` otherwise. JSON output is captured in memory. The broker selects only username, password, and one-time-code fields, then sends them through the private host-to-extension credential method. Core RPC, MCP, OMP, Pi, and audit responses contain only candidate counts, booleans, attempt counters, and opaque tokens. Credential values are neither serialized into an adapter request nor written to audit output. A 1Password authentication timeout, no match, unsupported item, provider failure, exhausted attempts, or ambiguous candidate set returns `needs_user`.

## Email verification broker

Email verification is disabled by default and independent of the 1Password policy. Set an owner-managed `email_codes` grant for an exact origin, pathname, recipient, purpose, and sender domain before using `browser_credentials` with `action: "fill_email"`. Supported purposes are signup and email sign-in, not MFA, account recovery, or password entry.

The host derives the origin and pathname from its verified task-tab inventory, checks the grant before reading mail, verifies the active Gmail mailbox, and reads exactly the supplied message ID through the configured absolute `gws` executable. No mailbox search, mutation, or authentication setup occurs. Require a fresh message, Gmail's topmost `Authentication-Results`, aligned passing DKIM and DMARC, an allowed sender, the exact recipient, and one unambiguous code. Messages in Spam retain these same checks; drafts, sent mail, and trash are ineligible.

The code passes only over the private host-to-extension channel. Before writing, the extension checks task ownership, the current revision, exact origin and pathname, same-origin frames, every ref, and visible email-verification context for the intended recipient. Password, MFA, passkey, and human-challenge forms are refused. Recheck the origin, pathname, and target integrity around each write; stop and attempt to restore prior values if the page changes. A failure after input may have reached page listeners is `unknown`. On auto-submitting forms, you can complete verification during the final input event. Inspect the page before retrying an `unknown` result.

The public request contains message metadata and ordered refs, never a code value or caller-supplied origin. Only sanitized outcomes and fill metadata are returned. Use `browser_act` for explicit submission, preserving normal Commit review. See [setup](setup.md#email-verification-broker) for the policy fields.

A compatible ASCII `*` masked recipient is accepted automatically when it fits the exact granted recipient and no conflicting address is shown. Every ASCII `*` mask on the page must be the same bounded mask; the page must not display another full address that could match it. `fill_email` fills the code directly, without staging, popup approval, or `browser_commit`.[^email-mask]

Failure responses retain only allowlisted reason codes with fixed host-generated messages and recovery text. `email_code_recipient_unverified` means the page lacks an exact full recipient or a compatible mask. An absent or incompatible recipient remains refused before any write. Refreshing refs does not resolve missing recipient proof. Native error messages and details never cross this boundary.

Trusted forwarding requires an exact `relay_senders` address and an allowed original-sender domain in `Reply-To`, plus the intended recipient in the forwarded message.[^email-relay]

[^email-relay]: Gmail authenticates the relay's From domain. A relay's claimed original sender is not a separate cryptographic authentication of that sender; configure a relay only when you trust its forwarding and recipient attribution.

[^email-mask]: A compatible mask is not proof of an exact recipient on its own. Acceptance also requires the exact managed grant and a fresh authenticated message for that recipient; it does not override password, MFA, passkey, or human-challenge safeguards.

## Permissions

The manifest declares `nativeMessaging`, `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `bookmarks`, `history`, `sessions`, `downloads`, `webNavigation`, and `idle`, with `<all_urls>` host access. Chrome does not permit `debugger` in `optional_permissions`, so it is a required install-time permission. `scripting` remains optional: the popup requests it when automation is enabled and removes it when automation is turned off. `cookies`, `contentSettings`, and `activeTab` are not requested.

`debugger` is retained because the current task-scoped implementation needs Chrome's accessibility tree, ref-based action support, inactive captures, dialog handling, network-idle observation, and exact download completion attribution. Attachments are lazy, limited to owned tabs, reused briefly, and detached after idle work or optional `scripting` revocation. The permission is not evidence that Standard mode grants generic debugging access.

`bookmarks`, `history`, `sessions`, and `downloads` exist only for `browser_profile`. They back the operations listed in [Profile operations](#profile-operations), and no other AgentTab feature uses them. `webNavigation` lets `browser_wait` follow top-frame navigation commits, completions, same-document URL changes, and navigation errors on the waited tab, so load and URL conditions no longer depend on polling alone. `idle` lets handoff `status` report whether the human is active, idle, or locked. It reads only Chrome's coarse idle state, never keystrokes, pointer positions, or activity detail.

## Profile operations

`browser_profile` is the one Standard tool that works on the Chrome profile rather than on a task tab. Its boundaries are:

- **Read-only history.** `history_search` is the only history operation. AgentTab never deletes a history entry or range.
- **Bounded downloads.** Downloads can be searched, cancelled, paused, and resumed. AgentTab never opens a downloaded file, shows it in the file manager, removes it from disk, or erases it from Chrome's list.
- **Reviewed bookmark removal.** `bookmarks_remove` always stages a Commit record, even with YOLO mode on. It executes only after the human approves it in the popup and the agent then calls `browser_commit`. Commit reads the bookmark again and refuses if its title, URL, or parent changed since staging. A stage removes one bookmark or one empty folder. Bookmark create, update, and move run directly and carry idempotency keys. The invisible root, its top-level folders, and managed bookmarks cannot be changed.
- **Focus-safe restore.** `sessions_restore` never calls Chrome's session restore, which activates the restored tab or window. It reopens only the entry's `http` and `https` URLs, at most 25, as inactive background tabs owned by the task, so ownership, Pause, and finalization apply to them like any other task-created tab. No profile operation focuses Chrome, activates a window, or opens the popup.
- **Origin policy.** When managed origin policy sets allowed or denied origins, the host refuses `sessions_restore` before execution with `origin_policy_unverifiable`, because restored URLs cannot be checked against the policy before they open. Callers can open each URL through `browser_open`, which the policy checks. Origin policy governs navigation; it does not filter which bookmarks, history entries, sessions, or downloads a read returns.
- **Pause and permissions.** Profile operations need no site access, so they work without the optional `scripting` permission. They still respect Pause: while AgentTab is paused they fail as not started.
- **Private data stays with the caller.** Titles, URLs, file names, and search text appear only in the result returned to the requesting agent. The extension does not log them, and they are not written to audit (see [Local audit data](#local-audit-data-and-operational-records)). Write results, which the host keeps as idempotency records, carry identifiers and state only. The bookmark title and URL shown in the Commit review stay in extension storage for the popup. The host's staged record holds a fixed effect name and a fingerprint salted with the one-use token, so the fingerprint cannot be matched against guessed URLs. Collapsed OMP and Pi cards show counts and identifiers only.

These rules limit what the tool can change. They do not limit what a connected agent learns from a read: anyone who can drive `browser_profile` can read the profile's history, bookmarks, synced tabs, and download paths.

## Browser-restricted origins

Chrome refuses extension page scripting or debugger access on browser-owned surfaces, including `chrome://`, `chrome-extension://`, `devtools://`, and the Chrome Web Store. Local host policy and extension permissions cannot remove that platform boundary.

AgentTab classifies every opened or listed task tab as `automation_route: "full"` or `"tab_only"`. Ownership remains required for both routes. On `tab_only`, agent-driven controls are limited to tab-lifecycle operations that Chrome still exposes: explicit navigation, reload, close, and load or URL waits. History movement is also available when managed origin constraints are absent. When constraints exist, AgentTab rejects history movement because Chrome does not expose its destination for authorization before navigation; callers must navigate explicitly to an allowed URL. Download waits require the `full` route because Chrome's browser-global downloads API does not identify the initiating tab, while the debugger events used for exact attribution are unavailable on restricted origins. `browser_handoff` remains available because AgentTab blacks out observation while the human controls the task tab. Snapshot, page-content wait, element action, page-dependent Commit, and raw Developer-mode CDP requests fail before script or debugger execution with `browser_restricted_origin` and `outcome: "not_started"`. A staged close remains executable through `browser_commit` because it uses Chrome's tab-lifecycle API without page access; ownership, revision, approval, token, and expiry checks still apply. Managed origin policy still validates HTTP and HTTPS tab-only pages and every explicit navigation target. Browser-owned non-HTTP pages cannot match an origin allowlist, so AgentTab admits only the same tab-only recovery operations there. In-page interaction requires an exact-tab human handoff; do not escalate to desktop-wide or browser-window-scoped input.

## Debugger-refused tabs

Chrome can refuse `chrome.debugger` on an ordinary page, for example while another extension's frame is on the page or DevTools holds the tab. AgentTab then serves top-frame page work through its scripting route: a page agent injected into the extension's isolated world of the tab's top document. The route keeps every Standard boundary: task ownership, origin policy, expected revisions, refs bound to Chrome's document id, sensitive-field refusal, Commit classification, and credential isolation. The agent shares the DOM with the page but not the page's JavaScript globals; only the `window.open` trap that keeps a gesture's popups in background task tabs runs in the page's main world, and only for the duration of that gesture. Scripted actions dispatch DOM events without Chrome user activation, so a page that requires a trusted gesture can ignore them. Work that only the debugger can do (frame-scoped control, drag, file upload, dialogs, download attribution, network-idle waits, and full-page or background-tab screenshots) fails with `debugger_unavailable` and `outcome: "not_started"`. AgentTab retries the debugger after 30 seconds or the next navigation instead of re-attaching on every command, which would flash Chrome's debugging banner.

## Ownership, revisions, and human control

A tab becomes owned only when AgentTab creates it, when Chrome reports it as a child of an owned opener, or through `browser_open` with `mode: "adopt_active"`. The visible Chrome group is evidence of that ownership, not an authority grant by itself. Moving or ungrouping a tab revokes ownership and cancels queued work. A grouping failure rolls creation or adoption back rather than retaining invisible ownership. A caller may request `placement: "new_window"`, but the extension derives eligibility from its stored task record: the task must own no tabs, the window is created unfocused in normal state, and a failed group grant removes the created tab. A client-supplied ownership claim cannot authorize an existing window.

Actions that operate on an existing page carry an expected page revision. Navigation and document replacement advance that revision; stale refs and stale revisions fail instead of being applied to a later document.

**Pause agents** closes admission, waits for already-dispatched work to settle, rejects queued work as not started, and persists the paused state before reporting it. Resume reconciles ownership first.

## Prompt injection and Commit limitations

Page text, HTML, labels, screenshots, accessibility names, and downloads are untrusted data. A page can attempt to persuade an agent to reveal data, broaden access, ignore policy, or act outside the user's purpose. AgentTab cannot decide whether instructions embedded in page content are trustworthy. Agents and their operators must treat page content as data, constrain their task, inspect consequential previews, and stop when the page asks for unrelated access or secrets.

Before a Standard mutation, the extension prepares the target, classifies recognizable effects, revalidates it, and then executes it. Recognizable send, publish, purchase, delete, upload, authorization, and permission-grant controls execute directly by default. When YOLO mode is turned off, the same controls instead stage a five-minute, one-use Commit record. The record binds the task, tab, page revision, event, target fingerprint, effect, and preview. The extension popup sends only an opaque review handle. A successful popup approval durably marks the stage approved but does not consume its token or dispatch the browser action. Only a later agent `browser_commit` can consume that approved stage; execution rechecks ownership, revision, expiry, and fingerprint.

Commit is an optional, best-effort semantic barrier, not proof that an action is harmless. In review mode it requires two distinct events: human approval in the popup and the agent's later Commit request. A page can hide an external effect behind an innocent label, alter meaning through script, or use an effect AgentTab does not recognize. Harmless-looking controls may execute without review. Batches are sequential and non-atomic: review mode stops before a staged action and never runs later actions implicitly.

YOLO mode is enabled by default. It bypasses only optional Commit review. Task ownership, origin policy, expected revisions, restricted-origin routing, credential isolation, and action validation remain enforced. Turning YOLO mode on discards pending staged actions; turning it off restores the two-party Commit flow. Always obtain popup approval for `browser_profile` bookmark removal.

## Attention notices

A `browser_handoff` request records an advisory attention notice for one task tab. Notices never gate command admission, scheduling, Pause, or finalization, and a request never focuses a tab, activates a window, or opens the popup by itself. The human completes the step in Chrome and tells the agent; the agent then verifies the page itself before resolving or dismissing the notice. The popup can explicitly focus the exact noticed tab when the user clicks Open tab, and Dismiss only hides the reminder.

Notice `status` also reports `user_idle_state` as `active`, `idle`, or `locked`, taken from Chrome's idle detection with a 60-second threshold, so an agent can tell whether the human is likely at the machine. The value carries no input or activity detail, and it never gates or schedules work.

This keeps human-only input out of agent requests. It cannot protect secrets from a compromised device, a malicious webpage, or browser extensions with their own access.

## Bot-challenge detection

The extension reports a `challenge` member when a task-owned tab shows a recognized bot-challenge page or widget. Detection is advisory and bounded by these points:

- **Spoofed challenges.** A page can imitate catalog markers to provoke a handoff or trip the act guard. A handoff only shows a notice bound to the real tab and origin, and the guard only refuses input, which is a denial of service the page could already cause. Treat page content as untrusted regardless.
- **Hidden challenges.** Absence of `challenge` is not proof that a page is usable.
- **No page text.** The event contains only catalog identifiers, enums, integers, and an origin. No page-controlled text, URL path or query, or sitekey enters it, so it adds no prompt-injection surface.
- **Tokens never read.** A response token is never read out, copied, or written. `token_present` is a boolean computed inside the page.
- **Bundled catalog.** The catalog ships with the extension and is reviewed like code. Nothing is fetched at runtime.

## Upload guardrails

`upload_file` is available only for regular files below a configured `dlp_allowed_roots` path and under the configured size limit. The host canonicalizes the path, rejects symlink races and Unix hard-linked files, verifies the opened file, copies it into a private staging directory, and uses the staged copy for the action. Each copy keeps the source file name inside its own per-upload directory, because pages derive the uploaded file's name and type from it. On Unix, staging directories are mode `0700` and staging files are mode `0600`. Chrome reads a file input's bytes only when the page reads or submits the file, so an upload that reached the page stays on disk for 10 minutes before the host removes it. Uploads that never reach the page are removed immediately, and a starting host removes per-upload directories older than 15 minutes that an exited host left behind.

These checks limit accidental path selection. They do not establish that a permitted file is safe to disclose or that the destination is trustworthy. Upload is a recognizable Commit effect and should be reviewed by the human.

## Resume capabilities and durable state

A Core connection receives a task lazily on first browser work. A resume capability is a 256-bit random bearer secret: the host returns it once and persists only its SHA-256 hash, and the client must durably persist and confirm it before another RPC. A successful resume returns a rotated capability under the same persist-then-confirm barrier. `conversation_id` is metadata only and never authorizes a task.

Adapters must store a capability in owner-only private state and must not log, display, or share it. Losing it does not expose a task, but reconnecting without it creates a new task. Treat a capability like a local session secret.

The host stores task state, ownership, revision floors, staged Commit records, event receipts, and idempotency records in local SQLite with WAL and full synchronous writes. Attention notices live in extension storage, not host admission state. Mutations use UUIDv7 idempotency keys. A completed record returns its cached result; a durable started record after a crash returns `unknown` and is never replayed.

## Local audit data and operational records

Audit is local, enabled by default, and written to `audit.jsonl` under the AgentTab state directory. On Unix the file is mode `0600`. Each record contains timestamps, connection ID, task ID when assigned, request ID, method, outcome, duration, replay flag, target origins, a structural argument summary, an argument digest, structural result summary, error code, recovery text, and, when a result or error carries a bot-challenge event, a fixed `challenge` summary. The summary holds catalog vendor and product identifiers, enum values (`kind`, `interaction`, `state`, `confidence`, and `resolved_by` of `wait`, `handoff`, `navigation`, or `observed`), the challenge ID, the page origin, and an elapsed time in milliseconds. It carries no page text, URL path, or token, and it stays in the local audit file like the other fields. It does not intentionally store raw argument or result values, but origins, object keys, string lengths, error text, and digests can still be sensitive operational metadata. Restrict access to the state directory.

For `browser_profile`, the record also names the `operation`. Every other string argument is replaced by a length-only redaction marker before the argument summary, digest, and target origins are computed, so bookmark titles, URLs, folder names, and search text never reach the audit file. The result summary is structural, as for every method.

SQLite event receipts and idempotency records are local reliability data, not user-visible proof that an external side effect occurred. Audit can be disabled only through the local managed policy. Neither record type is a replacement for reviewing the website or its own receipt.

## Signing and release status

The source includes installer verification for signed artifact manifests and platform signatures, but the checked-in release-trust configuration has no development or stable public key. No signed v2 artifact, registry package, Web Store listing, hosted privacy page, or stable release is established by this source tree. `2.0.0-rc.1` is prerelease and unreleased. Do not infer publication, notarization, Authenticode, provenance, or store approval from local code.

## Responsible disclosure

Do not publish exploitable details, credentials, capability values, or user data in an issue. Send a minimal reproduction, affected version or commit, platform, impact, and suggested mitigation through a private maintainer channel. This repository does not declare a separate security contact in source; use private GitHub reporting only if the repository enables it, otherwise contact the maintainers privately before public disclosure. Allow time for acknowledgement and a fix before coordinated public disclosure.
