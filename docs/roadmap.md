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

## Tier 4 - Competitive parity and enterprise readiness

Opened after the 2026-07 frontier-product recheck. Verified context: Anthropic's Claude in Chrome ships the same extension plus native-messaging-host plus MCP architecture (`com.anthropic.claude_code_browser_extension`), with per-site permissions, org allowlists and blocklists, and a `deniedMcpServers` managed control. Every major product now has a credential path where the model never sees the secret. The durable differentiator is that enforcement lives in a separate host process rather than in the model reviewing its own actions.

| ID | Feature | Summary | Status |
|---|---|---|---|
| T4-1 | MCP elicitation for approvals | `elicitation/create` for confirmation gates and missing workflow bindings, so a gated action becomes an in-client prompt instead of a returned token | todo |
| T4-2 | Chrome Web Store listing | Submit the packaged extension; stable store ID also removes the duplicate-extension port race | todo |
| T4-3 | Credential handoff (single field) | `credentialHandoff` focuses one field, banners, and waits for a human or password manager to fill it; the value is never read, measured, returned, or logged (no character count either), and the host blackout covers the whole window | done |
| T4-4 | Deterministic postconditions | Per-step `expect` (selector/text/url/schema) plus bounded `retry` in workflows, and a standalone `expect` action; deterministic evidence instead of model self-assessment | done |
| T4-5 | Read-only vs state-changing tiering | Effective tier computed from payload flags, not action name alone: a read-only action carrying a state-changing flag escalates, and `batch` is read-only only when every step is | done |
| T4-6 | OpenTelemetry spans | Opt-in, off-by-default GenAI-convention spans in both hosts (`BRIDGE_OTEL_ENABLED`), OTLP/HTTP JSON with no SDK dependency, metadata-only attributes, plus W3C `traceparent` propagation across the CLI, MCP HTTP/stdio, and the TCP envelope, correlated with session trace artifacts | done |
| T4-7 | Audit and trace export | Forwarder for JSONL, RFC 5424 syslog, and ArcSight CEF through the policy key `auditExport` `{format, destination, rotateBytes, retainDays}`, byte-compatible across both hosts: the local audit write stays the source of truth and export mirrors the same already-masked event afterwards under its own lock, single-generation rotation with age-based pruning for file destinations, one `audit_export_unavailable` event that disables a failed sink for the process, plus `chrome-bridge audit export` for policy-independent backfill and `--dry-run` destination testing | done |
| T4-8 | Signed org policy bundles | Content-addressed policy bundle plus lockfile (`policyBundle`), sha256-verified before load in both hosts: a verified bundle supplies the `default`/`clients` baseline and the local policy layers on top to tighten only, deny lists union so a bundle can never loosen a local denial, any mismatch or read/parse failure falls back to the built-in fail-closed default and audits `policy_bundle_rejected` with both digests, the digest is re-verified on the mtime reload path, `policyInfo` reports a truncated digest and never contents, and `chrome-bridge policy bundle verify|lock|show` manages distribution | done |
| T4-9 | Egress allowlist | Host-side hostname constraints on where an agent may drive traffic: policy key `egressAllowlist` enforced in both hosts before forwarding, covering `navigate`/`navigateTaskSession`/`downloadUrl`/`setCookie` plus `batch`/`replayWorkflow` recursion, never loosening site policy, with the traffic it cannot see documented as out of scope | done |
| T4-10 | DLP hooks | Policy key `dlp` maps each channel to `allow`/`audit`/`block`, merged per channel and enforced in both hosts before forwarding: `upload` gates `uploadFile`/`githubAttachUploadedFiles`/`githubAttachPrBody` so `DOM.setFileInputFiles` is never dispatched, `download` gates `downloadUrl`, `screenShare` gates `startScreencast`/`screencastFrames`, with `batch`/`replayWorkflow` recursion, an unknown mode failing closed to `block`, one metadata-only `dlp_audit` event per audited request, a second independent refusal in the extension's `dispatchAction`, a `dlp` field on every verdict, and `clipboard` declared but documented as having no bridge chokepoint rather than overclaimed | done |

## Deferred / non-goals

| Feature | Reason |
|---|---|
| Lighthouse / deep performance tracing | Chrome DevTools MCP's lane; `performanceMetrics` covers the common case |
| WebKit/Firefox engine parity (Playwright-style) | Dilutes real-profile positioning |
