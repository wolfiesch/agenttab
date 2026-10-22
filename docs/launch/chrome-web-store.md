# DRAFT ONLY - AgentTab v2 Chrome Web Store review preparation

**Release status:** AgentTab `v2.0.0-rc.1` is unreleased. v1.0.1 remains the stable legacy release. This document is preparation copy only. It is not authorization to create, upload, submit, publish, or edit a Chrome Web Store listing.

## Proposed listing fields

### Title

AgentTab: Browser Access for AI Agents

### Short description

Give local AI agents controlled access to your signed-in Chrome profile.

### Category

Local browser runtime for AI agents

### Tagline

Any agent. Your browser. Your rules.

### Detailed description

AgentTab is a local browser runtime for AI agents that need to work in the Chrome profile already on your computer. Its operating promise is simple: **Give an agent a tab, not the keys to your browser.**

An agent starts with a task workspace, not general access to every tab. AgentTab creates or visibly adopts a tab for that task, keeps task-owned tabs distinct, and serializes writes to the same tab. Task groups are a visible status aid only. They never grant ownership. A task may create child tabs from its owned tabs, but it cannot claim arbitrary tabs merely because they appear in a group.

The runtime consists of one minimal MV3 extension, a local Rust host, and per-user operating-system-native IPC. The extension uses Chrome Native Messaging to reach the local host. Client adapters, including MCP, connect to the host through a user-owned Unix socket on macOS and Linux or a current-user named pipe on Windows. AgentTab has no cloud relay, remote browser session, telemetry service, or routine network control plane.

Standard MCP access exposes exactly ten tools: `browser_open`, `browser_snapshot`, `browser_act`, `browser_wait`, `browser_tabs`, `browser_handoff`, `browser_commit`, `browser_credentials`, `browser_profile`, and `browser_finish`. The finalization tool applies provenance-aware cleanup: task-created tabs close by default, adopted tabs are retained, retained tabs are ungrouped, and task ownership is released. The local 1Password broker is available by default unless owner-only policy disables it, and the credential tool never returns a credential value. The profile tool lets an agent search and organize bookmarks, search browsing history, reopen recently closed or synced tabs as background task tabs, and find, cancel, pause, or resume downloads, without bringing Chrome to the front. `browser_developer` is available only after a persistent, explicit Developer mode opt-in. Standard mode does not expose raw cookie, storage, arbitrary script, CDP, or network APIs.

### Human controls

The local 1Password broker can fill one of at most three origin-matching Login items directly into a selected field without revealing the value to the agent. **Needs your attention** notices remain the path for passkeys, security keys, CAPTCHA, payment secrets, account recovery, unsupported verification, or a broker result that needs the user. A notice is advisory: it never pauses agent work, focuses a tab, or opens a popup by itself, and the user's explicit Open tab click is the only focus transition. The agent verifies the page itself before resolving a notice. AgentTab does not capture human keystrokes.

Recognizable sends, publishes, purchases, deletes, uploads, authorizations, and permission grants execute directly by default. Users can turn YOLO mode off to enable the best-effort **Commit** review barrier. In that mode, AgentTab prepares, classifies, and revalidates the target, stages the action with a preview, and requires approval in a human popup plus the requesting agent's one-use token. The record expires after a short interval, cannot be replayed, and is invalidated if the page or target changes. Commit reduces recognizable risk; it cannot prove that a page has no hidden external effect.

Removing a bookmark always goes through that popup review, even when YOLO mode is on, and the review shows the bookmark's title and URL. AgentTab never deletes browsing history, and it cannot open, reveal, delete, or erase a downloaded file.

### Trust boundary

AgentTab can operate in the signed-in Chrome profile the user already uses. Task ownership is an execution and coordination boundary, not cookie, account, password, or profile isolation. A trusted local agent can act within an owned tab through the same signed-in web session available to the person at the keyboard, and through the profile tool it can read the profile's bookmarks, browsing history, recently closed and synced tabs, and download list. Users should connect only agents and local software they trust.

Browser automation also remains exposed to hostile or misleading page content. A page can attempt prompt injection, a control can have consequences that are not apparent from its label, and an agent can make a poor decision from ordinary page content. Attention notices and Commit address bounded parts of that risk. They are not guarantees against every external side effect.

## Manifest permissions and host permissions

