# DRAFT ONLY - AgentTab v2 community post variants

**Do not post.** AgentTab `v2.0.0-rc.1` is unreleased. v1.0.1 remains the stable legacy release. These drafts include no live link, install instruction, store claim, or call to obtain the unreleased runtime.

## General AI-agent community variant

### Title

AgentTab: Give an AI agent a tab, not the keys to your browser

### Draft

I am working on AgentTab, a local browser runtime for AI agents built around a simple boundary: **Give an agent a tab, not the keys to your browser.**

The starting point is a task workspace rather than general browser control. An agent creates or visibly adopts a tab for its task. Child tabs can inherit the workspace from an owned opener, same-tab writes are serialized, and the task sees only its own tabs. The colored Chrome task group is there to make work visible, not to authorize it. Moving a tab out of the group revokes that task's ownership.

The runtime is local-only: one minimal MV3 extension, a local Rust host, Chrome Native Messaging between them, and per-user operating-system-native IPC for local clients. MCP is an adapter to that local runtime. On macOS and Linux the host uses a user-owned Unix socket; on Windows it uses a current-user named pipe. There is no cloud browser, cloud relay, telemetry service, or routine remote control plane.

The Standard MCP surface is intentionally small: `browser_open`, `browser_snapshot`, `browser_act`, `browser_wait`, `browser_tabs`, `browser_handoff`, and `browser_commit`. The only additional tool is `browser_developer`, and it requires a persistent explicit Developer mode opt-in. Standard mode does not hand agents raw cookies, browser storage, arbitrary scripts, raw CDP, or raw network APIs.
The extension declares the `<all_urls>` host permission so its defined `chrome.scripting` text, HTML, selector, wait, and scroll paths can work in task-owned pages a person directs the agent to use. This broad site reach does not expose raw cookie, storage, arbitrary JavaScript, CDP, or network APIs in Standard mode.

Two controls define the human boundary. **Your Turn** always handles passwords, passkeys, two-factor authentication, CAPTCHA, payment secrets, and other human-only input. During that handoff, AgentTab blackouts standard observation for every task, so captures return `needs_user`; it does not capture the person's keystrokes. Fresh installs start in unattended **Autopilot**, while existing pre-policy state upgrades to Strict. Review selected and Strict use **Commit** as a best-effort review barrier for recognizable sends, publishes, purchases, deletes, uploads, authorizations, and permission grants.

This is not profile isolation. An owned tab still runs in the signed-in Chrome profile the person uses. A hostile page can contain prompt injection, and a control can produce an effect that is not recognizable from its visible label. Your Turn and Commit reduce bounded risks but cannot remove them. The local agent and the local software attached to the profile must still be trusted.

AgentTab `v2.0.0-rc.1` is unreleased and this is not a launch post. I am preserving the draft for later feedback on task ownership, the global handoff blackout, Commit's best-effort semantics, and the seven-tool MCP default.

## Local-first and privacy community variant

### Title

AgentTab: Local task workspaces for AI agents in a signed-in browser

### Draft

I have been designing AgentTab for the case where an agent genuinely needs the browser session already on a computer, but should not receive broad browser control by default.

AgentTab is a **Local browser runtime for AI agents**. It gives each agent a visible task workspace in the signed-in Chrome profile and keeps ownership on the runtime side. A task can create a tab, inherit a child tab from one it owns, or visibly adopt the active tab. Grouping does not create authority. An ungrouped or moved tab is immediately unavailable to that task.

The architecture is deliberately local. A minimal MV3 extension connects to one Rust host through Chrome Native Messaging. Local MCP clients use per-user operating-system-native IPC to reach the host, rather than a network listener or remote service. The runtime has no cloud relay, hosted browser session, analytics, or telemetry.

The handoff model is called **Your Turn**. If a task reaches a password, passkey, two-factor challenge, CAPTCHA, payment secret, or another human-only step, the person takes over. AgentTab persists that state and blackouts observation for every task while the person works. Once the person signals Done or the declared completion condition is reached, the runtime scrubs the handoff path before normal observation resumes.

For recognizable consequential actions, fresh state defaults to direct **Autopilot** execution; existing pre-policy state migrates to Strict. Review selected and Strict use **Commit** for sends, publishes, purchases, deletes, uploads, authorizations, and permission grants. Approval happens in a human popup and is bound to the requesting agent's one-use token, the task, the tab, the target fingerprint, and the current page state. The final execution checks those bindings again. That reduces recognizable risk, but it cannot guarantee that a page has not attached a hidden effect to an innocent-looking control.

The Standard MCP interface has seven tools and excludes raw cookies, browser storage, arbitrary scripts, raw CDP, and raw network access. A separate Developer-only tool requires a persistent explicit opt-in.
The extension also declares the `<all_urls>` host permission for the defined `chrome.scripting` text, HTML, selector, wait, and scroll paths in task-owned pages. It is needed across the sites a person directs an agent to use, not to expose raw browser-data or browser-control APIs in Standard mode.

The important caveat is that task ownership is coordination, not a security container around an identity. The profile remains the profile the person is signed into. Prompt injection, misleading content, and a poorly trusted local agent remain meaningful risks.

AgentTab `v2.0.0-rc.1` is unreleased. This text is draft-only and intentionally omits any live destination, installation command, or invitation to use the unreleased runtime.

## Short-comment fallback

AgentTab is an unreleased local browser runtime for AI agents. It uses task-owned tabs, with unattended Autopilot for fresh state and Strict for pre-policy upgrades, not broad browser control: Your Turn blackouts observation for human-only steps, review profiles stage recognizable effects for Commit, and MCP connects locally through per-user operating-system-native IPC. It has no cloud relay or telemetry. The boundary is coordination, not profile isolation, so local agents and page content still need to be trusted.
