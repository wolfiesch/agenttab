# MCP server

## MCP server

`mcp/` exposes the bridge to MCP clients (Claude Desktop, Cursor, Cline) so an agent drives your real, logged-in Chrome profile through the standard Model Context Protocol. It is a pure client of the token-gated `127.0.0.1:9223` TCP API; the extension, wire protocol, and host are unchanged.

The server reuses `test_client.py`'s transport verbatim, so the MCP tools and the CLI stay in lockstep.

### Tools

The MCP server ships a grouped tool set. Legacy tab-scoped tools take an optional `tab_id`; omitting it targets the active tab. For new workflows, prefer task-session tools so a human tab change cannot redirect the agent.

Read-only:

- `browser_list_tabs`
- `browser_task_session_list`
- `browser_snapshot` (compact by default; filter by roles/name/limit or request full details)
- `browser_extract_text`
- `browser_screenshot` (returned inline as an image)
- `browser_save_pdf` - print a tab to PDF on the background-safe debugger path, write it to a caller-supplied local path, and return only path, MIME type, and byte count (annotated read-only: the page is not mutated)
- `browser_get_html`, `browser_lease_status`
- `browser_policy_check` - ask the host what its policy would decide for an action/payload without forwarding it
- `browser_plan_preview` - preflight a list of up to 50 `{action, origin, payload}` steps against host policy in one call; returns a per-step verdict (`step`, `action`, `allowed`, `reason`, `confirmationRequired`, `redact`, `audit`, `originDependent`) and forwards nothing
- `browser_wait_for` (`mode`: `load|selector|text|url`)
- `browser_search_tabs` - search visible text across every open http/https tab; returns tab id, origin host, match count, and bounded snippets (snippets are page content, so treat output as sensitive)

Sensitive:

- `browser_get_cookies`
- `browser_session_status` - redacted auth/session probe (cookie names/counts + `loggedIn` per domain, never values)
- `browser_search_history` - search the real profile's browsing history (url, title, `lastVisitTime`, `visitCount`; `max_results` capped at 100)
- `browser_search_bookmarks` - search the real profile's bookmarks (id, title, url, parent folder path)

Mutating:

- `browser_navigate`
- `browser_task_session_create`, `browser_task_session_navigate`, `browser_task_session_state`, `browser_task_session_close`
- `browser_click`, `browser_type`, `browser_fill`, `browser_hover`
- `browser_click_at` - click raw viewport coordinates; no element is resolved, so nothing identifies the target in the audit log. Prefer `browser_click`; the sample policy confirmation-gates `clickAt`
- `browser_scroll`, `browser_press`, `browser_drag`
- `browser_select`
- `browser_upload_file` (validates local paths before contacting Chrome)
- `browser_github_attach_pr_body` (opens only the GitHub PR-body editor, attaches files, waits for CDN URLs, and saves)
- `browser_tab_control` (`op`: `activate|close|reload|back|forward`), `browser_lease`, `browser_release`
- `browser_window_control` (`op`: `list|create|focus|setState|close`) - `list` returns only window id/focus/state/type/tab count, never tab URLs or titles; `create` is unfocused unless `focused=True`; `close` is destructive and refuses to close the last remaining normal window
- `browser_set_cpu_throttling`, `browser_set_network_conditions`, `browser_clear_network_conditions`, `browser_set_color_scheme`, `browser_set_user_agent`
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

By default the server speaks stdio. Set `BRIDGE_MCP_TRANSPORT=http` to serve over streamable HTTP instead, bound to `BRIDGE_MCP_HTTP_HOST` (default `127.0.0.1`) and `BRIDGE_MCP_HTTP_PORT` (default `8723`). Note: the server forwards a single ambient bridge token, so all HTTP clients share one bridge identity. Cooperative leasing (below) arbitrates only between distinct token identities (e.g. separate stdio servers each pointed at their own named token); per-request token propagation over one HTTP endpoint is not yet implemented.