This section is draft review copy for the v2 contract. It must be reconciled against the final canonical store package before any controlled review. Every entry serves the listing's single purpose: letting local AI agents the user connects do browser work in the user's own Chrome profile under the user's control. AgentTab requires the `<all_urls>` host permission so its `chrome.scripting` text, HTML, selector, wait, and scroll paths can run on task-owned pages the user directs an agent to use. That permission does not expose raw storage, cookies, JavaScript, CDP, or network APIs in Standard mode.

| Manifest entry | Type | Review justification |
|---|---:|---|
| `nativeMessaging` | Required permission | Connects the MV3 extension to the user-installed local AgentTab host. It is the extension-to-host link for task ownership, lifecycle reconciliation, Commit staging, and command results. It does not connect the extension to a cloud service. |
| `debugger` | Required permission | Supports the task-scoped browser capabilities required for accessibility snapshots, precise click, type, fill, select, scroll, key press, inactive screenshots, network-idle observation, and exact download completion attribution. AgentTab attaches lazily only to task-owned tabs, reuses the task connection while needed, and exposes no generic CDP method in Standard mode. |
| `tabs` | Required permission | Lets AgentTab create and visibly adopt task tabs, track their lifecycle and document revision, focus an attention notice's tab only when the user clicks Open tab, and clean up a closed task. It is not used to make unrelated tabs owned by an agent. |
| `tabGroups` | Required permission | Shows task-owned tabs as a visible workspace with working, needs-you, or finished status. Group membership is display-only and never authorizes an operation. Removing or moving a tab out of its task group revokes its ownership. |
| `storage` | Required permission | Persists the minimum extension state needed to recover task status, pause state, attention notices, revision floors, and user interface preferences across MV3 service-worker restarts. It is not an analytics store and is not used to collect browsing history. |
| `alarms` | Required permission | Schedules bounded MV3 lifecycle work such as reconnect, expiry, and recovery checks after service-worker suspension. It is not used for tracking, advertising, or remote scheduling. |
| `bookmarks` | Required permission | Lets an agent the user has connected find, read, create, rename, and move the user's bookmarks when the user asks it to find or organize saved pages. Removing a bookmark always waits for the user's approval in the AgentTab popup, and root and managed bookmark folders cannot be changed. Bookmark data goes only to the requesting local agent and is not sent to the developer or written to AgentTab logs or audit records. |
| `history` | Required permission | Lets the agent search the user's browsing history to find a page the user visited, for example to reopen it in a task tab. Access is read-only: AgentTab never deletes history entries. Results go only to the requesting local agent and are not sent to the developer or written to AgentTab logs or audit records. |
| `sessions` | Required permission | Lets the agent list recently closed tabs and windows and the tabs open on the user's other signed-in devices, and reopen one at the user's direction. AgentTab never calls Chrome's session restore, which would bring Chrome to the front. It reopens only the entry's web pages, at most 25, as background tabs owned by the agent's task, and it refuses to reopen anything when a managed site policy restricts origins. |
| `downloads` | Required permission | Lets the agent find a download by name or state and cancel, pause, or resume it as part of the user's task. AgentTab cannot open a downloaded file, show it in the file manager, delete it from disk, or erase it from Chrome's download list. Results go only to the requesting local agent and are not written to AgentTab logs or audit records. |
| `webNavigation` | Required permission | Lets AgentTab detect exactly when a task-owned tab finishes loading, changes URL (including in-page history and fragment changes), or fails to navigate, so an agent's wait for a page to load or reach a URL ends at the right moment. It adds no agent-facing browsing-data interface. |
| `idle` | Required permission | Lets AgentTab tell an agent whether the user is active, idle, or has locked the screen when the agent checks a **Needs your attention** notice, so the agent knows whether the user is likely to see it. It reads only Chrome's coarse idle state, never keystrokes or activity detail, and it never pauses or starts work. |
| `scripting` | Optional permission | Requested only after the user explicitly clicks **Enable AgentTab automation** in the AgentTab popup. It is not a required install-time permission, denial leaves the extension visibly disabled, and it does not add a Standard raw-script API. |
| `<all_urls>` | Required host permission | Required so the `chrome.scripting` text, HTML, selector, wait, and scroll paths can run on the task-owned page the user directs AgentTab to use, regardless of its site. It does not let an agent claim tabs or expose raw cookies, browser storage, arbitrary JavaScript, CDP, or network APIs in Standard mode. |

