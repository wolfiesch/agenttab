# Changelog

## Unreleased

- Added `chrome-bridge policyCheck --plan '<jsonArray>'` and MCP `browser_plan_preview` to preflight up to 50 `{action, origin, payload}` steps in one host-side call, returning a per-step verdict (`step`, `action`, `allowed`, `reason`, `confirmationRequired`, `redact`, `audit`, `originDependent`). Nothing is forwarded to Chrome.
- Added a request-level dry run: global CLI `--dry-run`, or `"dryRun": true` in an MCP `browser_action` payload. Both hosts run the full pipeline - token check, policy evaluation, lease check, origin-dependency determination - then stop before forwarding and return `{success, dryRun, wouldForward, action, targets, verdict}`. Confirmation-gated actions report `confirmationRequired` without minting a token, and no lease, approval prompt, or live-origin lookup is triggered.
- Added the optional policy key `secretMaskFile`, a local `name=value` file (see `bridge_secrets.txt.example`) whose values both hosts replace with `<masked:name>` in every outbound response string and every audit-log field, independently of the `redact` toggle. A missing file disables masking for that path after one warning recorded as `secret_mask_unavailable`.
- Added cookie and web-storage write ops - `chrome-bridge setCookie`, `deleteCookie`, `setStorageItem`, `removeStorageItem`, `clearStorage` and MCP `browser_set_cookie`, `browser_delete_cookie`, `browser_set_storage_item`, `browser_remove_storage_item`, `browser_clear_storage`. All five are confirmation-gated in the sample policy, sit behind `BRIDGE_MCP_ALLOW_SENSITIVE` on MCP, and never log or echo the written value: responses carry cookie name and domain, storage scope and key, or removed key counts only.
- Added `chrome-bridge searchHistory <query> [maxResults] [--since <epochMillis>]` and `chrome-bridge searchBookmarks <query>` plus MCP `browser_search_history` and `browser_search_bookmarks`, using the new `history` and `bookmarks` extension permissions. Both read the real profile's private browsing record, so they are confirmation-gated in the sample policy, sensitive-tier on MCP, and listed under raw-output safety.
- Added `chrome-bridge searchTabs <query> [--regex] [--max-per-tab <count>] [--case-sensitive]` and MCP `browser_search_tabs` to find text across every open http/https tab. Results report tab id, origin host (never the full URL), match count, and capped snippets of the match plus 80 characters of context; unscriptable tabs are skipped and only counted.
- Added `chrome-bridge printToPDF <tabId> <outputPath> [--landscape] [--scale <factor>]` and MCP `browser_save_pdf`, exporting a tab through CDP `Page.printToPDF` on the same background-safe debugger path as `screenshot`; the CLI writes the PDF and prints path, MIME type, and byte count only.
- Added `chrome-bridge clickAt <tabId> <x> <y>` and MCP `browser_click_at` for coordinate clicks on canvas/map/PDF surfaces no selector can reach. Because no element is resolved there is nothing to audit, so `clickAt` ships confirmation-gated in the sample policy.
- Added `chrome-bridge windowControl list|create|focus|setState|close` and MCP `browser_window_control`. `list` reports only window id, focus, state, type, and tab count - never tab URLs or titles; `create` opens unfocused by default; `close` refuses to close the last remaining normal browser window.
- Extended `batch` with a per-step `timeoutMs` passthrough and a per-batch `stopOnError` (default `true`, `--continue-on-error` on the CLI) that records failed steps in place instead of aborting. Wait actions already interleaved with mutating steps through the shared dispatch table; that behavior is now documented precisely.
- Added `chrome-bridge audit tail [count]` and `chrome-bridge audit summary [--since <ISO8601|7d|12h|30m>]` to read the local audit log: recent decisions as aligned columns and aggregate per-client/per-action/outcome counts with the top deny reasons. Metadata only, never payloads; malformed lines are counted, and a missing log or unreachable host is reported explicitly.
- Added `scripts/quick_install.sh`, a one-command bootstrap that runs `./setup.sh` (with optional port passthrough), probes the bridge, and prints the unpacked-extension directory, `chrome://extensions/` steps, and a ready-to-paste MCP registration block for the current checkout.
- Fixed packaged MCP startup so repo-local CLI helpers load without a manual `PYTHONPATH`, and added one safe reconnect attempt when TCP connection setup fails before an action is sent.
- Added token-only confirmation resume through `chrome-bridge confirm <token>` and MCP `browser_confirm`; confirmation responses now include the exact resume command.
- Added `chrome-bridge github-attach-pr-body <tabId> <files...>` and MCP `browser_github_attach_pr_body` to open a PR body editor, upload through GitHub's attachment component, wait for CDN links, and save.
- Added normal top-level/per-command CLI help, compact and filtered `observe`, and `aria=<accessible-name>` selectors alongside existing `text=`, `label=`, and `role=` selectors.
- Added durable task sessions with owned tabs, named Chrome tab groups, safe session cleanup, CLI commands, and typed MCP tools.
- Added a machine-readable background reliability harness that detects active-tab changes, frontmost-app changes, unexpected tabs, and owned tabs becoming active.
- Routine CLI and broker retries no longer open a visible extension wake tab when the native backend is unavailable.
- Navigation now opens inactive tabs by default; pass `--foreground` for an intentional user-visible tab.
- Screenshots now use the background-safe debugger path by default; pass `--visible` for an intentional visible-tab capture.
- Added `scripts/diagnose_install.py` to report deployed-file drift and broker/backend connection state without waking Chrome.

All notable user-facing changes for Chrome Native Messaging Automation Bridge are recorded here.

## 1.0.1 - Public release candidate

### Security and trust model

- Added recursive host-side redaction for sensitive results returned through `batch`, matching standalone action redaction for cookies, storage state, HTML/text extraction, and script results across the Python and Rust hosts.
- Kept `executeScriptCDP` out of the sample policy's default allowed actions; users must opt into high-risk debugger/script capabilities deliberately.
- Clarified that same-channel confirmation is accidental-use friction for trusted token holders, not protection from a compromised bridge token.
- Documented the trusted-local security model earlier in the README.

### Release packaging

- Source release archives are built from tracked files only, so ignored or untracked local artifacts do not leak into public zips.
- The unpacked extension artifact now contains the complete developer-mode extension surface: `background.js`, `manifest.json`, `wake.html`, and `wake.js`.
- Local policy backups, tokens, generated manifests, virtualenvs, lockfiles, debug logs, audit logs, and WIP patches are excluded from release artifacts.

### Installation and workflows

- CI and release workflows now run the same core gate set, including broker, GitHub attachment, install, live-smoke, Rust parity, guardrail, lease, and benchmark contract checks.
- `setup.sh` and `setup-rs.sh` no longer imply that an unpacked extension was deployed when `--extension-id` registers a packaged or store-managed extension ID.
- `setup-broker.sh` now prints the state-dir extension path and token-file advice after a successful broker setup.
- Live install smoke now passes the selected host port through setup and verifies the reported setup JSON shape.

### Documentation

- Removed stale static benchmark timing tables and replaced them with instructions for generating fresh local reports.
- Narrowed platform-support language to documented macOS/Linux installer paths.
- Clarified broker-mode state directory identity, MCP versioning, local usage diagnostics, and release artifact boundaries.

### Excluded from this release

- XChat response-capture work is intentionally not included in this public release candidate. The local WIP was preserved outside Git under `.wip/` for a future hardening pass.
