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

Standard MCP access exposes exactly seven tools: `browser_open`, `browser_snapshot`, `browser_act`, `browser_wait`, `browser_tabs`, `browser_handoff`, and `browser_commit`. `browser_developer` is available only after a persistent, explicit Developer mode opt-in. Standard mode does not expose raw cookie, storage, arbitrary script, CDP, or network APIs.

### Human controls

**Your Turn** is for passwords, passkeys, two-factor authentication, CAPTCHA, payment secrets, and other human-only input. During a handoff, AgentTab applies an observation blackout: standard capture and observation requests for every task return `needs_user`. The runtime clears the blackout only after the declared completion condition or explicit Done and its recovery checks. AgentTab does not capture human keystrokes.

**Commit** is a best-effort review barrier for recognizable sends, publishes, purchases, deletes, uploads, authorizations, and permission grants. Before acting, AgentTab prepares, classifies, and revalidates the target. A recognizable consequential action is staged with a preview, then requires approval in a human popup and the requesting agent's one-use token. The record expires after a short interval, cannot be replayed, and is invalidated if the page or target changes. Harmless actions proceed without Commit review. Commit reduces recognizable risk; it cannot prove that a page has no hidden external effect.

### Trust boundary

AgentTab can operate in the signed-in Chrome profile the user already uses. Task ownership is an execution and coordination boundary, not cookie, account, password, or profile isolation. A trusted local agent can act within an owned tab through the same signed-in web session available to the person at the keyboard. Users should connect only agents and local software they trust.

Browser automation also remains exposed to hostile or misleading page content. A page can attempt prompt injection, a control can have consequences that are not apparent from its label, and an agent can make a poor decision from ordinary page content. Your Turn and Commit address bounded parts of that risk. They are not guarantees against every external side effect.

## Manifest permissions and host permissions

This section is draft review copy for the v2 contract. It must be reconciled against the final canonical store package before any controlled review. AgentTab requires the `<all_urls>` host permission so its `chrome.scripting` text, HTML, selector, wait, and scroll paths can run on task-owned pages the user directs an agent to use. That permission does not expose raw storage, cookies, JavaScript, CDP, or network APIs in Standard mode.

| Manifest entry | Type | Review justification |
|---|---:|---|
| `nativeMessaging` | Required permission | Connects the MV3 extension to the user-installed local AgentTab host. It is the extension-to-host link for task ownership, lifecycle reconciliation, handoff state, Commit staging, and command results. It does not connect the extension to a cloud service. |
| `debugger` | Required permission | Supports the task-scoped browser capabilities required for accessibility snapshots, precise click, type, fill, select, scroll, key press, inactive screenshots, and task-scoped helpers. AgentTab attaches lazily only to task-owned tabs, reuses the task connection while needed, and exposes no generic CDP method in Standard mode. |
| `tabs` | Required permission | Lets AgentTab create and visibly adopt task tabs, track their lifecycle and document revision, focus a handoff tab when the user asks, and clean up a closed task. It is not used to make unrelated tabs owned by an agent. |
| `tabGroups` | Required permission | Shows task-owned tabs as a visible workspace with working, needs-you, or finished status. Group membership is display-only and never authorizes an operation. Removing or moving a tab out of its task group revokes its ownership. |
| `storage` | Required permission | Persists the minimum extension state needed to recover task status, pause state, handoff blackout state, revision floors, and user interface preferences across MV3 service-worker restarts. It is not an analytics store and is not used to collect browsing history. |
| `alarms` | Required permission | Schedules bounded MV3 lifecycle work such as reconnect, expiry, and recovery checks after service-worker suspension. It is not used for tracking, advertising, or remote scheduling. |
| `downloads` | Required permission | Lets the task runtime coordinate Chrome downloads that result from an owned task and lets `browser_wait` observe the defined download condition. Chrome keeps its normal download handling and destination controls. |
| `scripting` | Optional permission | Requested only after the user explicitly clicks **Enable AgentTab automation** in the AgentTab popup. It is not a required install-time permission, denial leaves the extension visibly disabled, and it does not add a Standard raw-script API. |
| `<all_urls>` | Required host permission | Required so the `chrome.scripting` text, HTML, selector, wait, and scroll paths can run on the task-owned page the user directs AgentTab to use, regardless of its site. It does not let an agent claim tabs or expose raw cookies, browser storage, arbitrary JavaScript, CDP, or network APIs in Standard mode. |

## Reviewer setup notes

These notes are for a controlled reviewer package only. They are not public installation instructions.

1. Use a dedicated Chrome test profile and test accounts with no personal data, payment instruments, or production administrative access.
2. Provide the exact `v2.0.0-rc.1` extension package together with the matching separately installed local AgentTab host. The extension should report that it is disconnected until the compatible local host is ready.
3. Reconcile the package identity and native-host allowed origins with `config/identity.json` before review. Do not infer an identity from this document or treat it as store publication evidence.
4. Demonstrate a local MCP client opening a task workspace, taking an accessibility snapshot, performing a harmless action, waiting for a defined condition, and listing only that task's tabs.
5. Demonstrate Your Turn with a harmless test page. Verify that observations from every task return `needs_user` during the handoff and that the agent resumes only after Done or the declared completion condition.
6. Demonstrate Commit with a controlled test control labelled as a send, upload, delete, authorization, or permission action. Verify that no side effect occurs before the human popup approves the staged action with the requesting agent's one-use token. Do not use a real message, purchase, upload, deletion, or authorization.
7. Demonstrate Pause and Resume, including that queued work does not start after Pause and that task status remains visible after recovery.
8. Verify that Standard discovery exposes exactly the seven Standard tools and that the Developer-only tool is absent until the reviewer explicitly enables Developer mode.

## Privacy declaration draft

AgentTab operates locally on the user's computer. It does not collect, sell, share, or transmit user data to the developer or to a remote service. It has no telemetry, analytics endpoint, cloud relay, or hosted browser session.

The extension and local host process browser information only to perform the user's requested task workflow. That information may include the content and state of task-owned tabs, accessibility snapshots, screenshots, action targets, download events, and handoff or Commit state. Standard mode does not return raw cookies, browser storage, passwords, arbitrary scripts, raw CDP, or raw network data to agents.

The local host and extension communicate through Chrome Native Messaging and per-user operating-system-native IPC. Local task and recovery state remains on the user's computer. The `<all_urls>` host permission is limited to the defined `chrome.scripting` text, HTML, selector, wait, and scroll paths on task-owned tabs, not a Standard raw browser-data interface. The final public privacy policy, support destination, and site destination remain unverified placeholders until controlled hosting exists. They must not be invented or entered into a store listing from this draft.

## Asset and submission checklist

None of these items is represented as complete by this draft. Verify each item against the final package and controlled hosting before any submission.

- [ ] Final store package built from the frozen `v2.0.0-rc.1` source and package identity.
- [ ] Required 16, 32, 48, and 128 pixel icons verified in the final package.
- [ ] Store promotional image in the required current dimensions.
- [ ] Screenshots that show a task workspace, Your Turn, Commit staged but not approved, and the local-only status without exposing identity, URLs, secrets, or local paths.
- [ ] Scrubbed reviewer demonstration using a dedicated test profile and accounts.
- [ ] Public privacy-policy destination verified under controlled hosting.
- [ ] Public support destination verified under controlled hosting.
- [ ] Store title, short description, category, permission rationale, and reviewer instructions reconciled with the exact final package.
- [ ] Chrome Web Store item identity checked against `config/identity.json` without adding an unverified public URL to launch copy.
- [ ] Explicit authorization received for any upload, submission, review request, or publication.