## Reviewer setup notes

These notes are for a controlled reviewer package only. They are not public installation instructions.

1. Use a dedicated Chrome test profile and test accounts with no personal data, payment instruments, or production administrative access.
2. Provide the exact `v2.0.0-rc.1` extension package together with the matching separately installed local AgentTab host. The extension should report that it is disconnected until the compatible local host is ready.
3. Reconcile the package identity and native-host allowed origins with `config/identity.json` before review. Do not infer an identity from this document or treat it as store publication evidence.
4. Demonstrate a local MCP client opening a task workspace, taking an accessibility snapshot, performing a harmless action, waiting for a defined condition, and listing only that task's tabs.
5. Demonstrate an attention notice with a harmless test page. Verify that requesting `browser_handoff` does not pause work, focus a tab, or open the popup; that reads, actions, waits, and finalization remain available while the notice is open; that the user's Open tab focuses only the noticed tab; and that the agent resolves the notice only after verifying the page, with dismiss and expiry never reported as success.
6. Demonstrate `browser_profile` with test bookmarks and a harmless test site. Verify that search, create, and move work on a test folder; that `bookmarks_remove` returns `commit_required` and leaves the bookmark in place until the popup approves it and the agent commits, even with YOLO mode on; and that `sessions_restore` reopens a recently closed test tab as a background task tab without focusing Chrome.
7. Demonstrate default inline execution with a harmless controlled effect. Then turn YOLO mode off and verify that a controlled recognizable action does not execute before the human popup approves the staged action with the requesting agent's one-use Commit token. Do not use a real message, purchase, upload, deletion, or authorization.
8. Demonstrate Pause and Resume, including that queued work does not start after Pause and that task status remains visible after recovery.
9. Verify that Standard discovery exposes exactly the ten Standard tools, that `browser_finish` retains an adopted tab while releasing its task ownership, that `browser_credentials` reaches a fake provider by default and returns a disabled-policy result after explicit opt-out, and that the Developer-only tool is absent until the reviewer explicitly enables Developer mode.

## Privacy declaration draft

AgentTab operates locally on the user's computer. It does not collect, sell, share, or transmit user data to the developer or to a remote service. It has no telemetry, analytics endpoint, cloud relay, or hosted browser session.

The extension and local host process browser information only to perform the user's requested task workflow. That information may include the content and state of task-owned tabs, accessibility snapshots, screenshots, action targets, download events, and handoff or Commit state. When the user's agent requests it, it may also include the profile's bookmarks, browsing history, recently closed and synced tabs, and download list, including saved file locations. That profile data is returned only to the requesting local agent and is not written to AgentTab logs or audit records. Standard mode does not return raw cookies, browser storage, passwords, arbitrary scripts, raw CDP, or raw network data to agents.

The local host and extension communicate through Chrome Native Messaging and per-user operating-system-native IPC. Local task and recovery state remains on the user's computer. The `<all_urls>` host permission is limited to the defined `chrome.scripting` text, HTML, selector, wait, and scroll paths on task-owned tabs, not a Standard raw browser-data interface.

The public privacy policy is published at `https://agenttab.wolfie.gg/privacy/` and the support destination at `https://agenttab.wolfie.gg/support/`. The first store submission was rejected on September 4, 2026 under User Data Privacy ("Privacy policy link is broken or unavailable") because no privacy policy was publicly hosted at the time. Enter only these verified URLs in the listing.

## Asset and submission checklist

None of these items is represented as complete by this draft. Verify each item against the final package and controlled hosting before any submission.

- [ ] Final store package built from the frozen `v2.0.0-rc.1` source and package identity.
- [ ] Required 16, 32, 48, and 128 pixel icons verified in the final package.
- [ ] Store promotional image in the required current dimensions.
- [ ] Screenshots that show a task workspace, an attention notice, Commit staged but not approved, and the local-only status without exposing identity, URLs, secrets, or local paths.
- [ ] Scrubbed reviewer demonstration using a dedicated test profile and accounts.
- [x] Public privacy-policy destination verified under controlled hosting.
- [x] Public support destination verified under controlled hosting.
- [ ] Store title, short description, category, permission rationale, and reviewer instructions reconciled with the exact final package.
- [ ] Chrome Web Store item identity checked against `config/identity.json` without adding an unverified public URL to launch copy.
- [ ] Explicit authorization received for any upload, submission, review request, or publication.
