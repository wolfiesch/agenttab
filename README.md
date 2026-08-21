<div align="center">

# Chrome Bridge

**Hand an agent your real, logged-in Chrome. Keep local control.**

A policy-governed native-messaging bridge that lets local agents drive your actual Chrome profile -
no `--remote-debugging-port`, no fresh automation profile, no cloud browser.

<p>
  <a href="https://github.com/wolfiesch/chrome-bridge/releases/latest"><img src="https://img.shields.io/github/v/release/wolfiesch/chrome-bridge?color=blue" alt="Release"></a>
  <a href="https://github.com/wolfiesch/chrome-bridge/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/chrome-MV3-orange" alt="Chrome MV3">
  <img src="https://img.shields.io/badge/python-%E2%89%A53.10-blue" alt="Python >= 3.10">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="Platform">
</p>

</div>

---

Opening a browser is the easy part. The hard part is safely handing an agent your **existing signed-in Chrome session** - cookies, SSO, passkeys - without giving up local control. Chrome Bridge solves exactly that:

- **Fail-closed policy engine** in the native host - nothing runs without an explicit local grant
- **Confirmation tokens, response redaction, and a full audit log** for every action
- **Calm, visible task state** - named tab groups show whether the agent is working, waiting for you, or finished
- **`waitForHandoff`** - the agent stops, focuses the real tab, and shows a compact card while you do login, 2FA, captcha, or payment
- **Cooperative multi-agent leasing** so two agents never mutate one real profile at the same time

## How it works

```mermaid
flowchart LR
    A[Agent / MCP client] -->|token-gated NDJSON<br/>127.0.0.1:9223| B[Native host]
    B -->|fail-closed policy<br/>audit + redaction| C[MV3 extension]
    C -->|native messaging| D[Your real Chrome profile]
    D -.->|waitForHandoff:<br/>login / 2FA / captcha| E([You])
    E -.-> D
```

Every raw TCP, CLI, and MCP request passes the same policy engine. Payloads and response bodies never enter the audit log.

## 60-second quickstart

```bash
./setup.sh                 # installs native host, token, policy, extension dir
python3 test_client.py ping # verifies the bridge
```

Then:

1. Open `chrome://extensions/`, enable Developer mode, **Load unpacked** from the directory printed by `setup.sh`.
2. Keep **only one** Chrome Bridge extension enabled - duplicates race to bind port 9223.
3. Choose the harness integration:

**Oh My Pi (preferred locally):**

```bash
omp plugin link /ABSOLUTE/PATH/TO/chrome-bridge
```

Restart OMP, then use `chrome_bridge_state` and `chrome_bridge_control`. The
extension presents the common task-session workflow as two native tools while
every request still crosses the same host policy, confirmation, audit, and
lease gates.

**MCP clients:**

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "uvx",
      "args": ["--from", "/ABSOLUTE/PATH/TO/chrome-bridge/mcp", "chrome-bridge-mcp"],
      "env": {
        "BRIDGE_REPO_ROOT": "/ABSOLUTE/PATH/TO/chrome-bridge",
        "BRIDGE_PORT": "9223"
      }
    }
  }
}
```

The OMP extension and MCP server are parallel adapters over the same bridge;
installing one does not remove or weaken the other.

Full instructions: [setup](docs/setup.md) and [MCP registration](docs/mcp.md).

## Why this over X

| Alternative | Difference |
|---|---|
| **Chrome DevTools MCP** | Requires a debuggable browser target and typically a remote-debugging port workflow. Chrome Bridge uses native messaging against your normal logged-in profile - no debug port, no focus-stealing popup. |
| **mcp-chrome-style bridges** | Chrome Bridge puts governance in the native host: fail-closed policy, action/origin checks, confirmation tokens, redaction, audit logs, and cooperative leases. |
| **Playwright / Puppeteer** | Excellent for isolated, purpose-launched contexts. Chrome Bridge is for real-profile work: existing cookies, SSO, passkeys, and human handoff when the agent should stop. |
| **Cloud browsers** | Browserbase/Steel-style services are remote and disposable. Chrome Bridge is local-first: browser state, tokens, screenshots, and audit data stay on your machine. |

## Features

| Category | What you get |
|---|---|
| **Real profile** | Navigation, tabs, filtered accessibility views, semantic selectors, screenshots, forms, uploads, a one-command GitHub PR-body attachment helper, viewport, emulation, downloads, storage, geolocation, diagnostics |
| **Background-safe** | Inactive-tab navigation, CDP screenshots without tab selection, connection checks that never launch Chrome or open wake tabs |
| **Governance** | Fail-closed `bridge_policy.json`, origin-aware action policy, deny/allow lists, resumable confirmation tokens (`chrome-bridge confirm <token>`), optional local origin-approval prompt |
| **Audit & redaction** | Action/client/target/decision/reason/request-ID audit log; cookie, storage-state, and policy-defined page-content redaction; `sessionStatus` redacted auth probe |
| **Human handoff** | `waitForHandoff` focuses the real tab, shows a compact bottom card, and waits for login/2FA/captcha before resuming |
| **Visible status** | Toolbar popup with connection/task state and a foreground-only agent-pointer toggle; task groups use `✦`, `↗`, and `✓` status labels |
| **Multi-agent** | Named per-client tokens, cooperative leasing, task-owned tab groups with stable colors that never touch unrelated human tabs |
| **Reliability** | Machine-readable background runs detecting active-tab changes, frontmost-app changes, unexpected tabs, and owned tabs becoming active |
| **Integrations** | Native OMP extension with two high-level task-session tools; MCP server (Claude Desktop, Cursor, Cline, ...) with granular read-only and sensitive-tool scoping; optional Rust native-host parity port |

> [!WARNING]
> **Trusted local use only.** Chrome Bridge controls your real Chrome profile: it can read page content, take screenshots, drive forms, download files, inspect cookies through redacted probes, and attach Chrome's debugger. Install only on machines you control, and keep `bridge_token.txt`, `bridge_tokens.txt`, `extension_key.pem`, `bridge_policy.json`, and debug/audit logs private and git-ignored. Host defaults are fail-closed; normal automation requires explicit local policy grants.

## Documentation

| Guide | Covers |
|---|---|
| [Setup](docs/setup.md) | Requirements, layout, troubleshooting |
| [Commands](docs/commands.md) | Command reference, raw-output safety |
| [Security](docs/security.md) | Policy engine, redaction, audit logs |
| [MCP server](docs/mcp.md) | Tools, scoping, HTTP transport, registration |
| [Multi-agent](docs/multi-agent.md) | Named tokens, cooperative leasing |
| [Benchmarks](docs/benchmarks.md) | Benchmark harness, claim discipline |
| [Verification](docs/verification.md) | Release packaging, contract checks |
| [Rust host](docs/rust-host.md) | Optional native-host parity port |
| [Telemetry](docs/telemetry.md) | Local usage diagnostics |

## Repository naming

The canonical public repository is [`wolfiesch/chrome-bridge`](https://github.com/wolfiesch/chrome-bridge); the product name is **Chrome Bridge**. Your local checkout folder may have another name - replace `/ABSOLUTE/PATH/TO/chrome-bridge` in examples with your actual checkout path.

## License

[MIT](LICENSE)
