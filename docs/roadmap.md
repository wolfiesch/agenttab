# Feature roadmap

Progress tracker for the 2026-07 competitive audit. Tiers execute in order: quick wins, high impact, strategic. Status values: `todo`, `in-progress`, `done`, `deferred`.

## Tier 1 - Quick wins

| ID | Feature | Summary | Status |
|---|---|---|---|
| QW1 | PDF export | `printToPDF` action via background-safe debugger path; CLI writes file, prints metadata only | done |
| QW2 | Coordinate click | `clickAt <tabId> <x> <y>` via `Input.dispatchMouseEvent`; confirmation-gated in example policy (bypasses selector auditing) | done |
| QW3 | Window management | `windowControl` op: list/create/focus/setState/close through `chrome.windows` | done |
| QW4 | Batch sequences with waits | Waits already dispatch inside `batch`; added per-step `timeoutMs` passthrough and per-batch `stopOnError` (default true) | done |
| QW5 | Cookie/storage write ops | `setCookie`, `deleteCookie`, `setStorageItem`, `removeStorageItem`, `clearStorage`; sensitive + confirmation-gated | done |
| QW6 | History & bookmarks read | `searchHistory`, `searchBookmarks` via extension APIs; sensitive tier | done |
| QW7 | Cross-tab search | `searchTabs <query>` searches text across open http(s) tabs, returns tabId/domain/snippets | done |
| QW8 | Plan preflight | `policyCheck` accepts a plan (list of action+origin steps); per-step verdicts, never forwards; MCP `browser_plan_preview` | done |
| QW9 | Dry-run mode | Request-level `dryRun: true` evaluated host-side; returns would-be policy verdict without contacting Chrome; CLI `--dry-run` | done |
| QW10 | Secret masking dictionary | Policy-referenced local secrets file; exact values masked in every response field, both hosts | done |
| QW11 | Audit viewer CLI | `chrome-bridge audit tail/summary` over `bridge_audit.jsonl`: per-client/action/decision counts, recent denies | done |
| QW12 | One-line install bootstrap | `scripts/quick_install.sh` wrapping setup + extension-load + MCP registration instructions | done |

## Tier 2 - High impact

| ID | Feature | Summary | Status |
|---|---|---|---|
| HI1 | Handoff telemetry blackout | While `waitForHandoff` is pending on a tab, host denies screenshot/extractText/getHTML/storageState for that tab regardless of policy | done |
| HI2 | Stable element refs | `observe` returns `ref=eN` handles usable directly as selectors in click/type/fill | done |
| HI3 | Snapshot diffing | Repeat `observe` returns only changes since previous snapshot | done |
| HI4 | Per-request HTTP tokens | MCP HTTP transport propagates per-client tokens so leasing arbitrates HTTP clients | done |
| HI5 | Parallel lease semantics | Documented intra-token concurrency pattern; per-session queueing guidance | done |
| HI6 | Screencast recording | CDP `Page.startScreencast` capture to local video/frames; background-safe | done |
| HI7 | Source-mapped console stacks | Resolve original source positions in `consoleMessages` where source maps are available | done |
| HI8 | Session trace artifact | Policy `traceDir` writes one metadata-only JSONL event per trace-eligible request (`decision`, `durationMs`, tab ids, `responseHash`/`snapshotHash`); CLI `trace summary`/`trace tail`, MCP `browser_trace_summary`/`browser_trace_tail` | done |
| HI9 | Store-ready extension packaging | Deterministic tracked-files-only upload zip via `scripts/package_extension_store.py`, validated surface, metadata-only output; no publishing and no private key in git | done |

## Tier 3 - Strategic

| ID | Feature | Summary | Status |
|---|---|---|---|
| ST1 | Windows support | Native-messaging registry registration, installer, docs | todo |
| ST2 | Per-site permission modes | `manual`/`auto`/`skip` per origin in policy: manual gates every mutation, skip pre-approves | todo |
| ST3 | Record & replay macros | Record interaction sequence in extension, serialize to policy-governed workflow file, replay without LLM | todo |
| ST4 | Action cache / self-healing | Cache resolved selectors per (url-pattern, instruction); deterministic replay, re-resolve on failure | todo |
| ST5 | Schema-driven extraction | `browser_extract` with JSON schema validation of extracted structured data | todo |
| ST6 | Prompt-injection posture | Tag extracted content as untrusted; flag instruction-like patterns targeting agents | todo |
| ST7 | Scheduled workflows | Cron/webhook triggers for recorded workflows; lands only after ST2 (no-human-present trust model) | todo |
| ST8 | Firefox/Edge port | Edge (Chromium, near-free) then Firefox WebExtension native-messaging port | todo |

## Deferred / non-goals

| Feature | Reason |
|---|---|
| Lighthouse / deep performance tracing | Chrome DevTools MCP's lane; `performanceMetrics` covers the common case |
| WebKit/Firefox engine parity (Playwright-style) | Dilutes real-profile positioning |
