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
| ST1 | Windows support | `setup-windows.ps1`: user-scope HKCU native-messaging registration for Chrome and Edge, `.cmd` launcher for the Python or Rust host, secrets created only when absent, metadata-only output | done |
| ST2 | Per-site permission modes | Policy key `siteModes` (origin pattern -> `manual`/`auto`/`skip`) in both hosts, merged per pattern across layers: manual gates every mutating or high-risk action, skip pre-approves the confirmation gate and is audited as `confirmation_waived`, deny lists still win, and a non-skippable set (script exec, cookies, storage, screencast, `clickAt`) can never be waived; CLI `policy site-mode`/`clear-site-mode`, `siteMode` in every verdict | done |
| ST3 | Record & replay macros | `startWorkflowRecording`/`stopWorkflowRecording`/`replayWorkflow` capture only bridge-dispatched mutating actions (never human input) into the shared `{version, name, steps, policy.requiredOrigins}` workflow file; typed/stored values recorded as `<redacted>` with `requiresValue` bindings, replay refused wholesale until every binding is supplied and per step on an origin mismatch; CLI `workflow record start\|stop\|save` and `workflow replay --binding`, MCP `browser_replay_workflow` | done |
| ST4 | Action cache / self-healing | `resolveCachedSelector`/`cacheSelectors` map `(origin+pathname, semantic selector)` to the CSS path that last resolved, reused on replay and re-resolved with `selfHealed: true` when stale; CSS selectors are never cached or retargeted; file-backed cache in git-ignored `bridge_action_cache.json` via CLI `cache selectors list\|clear\|export\|import`, MCP `browser_cache_selectors`/`browser_resolve_cached_selector` | done |
| ST5 | Schema-driven extraction | `extractStructured` / `browser_extract_structured`: deterministic label, heading, table, `dl`, `aria-label`, and `name`-attribute mapping validated against a JSON Schema subset (object, array, string, number, boolean, enum, required, properties, items); data-only output with per-field errors | done |
| ST6 | Prompt-injection posture | `scanPromptInjection` / `browser_scan_prompt_injection` plus opt-in `injectionScan` metadata on `extractText`/`getHTML`: bounded heuristic `risk`/`kind`/`severity` findings with 160-character snippets, documented as untrusted-content posture and never an authorization decision | done |
| ST7 | Scheduled workflows | `chrome-bridge schedule workflow --at/--interval`, `schedule list`, `schedule remove`: validated workflow-file contract registered as metadata only in git-ignored `bridge_schedules.json`, no daemon and no timer, run through cron/launchd/systemd, with host policy still authorizing every replayed step | done |
| ST8 | Firefox/Edge port | Edge registration via `setup-edge.sh` (macOS/Linux) and `setup-windows.ps1 -Browser Edge`; Firefox native manifest plus staged extension generated by `scripts/generate_browser_manifests.py`, with the unsupported-runtime limitations documented | done |

## Deferred / non-goals

| Feature | Reason |
|---|---|
| Lighthouse / deep performance tracing | Chrome DevTools MCP's lane; `performanceMetrics` covers the common case |
| WebKit/Firefox engine parity (Playwright-style) | Dilutes real-profile positioning |
