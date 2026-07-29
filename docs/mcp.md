# MCP server

## MCP server

`mcp/` exposes the bridge to MCP clients (Claude Desktop, Cursor, Cline) so an agent drives your real, logged-in Chrome profile through the standard Model Context Protocol. It is a pure client of the token-gated `127.0.0.1:9223` TCP API; the extension, wire protocol, and host are unchanged.

The server reuses `test_client.py`'s transport verbatim, so the MCP tools and the CLI stay in lockstep.

### Tools

The MCP server ships a grouped tool set. Legacy tab-scoped tools take an optional `tab_id`; omitting it targets the active tab. For new workflows, prefer task-session tools so a human tab change cannot redirect the agent.

Read-only:

- `browser_list_tabs`
- `browser_task_session_list`
- `browser_snapshot` (compact by default; filter by roles/name/limit or request full details). Every node carries a stable `ref` such as `e12` that any selector argument accepts as `ref=e12`; `diff=True` returns `added`/`removed`/`changed` against the previous snapshot of that tab with `baseEpoch`/`epoch`, and returns the full snapshot with `diffBase: true` when there is no baseline yet
- `browser_extract_text` - visible page text; `scan_prompt_injection=True` adds an `injectionScan` block (`risk`, bounded `matches`, `scannedChars`) without changing the existing fields
- `browser_extract_structured` - extract schema-described fields as validated JSON. `schema` is a JSON Schema subset (`object`, `array`, `string`, `number`, `boolean`, plus `enum`, `required`, `properties`, `items`); anything outside it is rejected instead of ignored. Mapping is deterministic and heuristic (labels, headings, table headers, `dl` pairs, `aria-label`, `name` attributes, `Key: value` lines) with no model inference, `selector` scopes the read, unresolved optional fields are omitted, and missing required fields come back in `errors` alongside `data` and `schemaVersion`. Raw page text is never returned; extracted values are still untrusted page content
- `browser_scan_prompt_injection` - heuristic posture scan for instruction-like page text aimed at an agent, its tools, its secrets, or its policy. Returns `risk` (`low`/`medium`/`high`), `matches` with `kind`, `severity`, and a 160-character snippet cap, and `scannedChars`; full page text is never returned. A hit is a warning, never a permission grant or denial by itself
- `browser_console_messages` - buffered console entries for a monitored tab (start monitoring first via `browser_action` `startMonitoring`). Each entry carries a `stack` of raw generated frames (`url`, 0-based `lineNumber`/`columnNumber`, `functionName`); `resolve_source_maps=True` adds best-effort `originalLocation` (`source`, `name`, 0-based `lineNumber`/`columnNumber`) or a `sourceMapStatus` of `notFound`, `invalid`, `unmapped`, or `crossOriginRefused`. Only same-origin or inline maps are read and source text is never returned, but resolved `source` paths can expose a site's private build layout
- `browser_screenshot` (returned inline as an image)
- `browser_save_pdf` - print a tab to PDF on the background-safe debugger path, write it to a caller-supplied local path, and return only path, MIME type, and byte count (annotated read-only: the page is not mutated)
- `browser_get_html`, `browser_lease_status`
- `browser_policy_check` - ask the host what its policy would decide for an action/payload without forwarding it. The verdict includes `siteMode`: the per-site permission mode (`manual`/`auto`/`skip`, or null when no origin is known or no `siteModes` pattern matches) that the host folded into `confirmationRequired`, and `effectiveTier`: `read_only` or `mutating` for that exact action **and payload**
- `browser_plan_preview` - preflight a list of up to 50 `{action, origin, payload}` steps against host policy in one call; returns a per-step verdict (`step`, `action`, `allowed`, `reason`, `confirmationRequired`, `redact`, `audit`, `originDependent`, `siteMode`, `effectiveTier`) and forwards nothing
- `browser_wait_for` (`mode`: `load|selector|text|url`)
- `browser_expect` (`mode`: `selector|text|url|schema`) - assert a deterministic postcondition. `selector` passes when the selector resolves (full locator grammar, including `ref=eN`), `text` when the page text contains `text`, `url` when the tab URL contains `url_substring`, and `schema` when structured extraction against `schema` reports no `missingRequired` errors. `negate=True` inverts the outcome, which is how absence is asserted, and the check polls until the condition holds or `timeout_ms` elapses (default 5000, capped at 60000). No model judges the outcome: the result is `mode`, `negate`, `passed`, `attempts`, `elapsedMs`, plus a short `reason` when it failed. The matched element, matched text, tab URL, and extracted values are never returned, so a failing assertion is not a back-door page read
- `browser_trace_summary` / `browser_trace_tail` - read a local session trace artifact written by the host when policy sets `traceDir`. Summary returns event counts by action and decision, the time range, and duration totals; tail returns the most recent events (`ts`, `action`, `decision`, `reason`, `requestId`, `durationMs`, `targets`, `traceId`, `responseHash`, `snapshotHash`, `success`, plus `otelTraceId`/`otelSpanId` naming the exported span when the host's opt-in OpenTelemetry spans are enabled and `null` otherwise). Both are metadata only: a trace stores no payload, no response body, and no page content. `trace_dir` overrides the host's configured directory

Sensitive:

- `browser_get_cookies`
- `browser_session_status` - redacted auth/session probe (cookie names/counts + `loggedIn` per domain, never values)
- `browser_search_history` - search the real profile's browsing history (url, title, `lastVisitTime`, `visitCount`; `max_results` capped at 100)
- `browser_search_bookmarks` - search the real profile's bookmarks (id, title, url, parent folder path)
- `browser_search_tabs` - search visible text across every open http/https tab; returns tab id, origin host, match count, and bounded snippets. Gated as sensitive because the snippets come from **every** tab of the real profile, including mail, docs, and consoles the agent was never pointed at

Mutating:

- `browser_navigate`
- `browser_task_session_create`, `browser_task_session_navigate`, `browser_task_session_state`, `browser_task_session_close`
- `browser_click`, `browser_type`, `browser_fill`, `browser_hover` - selectors accept `ref=e12` from `browser_snapshot` alongside CSS and the `text=`/`aria=`/`label=`/`role=` prefixes. Refs are invalidated by navigation and by an extension service-worker restart; a stale ref fails with `error: staleRef` instead of matching a different element, so re-snapshot
- `browser_click_at` - click raw viewport coordinates; no element is resolved, so nothing identifies the target in the audit log. Prefer `browser_click`; the sample policy confirmation-gates `clickAt`
- `browser_scroll`, `browser_press`, `browser_drag`
- `browser_select`
- `browser_upload_file` (validates local paths before contacting Chrome)
- `browser_github_attach_pr_body` (opens only the GitHub PR-body editor, attaches files, waits for CDN URLs, and saves)
- `browser_tab_control` (`op`: `activate|close|reload|back|forward`), `browser_lease`, `browser_release`
- `browser_window_control` (`op`: `list|create|focus|setState|close`) - `list` returns only window id/focus/state/type/tab count, never tab URLs or titles; `create` is unfocused unless `focused=True`; `close` is destructive and refuses to close the last remaining normal window
- `browser_set_cpu_throttling`, `browser_set_network_conditions`, `browser_clear_network_conditions`, `browser_set_color_scheme`, `browser_set_user_agent`
- `browser_start_screencast`, `browser_stop_screencast` - record a background tab through CDP `Page.startScreencast` without activating it. Frames buffer only in the extension service worker (a worker restart ends the recording) and the buffer is bounded at 600 frames or ~50MB, dropping and counting the oldest frames past either bound. Continuous capture of a real profile is high-exposure, so the example policy confirmation-gates `startScreencast`; drain with `browser_screencast_save` before stopping, because `browser_stop_screencast` discards whatever is still buffered
- `browser_screencast_save` - drain the tab's buffered screencast frames to numbered image files plus a `frames.json` manifest in a caller-supplied directory, returning only directory, frame count, dropped count, byte total, manifest path, and `staleArtifactsRemoved`. It does not mutate the page, but it is **not** read-only: it consumes the extension's frame buffer (the frames are gone afterward) and writes local files, so it is annotated mutating and is dropped under `BRIDGE_MCP_READONLY=1`. The destination is created and validated before any frame is drained, and only artifacts a prior save wrote (`frame-*.png`, `frame-*.jpg`, `frames.json`, `screencast.mp4`) are removed first, so a shorter second save cannot present an earlier recording's frames as its own
- `browser_cache_selectors` (`op`: `list|export|clear|import`) - inspect or manage the extension's semantic-selector resolution cache. An entry maps a `urlPattern` plus a `text=`/`label=`/`role=`/`aria=` selector to the CSS path that last resolved to that element; CSS selectors are never cached and an imported non-semantic entry is rejected. `clear` and `import` mutate that cache, so the tool is annotated mutating and is dropped under `BRIDGE_MCP_READONLY=1`. The CLI `chrome-bridge cache selectors` commands own the file-backed copy
- `browser_wait_for_handoff` - pause automation, mark the task group as needing review, focus the real tab with a compact bottom card, and wait for a human to finish login/2FA/captcha before resuming
- `browser_credential_handoff` - hand ONE field to the human so a password, passphrase, recovery code, or one-time code is typed straight into the page. Use it instead of `browser_fill` for anything secret. The tool focuses the tab, window, and the field named by `selector` (CSS, semantic, or `ref=eN`) and waits; the field value is never read, logged, or returned, and the only value-derived datum in the response is `valueLength`, a character count. `mode` is `filled` (default; resolves when the field goes from empty to non-empty and settles) or `submitted` (resolves on form submit or navigation). For the whole window the native host holds a handoff blackout over the tab, so `browser_screenshot`, `browser_get_html`, `browser_snapshot`, and every other observation tool are denied to every client, including this one. Annotated mutating (dropped under `BRIDGE_MCP_READONLY=1`) but not sensitive: gating it would push callers back toward typing secrets through `browser_fill`. Under auto-lease the cooperative lease is extended to span the whole wait.
- `browser_resolve_cached_selector` - resolve a selector to a stable `ref=eN` plus a concrete CSS path. A cached resolution is served only when the cached CSS path and the original semantic selector resolve to the **same live DOM node** (compared by backend node id); if the page replaced the element the semantic selector names, the cached path is discarded and the semantic selector is re-resolved with `selfHealed: true`, even though the old path still resolves. Imported entries go through the same check. Returns element identity only, never element text or page content; `refresh=True` skips the cache, and frame/shadow selectors report `cacheable: false`
- `browser_confirm_action` - resend an action with a host-issued confirmation token
- `browser_confirm` - resume the exact pending action from only its host-issued token

Sensitive and mutating (require `BRIDGE_MCP_ALLOW_SENSITIVE=1`, confirmation-gated by the example policy):

- `browser_set_cookie` - write one cookie; the response reports name and domain only, never the value
- `browser_delete_cookie` - remove one cookie; destructive, can sign the profile out of a site
- `browser_set_storage_item`, `browser_remove_storage_item` - write or remove one `local`/`session` storage entry; responses echo scope and key only
- `browser_clear_storage` - clear `local`, `session`, or `both` for the tab origin; destructive, reports removed key counts only
- `browser_replay_workflow` - replay a recorded `{version, name, steps, policy}` workflow. **It reproduces real mutating actions**: every step runs through the normal host policy, lease, and confirmation gates, and a step whose live tab origin is not in `policy.requiredOrigins` is refused. Values recorded as `<redacted>` must be supplied in `bindings` keyed `step<N>.<field>`; the whole workflow is refused before any step runs when one is missing. Version 1 and version 2 files are both accepted; a version-2 step may carry an `expect` postcondition (same shape as `browser_expect` minus the tab) and a bounded `retry` (`max` clamped `0..5`, `delayMs` clamped `0..10000`), and a nested `expect` is origin-checked host-side like any other tab-scoped action. Returns per-step outcomes with `attempts`, `retried`, and `expectPassed`, the `retriedSteps`/`expectFailedSteps` totals, `selfHealed` flags, and the refreshed selector cache

Escape hatch (sensitive):

- `browser_action` - escape hatch for any raw bridge action (interception, geolocation, monitoring, console/network logs, `downloadUrl`, `storageState`, `executeScript`, `setViewport`, `handleDialog`, `batch`, ...). A `"dryRun": true` entry in `payload` is passed through to the host as the request-level dry-run flag: the host evaluates policy, lease, and confirmation state and returns `{dryRun, wouldForward, verdict}` without forwarding the action to Chrome.

### Resources

- `browser://tabs` - live tab list.
- `browser://tab/{id}/state` - current state of a tab.

### Scoping

The server reads two env flags to scope the exposed surface:

- `BRIDGE_MCP_READONLY=1` registers only the read-only tools, hiding navigate/click/type/upload, tab mutations, `browser_confirm_action`, `browser_action`, and the two local-side-effect tools `browser_screencast_save` and `browser_cache_selectors`.
- `BRIDGE_MCP_ALLOW_SENSITIVE=1` is required to expose sensitive tools (`browser_get_cookies`, `browser_session_status`, `browser_search_history`, `browser_search_bookmarks`, `browser_search_tabs`, the cookie/storage write tools, `browser_replay_workflow`, and the raw `browser_action` escape hatch), which are hidden by default. The host policy remains the enforcement boundary even when this escape hatch is exposed.

Tools carry `readOnly`/`destructive` annotations so clients can prompt appropriately. An MCP annotation is **static per tool**, so it cannot describe a call whose tier depends on its arguments: those annotations stay deliberately conservative and the authoritative tier is the `effectiveTier` the host computes per call. Two tools where the difference matters:

- `browser_batch` is annotated mutating, but host-side a batch is `read_only` only when **every** step is; one mutating step makes the whole batch mutating, and under a `manual` origin that is what decides whether the batch needs a confirmation token. Ask `browser_policy_check(action="batch", payload=...)` for the tier of a specific batch.
- `browser_screencast_save` is annotated mutating because it always sends `consume: true`. The underlying `screencastFrames` action is nominally read-only and escalates to `mutating` precisely because of that flag, which drains the tab's frame buffer irrecoverably.

The full escalation table (`screencastFrames.consume`, `cacheSelectors.op`, `resolveCachedSelector.cache`) is in docs/security.md.

MCP deliberately exposes **no policy-mutation and no scheduling tool**. Reading a verdict (`browser_policy_check`, `browser_plan_preview`) is safe; rewriting the file that produces verdicts is not something an agent should do through the same channel it is being governed by. Change per-site permission modes with `chrome-bridge policy site-mode <originPattern> manual|auto|skip [client]` / `chrome-bridge policy clear-site-mode <originPattern> [client]`, and register scheduled-workflow metadata with `chrome-bridge schedule workflow ... --at|--interval` (which starts nothing - see docs/security.md). Both edit local files under the human's control; the host stays the enforcement boundary either way. If you need the raw escape hatch for a host action, `browser_action` still forwards one action and is still fully policy-gated.

### Register

Copy `mcp/claude_desktop_config.example.json` into your MCP client config and set the absolute paths:

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

The server honors `BRIDGE_PORT`, `BRIDGE_TOKEN_FILE`, `BRIDGE_CONNECT_TIMEOUT_SECONDS`, `BRIDGE_MCP_RECONNECT_DELAY_MS`, `BRIDGE_MCP_READONLY`, and `BRIDGE_MCP_ALLOW_SENSITIVE`, and reads the same `bridge_token.txt`. Chrome with the loaded extension must be running and the native host registered (`./setup.sh` or `./setup-rs.sh`). Repo-local helpers are loaded from `BRIDGE_REPO_ROOT`, so packaged `uvx` launches do not need a separate `PYTHONPATH` entry.

If TCP connection setup fails before the host receives an action, MCP waits briefly and retries once. It deliberately does not replay timeouts or empty responses because a mutating action may already have run. If the MCP process itself is unavailable, the MCP client still owns restarting that process; the packaged-startup fix prevents the former sibling-import crash that caused this symptom while the CLI remained healthy.

### HTTP transport

By default the server speaks stdio. Set `BRIDGE_MCP_TRANSPORT=http` to serve over streamable HTTP instead, bound to `BRIDGE_MCP_HTTP_HOST` (default `127.0.0.1`) and `BRIDGE_MCP_HTTP_PORT` (default `8723`).

#### Per-request bridge tokens

One HTTP endpoint can serve several agents, each with its own bridge identity. Every request may carry a named bridge token:

- `Authorization: Bearer <bridge-token>` - preferred.
- `X-Bridge-Token: <bridge-token>` - fallback for clients that reserve `Authorization` for something else.

Precedence: a valid `Bearer` value wins; otherwise `X-Bridge-Token` is used; if neither header is present the request falls back to the server's ambient `bridge_token.txt` identity, so existing single-identity HTTP setups keep working unchanged. This is always on - no feature flag - and stdio is unaffected (there is no HTTP request behind a stdio tool call, so the ambient token is always used).

The header token is passed straight to the native host as that request's token. The host resolves it to a client name from `bridge_tokens.txt`, so per-request identity drives policy scoping, audit attribution, and cooperative leasing. An unknown token is rejected by the host with its usual `unauthorized` error; token values are never logged by the MCP server or included in its error text.

Two agents against one endpoint:

```
# bridge_tokens.txt (git-ignored; see bridge_tokens.txt.example)
researcher:<token-a>
publisher:<token-b>
```

```
BRIDGE_MCP_TRANSPORT=http BRIDGE_MCP_HTTP_PORT=8723 chrome-bridge-mcp
```

Agent A registers the endpoint with `Authorization: Bearer <token-a>`, agent B with `Authorization: Bearer <token-b>`. `browser_lease` from agent A now blocks agent B's mutating calls with `leased by researcher` and vice versa - lease arbitration works per HTTP client rather than being defeated by a shared identity.

Because identity is now per request rather than per process, the automatic lease wrapper (`BRIDGE_MCP_AUTO_IDENTITY`) is disabled under the HTTP transport: its cached lease state assumes one identity per server process, and keeping it would let the first caller silently hold the lease against everyone else. HTTP clients take and drop the lease explicitly with `browser_lease` and `browser_release`. The stdio transport is unchanged and still auto-leases.

#### W3C trace context

The incoming request's `traceparent` header is read next to the per-request bridge token and passed through to the host unchanged, so the host's request span joins the caller's trace instead of starting a detached one. Under stdio there is no incoming header, so a root trace is minted per tool call - but only when the host's opt-in spans are switched on with `BRIDGE_OTEL_ENABLED`; with it unset nothing is minted and no `traceparent` is sent.

The header is never logged and never reaches Chrome: the host strips it from the request envelope exactly as it strips the token and `dryRun`. A malformed value starts a fresh trace rather than failing the call. See `docs/telemetry.md` for the span model and for what those spans do and do not carry.
