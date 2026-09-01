# DRAFT ONLY - AgentTab v2 directory listing copy

**Do not submit or publish.** AgentTab `v2.0.0-rc.1` is unreleased. v1.0.1 remains the stable legacy release. No public package, site, privacy-policy, support, repository, release, or store URL is asserted by this draft.

## Product name

AgentTab

## Category

Local browser runtime for AI agents

## Tagline

Any agent. Your browser. Your rules.

## One-line description

Give an agent a task workspace in your signed-in Chrome profile, not broad control of your browser.

## Short description

AgentTab is a local browser runtime for AI agents. It gives each agent task-owned tabs, uses Your Turn for human-only input, stages recognizable consequential actions with Commit, and connects local MCP clients through per-user operating-system-native IPC.

## Long description

AgentTab is for browser tasks that need the Chrome profile already on a user's computer. Its promise is: **Give an agent a tab, not the keys to your browser.**

Each agent begins with a task workspace. AgentTab creates or visibly adopts a tab for that task, permits child-tab inheritance from owned tabs, and serializes writes to the same tab. Task groups make active work visible but are display-only: they never grant ownership. A tab moved out of its task group is no longer available to that task.

The runtime is local-only. One minimal MV3 extension connects through Chrome Native Messaging to a local Rust host. MCP and other local adapters connect to the host through a user-owned Unix socket on macOS and Linux or a current-user named pipe on Windows. There is no cloud relay, hosted browser session, telemetry service, or routine remote control plane.

The Standard MCP surface has exactly nine tools: `browser_open`, `browser_snapshot`, `browser_act`, `browser_wait`, `browser_tabs`, `browser_handoff`, `browser_commit`, `browser_credentials`, and `browser_finish`. The finalization tool applies provenance-aware cleanup: task-created tabs close by default, adopted tabs are retained, retained tabs are ungrouped, and task ownership is released. The credential tool is inert unless managed policy explicitly enables the local 1Password broker, and it never returns a credential value. A separate `browser_developer` tool exists only after a persistent, explicit Developer mode opt-in. Standard mode does not expose raw cookie, storage, arbitrary script, CDP, or network APIs.
AgentTab declares the `<all_urls>` host permission so its defined `chrome.scripting` text, HTML, selector, wait, and scroll paths can operate in task-owned pages that the user directs an agent to use. This supports those bounded paths across sites; it does not add raw cookie, storage, arbitrary JavaScript, CDP, or network APIs to Standard mode.

The optional local 1Password broker can fill one of at most three origin-matching Login items directly into a selected field without revealing the value to the agent. **Your Turn** remains the human handoff state for passkeys, security keys, CAPTCHA, payment secrets, account recovery, unsupported verification, or a broker result that needs the user. During handoff, AgentTab applies an observation blackout across every task, so standard observations return `needs_user`; it does not capture human keystrokes.

**Commit** is a best-effort review barrier for recognizable send, publish, purchase, delete, upload, authorization, and permission-grant controls. It stages a recognizable action with a preview, requires a human popup approval and the requesting agent's one-use token, and revalidates the page and target before execution. It is not a guarantee that every page-triggered external effect is recognizable.

Task ownership coordinates work but does not isolate the signed-in Chrome profile. An agent acting in an owned tab can use the same web session available to the person at the keyboard. Users should connect only trusted local agents and software. Hostile page content and misleading controls remain risks, including prompt injection and effects that Commit cannot classify correctly.

## MCP integration status

MCP is a local adapter to the AgentTab Core RPC. AgentTab `v2.0.0-rc.1` is unreleased, so this draft intentionally includes no configuration snippet, package coordinate, command, repository link, or install call to action. Public integration instructions must wait for controlled hosting, signed release artifacts, and stable dependencies.

## Privacy statement

AgentTab does not collect, sell, share, or transmit user data to the developer or a remote service. It has no telemetry, analytics endpoint, cloud relay, or hosted browser session. Task data and recovery state stay on the user's computer and are processed only to perform requested local browser work. Standard mode does not return raw cookies, browser storage, passwords, arbitrary scripts, raw CDP, or raw network data to agents.

## Suggested directory tags

- Browser automation
- MCP
- Local-first
- Native messaging
- AI agents
- Human-in-the-loop
- Security
- Developer tools
- Chrome extension

## Publication prerequisites

Do not populate directory links or install fields until all of the following are verified for the exact release candidate or stable release being announced:

- [ ] Controlled public site, privacy-policy, and support destinations.
- [ ] Final signed package identities and immutable release artifacts.
- [ ] Exact MCP package coordinates and supported runtime configuration.
- [ ] Chrome Web Store package and approval status, if a store listing is being named.
- [ ] Human review of wording against the final Standard and Developer mode surfaces.
- [ ] Explicit authorization to submit the directory listing.
