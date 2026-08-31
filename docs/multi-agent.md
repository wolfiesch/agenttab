# Multi-agent task model

AgentTab coordinates multiple agents through server-owned tasks, not through client-selected identities, global leases, or shared browser control.

## Connection-bound tasks

Each Core RPC connection receives a host-generated connection ID. On its first browser request, the host lazily creates a task and binds it to that connection. The connection's `conversation_id` is retained only as metadata. A caller-supplied task, owner, or conversation identifier never grants access.

A fresh adapter connection therefore gets a distinct task. Adapters that need to reconnect must retain the resume capability supplied for that task. HTTP MCP sessions must use separate Core connections so their tasks cannot be shared accidentally.

## Resume capabilities

A resume capability is a 256-bit random bearer secret. The host persists only its hash. A client must durably persist and confirm an initial capability before the host accepts another RPC. On successful resume the host returns a replacement capability under the same persist-then-confirm barrier; if delivery or confirmation fails, a durably retained capability remains recoverable. Once a replacement is confirmed, the old capability no longer resumes the task.

Store the capability only in adapter-owned private state. Never put it in prompts, page content, logs, task titles, or shared configuration. A missing or invalid capability creates a new task rather than recovering another agent's task.

## Task-owned tabs and visible groups

Only three paths can grant tab ownership:

1. AgentTab creates a tab through `browser_open` with `mode: "create"`.
2. Chrome reports a child tab whose opener is already owned.
3. The user permits `browser_open` with `mode: "adopt_active"` for the currently active tab.

AgentTab tries to give owned tabs a visible task group. The group makes work legible to the user, but the persisted task ledger is authoritative: group membership never grants, transfers, or revokes ownership. Manual grouping does not adopt a tab, and a Chrome grouping failure does not block creation or adoption.

`browser_open` defaults to placing a new tab in the task's existing window. `placement: "new_window"` is intentionally narrower than a general window-control capability: it is accepted only while the task owns no tabs, it always creates an unfocused normal window, and the extension grants ownership from the persisted task record. It cannot focus, resize, move, change, or close an unrelated window. `browser_handoff` remains the sole normal focus transition.

Moving or ungrouping an owned tab changes only its presentation. Closing it or explicitly closing its task revokes ownership, increments the tab generation, and rejects queued work before dispatch. A child-popup grouping race does not give AgentTab authority to close a user tab.

Numeric Chrome tab IDs are authoritative only within one browser session. The extension mirrors a random browser-session epoch between `chrome.storage.session` and durable local state. If the marker changes after a full browser restart, extension reload, or update, AgentTab clears persisted tab, revision, staged-action, debugger-cleanup, and handoff bindings before the native handshake. A newly reused numeric tab ID therefore cannot inherit an earlier task's authority.

## Ordering and concurrency

Mutations for one tab are ordered. Reads wait behind the relevant tab mutation so they do not observe an in-progress change. Lightweight task lifecycle work is ordered per task.

Separate tabs can make progress concurrently, including tabs owned by the same task. Separate tasks use independent host request locks and extension ownership actors, so a slow create or assertion in one task does not hold up another. Full ownership reconciliation is a cross-actor barrier. There is no browser-global queue in the routine request path; only explicit lifecycle barriers such as Pause stop unrelated work.

Task close installs a durable tombstone before admitting further lifecycle work. It waits behind already-running task lifecycle work, rejects queued or later opens, drains the task's tab actors, persists task deletion, and only then asks Chrome to remove the tabs. Native and popup close use the same path. Tombstones are intentionally not TTL-pruned: without an explicit host retirement acknowledgement, expiry could let a delayed closed-task capability recreate ownership. On the host, `browser_act`, `browser_handoff`, and the `browser_commit` token derived from an act resolve to the same tab queue, so arrival order cannot reverse at the handoff/commit boundary.

Every existing-page mutation includes `expected_page_revision`. The host and extension reject actions when ownership, document revision, or ref epoch no longer matches. A page snapshot does not grant an indefinite right to act on a later page.

## Pause and recovery

Pause is a barrier, not an optimistic UI toggle. It stops new admissions, lets already-dispatched work settle, rejects waiting work as not started, and persists the paused state. On restart, the extension restores paused state before reconciliation. Resume reconciles ownership before reopening admission.

A host that has not completed its native handshake and reconciliation remains unavailable for browser work. The connection status can report its lifecycle, but callers must retry only after it becomes ready or the user resumes it.

## Tab-scoped Your Turn blackout

Only one handoff can be active in the popup at a time. Starting `browser_handoff` blocks and drains the declared tab, records the marker durably, detaches that tab's debugger session, and focuses it for the human. Work on that tab is denied across connections while unrelated tabs and tasks continue. The host independently enforces the exact task/tab binding and restores it after restart from SQLite state. If the extension disconnects before its binding can be reconciled, the host temporarily fails closed for all tabs.

Automation on the handed-off tab resumes only after the declared completion condition or explicit completion, tab capture scrubbing, and an acknowledged handoff-clear event. A manual global Pause remains independent and can keep all automation paused. Handoff is the sole normal AgentTab focus transition for human input.

## Consequential work across agents

Each recognizable consequential Standard action stages its own Commit. A staged token is bound to one task and tab, expires after five minutes, revalidates the page revision and target fingerprint, and executes once. A batch stops at its first staged action; another agent cannot use that stage to run later batch items.

There are no agent-facing global lease tools. Coordinating intent is still the responsibility of the agents and the user. Use distinct tasks for independent work, observe task counts in the extension, and have the human review staged effects before Commit.
