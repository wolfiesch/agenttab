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

AgentTab gives owned tabs a visible task group. The group makes work legible to the user, but group membership alone never grants authority. Manual grouping does not adopt a tab. If Chrome cannot create or preserve the group, creation or adoption fails rather than keeping hidden ownership.

`browser_open` defaults to placing a new tab in the task's existing window. `placement: "new_window"` is intentionally narrower than a general window-control capability: it is accepted only while the task owns no tabs, it always creates an unfocused normal window, and the extension grants ownership from the persisted task record. It cannot focus, resize, move, change, or close an unrelated window. `browser_handoff` remains the sole normal focus transition.

Moving an owned tab out of its task group, ungrouping it, closing it, or finding inconsistent ownership immediately revokes it. Revocation increments the tab generation and rejects queued work before it is dispatched. A child-popup grouping race does not give AgentTab authority to close a user tab.

## Ordering and concurrency

Mutations for one tab are ordered. Reads wait behind the relevant tab mutation so they do not observe an in-progress change. Browser-global operations use a separate global barrier.

The current extension scheduler also maintains an ordered tail per task. It therefore does **not** promise parallel mutation execution for separate tabs in the same task, even though separate connections and host request handling can be concurrent. Different tasks can make progress independently unless a global barrier applies. Do not build an adapter that depends on cross-tab write parallelism.

Every existing-page mutation includes `expected_page_revision`. The host and extension reject actions when ownership, document revision, or ref epoch no longer matches. A page snapshot does not grant an indefinite right to act on a later page.

## Pause and recovery

Pause is a barrier, not an optimistic UI toggle. It stops new admissions, lets already-dispatched work settle, rejects waiting work as not started, and persists the paused state. On restart, the extension restores paused state before reconciliation. Resume reconciles ownership before reopening admission.

A host that has not completed its native handshake and reconciliation remains unavailable for browser work. The connection status can report its lifecycle, but callers must retry only after it becomes ready or the user resumes it.

## Your Turn coordination

Only one handoff can be active. Starting `browser_handoff` records the marker and completion condition durably, focuses the human's task tab, and returns without pausing the scheduler. Browser requests from the same or other tasks remain eligible. The host restores the active marker after restart from SQLite state.

The handoff clears after the declared completion condition or explicit completion and an acknowledged handoff-clear event. It is the sole normal AgentTab focus transition for human input, but it is not an observation blackout. Use `browser_credentials` for ordinary sign-in fields or explicitly pause agents when the handoff page must remain unobservable.

## Consequential work across agents

With default YOLO mode, recognizable consequential Standard actions execute inline after validation. Turning YOLO mode off stages each action as a Commit bound to one task and tab. The token expires after five minutes, revalidates the page revision and target fingerprint, and executes once. In review mode a batch stops at its first staged action; another agent cannot use that stage to run later batch items.

There are no agent-facing global lease tools. Coordinating intent is still the responsibility of the agents and the user. Use distinct tasks for independent work and observe task counts in the extension. Turn YOLO mode off when human review of staged effects is desired.
