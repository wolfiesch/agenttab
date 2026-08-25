# DRAFT ONLY - Show HN copy for AgentTab v2

**Do not post.** AgentTab `v2.0.0-rc.1` is unreleased. v1.0.1 remains the stable legacy release. This draft contains no live link, install instruction, or public availability claim.

## Proposed title

Show HN: AgentTab gives an AI agent a tab, not the keys to your browser

## Alternate titles

1. Show HN: AgentTab is a local browser runtime for AI agents
2. Show HN: Task workspaces for agents using a signed-in Chrome profile
3. Show HN: Any agent, your browser, your rules

## First comment draft

I built AgentTab around a browser-agent boundary I wanted to be explicit about: a useful agent may need the browser session I already use, but that does not mean it should get broad control of my browser.

AgentTab's promise is: **Give an agent a tab, not the keys to your browser.** It is a local browser runtime for AI agents. An agent begins with a task workspace that creates or visibly adopts a tab. Task-owned child tabs can inherit that workspace, but task groups are only a visual status aid and never grant ownership. Writes to the same tab are serialized, while separate task tabs can proceed independently.

The runtime is one minimal MV3 extension plus a local Rust host. The extension uses Chrome Native Messaging, and local clients such as MCP adapters use per-user operating-system-native IPC: a user-owned Unix socket on macOS and Linux or a current-user named pipe on Windows. There is no cloud relay, hosted browser session, telemetry service, or routine network control plane.

Standard MCP access is deliberately small: `browser_open`, `browser_snapshot`, `browser_act`, `browser_wait`, `browser_tabs`, `browser_handoff`, and `browser_commit`. There is one optional Developer-only tool, `browser_developer`, behind a persistent explicit opt-in. Standard mode does not expose raw cookie, storage, arbitrary script, CDP, or network APIs.
AgentTab declares the `<all_urls>` host permission so its defined `chrome.scripting` text, HTML, selector, wait, and scroll paths can run in task-owned pages the user selects. That broad site reach does not give Standard mode raw cookie, storage, arbitrary JavaScript, CDP, or network APIs.

Two human controls are central. **Your Turn** handles passwords, passkeys, two-factor authentication, CAPTCHA, payment secrets, and other human-only input. While a handoff is active, AgentTab applies an observation blackout for every task, so normal capture and observation calls return `needs_user`; it does not capture the person's keystrokes. **Commit** is a best-effort barrier for recognizable sends, publishes, purchases, deletes, uploads, authorizations, and permission grants. The runtime stages a recognizable action, shows a human popup preview, and allows a one-use token from the requesting agent to execute only after approval. It revalidates the target immediately before execution and invalidates the staged action if the page or target changes.

This is still real-profile automation. Task ownership coordinates execution; it does not isolate cookies, accounts, or identity. A page can contain prompt injection, a control can hide an effect behind an innocent label, and Commit cannot prove that every external effect is recognizable. The runtime is local-only and has no telemetry, but users still need to trust the local agents and software they connect to their signed-in profile.

I am preparing the v2 design for controlled review, not public use. I would eventually welcome feedback on the task-workspace boundary, the Your Turn blackout, the best-effort Commit model, and whether the seven-tool MCP surface is the right default. There is no stable install path or launch link in this draft.
