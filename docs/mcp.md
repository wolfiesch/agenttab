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
- `browser_extract_text`
- `browser_console_messages` - buffered console entries for a monitored tab (start monitoring first via `browser_action` `startMonitoring`). Each entry carries a `stack` of raw generated frames (`url`, 0-based `lineNumber`/`columnNumber`, `functionName`); `resolve_source_maps=True` adds best-effort `originalLocation` (`source`, `name`, 0-based `lineNumber`/`columnNumber`) or a `sourceMapStatus` of `notFound`, `invalid`, `unmapped`, or `crossOriginRefused`. Only same-origin or inline maps are read and source text is never returned, but resolved `source` paths can expose a site's private build layout
- `browser_screenshot` (returned inline as an image)
- `browser_save_pdf` - print a tab to PDF on the background-safe debugger path, write it to a caller-supplied local path, and return only path, MIME type, and byte count (annotated read-only: the page is not mutated)
- `browser_get_html`, `browser_lease_status`
- `browser_policy_check` - ask the host what its policy would decide for an action/payload without forwarding it
- `browser_plan_preview` - preflight a list of up to 50 `{action, origin, payload}` steps against host policy in one call; returns a per-step verdict (`step`, `action`, `allowed`, `reason`, `confirmationRequired`, `redact`, `audit`, `originDependent`) and forwards nothing
- `browser_wait_for` (`mode`: `load|selector|text|url`)
- `browser_search_tabs` - search visible text across every open http/https tab; returns tab id, origin host, match count, and bounded snippets (snippets are page content, so treat output as sensitive)
- `browser_screencast_save` - drain the tab's buffered screencast frames to numbered image files plus a `frames.json` manifest in a caller-supplied directory, returning only directory, frame count, dropped count, byte total, and manifest path (annotated read-only: the page is not mutated, and recorded pixels never enter the transcript)
- `browser_trace_summary` / `browser_trace_tail` - read a local session trace artifact written by the host when policy sets `traceDir`. Summary returns event counts by action and decision, the time range, and duration totals; tail returns the most recent events (`ts`, `action`, `decision`, `reason`, `requestId`, `durationMs`, `targets`, `traceId`, `responseHash`, `snapshotHash`, `success`). Both are metadata only: a trace stores no payload, no response body, and no page content. `trace_dir` overrides the host's configured directory

Sensitive:

- `browser_get_cookies`
- `browser_session_status` - redacted auth/session probe (cookie names/counts + `loggedIn` per domain, never values)
- `browser_search_history` - search the real profile's browsing history (url, title, `lastVisitTime`, `visitCount`; `max_results` capped at 100)
- `browser_search_bookmarks` - search the real profile's bookmarks (id, title, url, parent folder path)

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
- `browser_wait_for_handoff` - pause automation, mark the task group as needing review, focus the real tab with a compact bottom card, and wait for a human to finish login/2FA/captcha before resuming
- `browser_confirm_action` - resend an action with a host-issued confirmation token
- `browser_confirm` - resume the exact pending action from only its host-issued token

Sensitive and mutating (require `BRIDGE_MCP_ALLOW_SENSITIVE=1`, confirmation-gated by the example policy):

- `browser_set_cookie` - write one cookie; the response reports name and domain only, never the value
- `browser_delete_cookie` - remove one cookie; destructive, can sign the profile out of a site
- `browser_set_storage_item`, `browser_remove_storage_item` - write or remove one `local`/`session` storage entry; responses echo scope and key only
- `browser_clear_storage` - clear `local`, `session`, or `both` for the tab origin; destructive, reports removed key counts only

Escape hatch (sensitive):

- `browser_action` - escape hatch for any raw bridge action (interception, geolocation, monitoring, console/network logs, `downloadUrl`, `storageState`, `executeScript`, `setViewport`, `handleDialog`, `batch`, ...). A `"dryRun": true` entry in `payload` is passed through to the host as the request-level dry-run flag: the host evaluates policy, lease, and confirmation state and returns `{dryRun, wouldForward, verdict}` without forwarding the action to Chrome.

### Resources

- `browser://tabs` - live tab list.
- `browser://tab/{id}/state` - current state of a tab.

### Scoping

The server reads two env flags to scope the exposed surface:

- `BRIDGE_MCP_READONLY=1` registers only the read-only tools, hiding navigate/click/type/upload, tab mutations, `browser_confirm_action`, and `browser_action`.
- `BRIDGE_MCP_ALLOW_SENSITIVE=1` is required to expose sensitive tools (`browser_get_cookies`, `browser_session_status`, `browser_search_history`, `browser_search_bookmarks`, the cookie/storage write tools, and the raw `browser_action` escape hatch), which are hidden by default. The host policy remains the enforcement boundary even when this escape hatch is exposed.

Tools carry `readOnly`/`destructive` annotations so clients can prompt appropriately.

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
