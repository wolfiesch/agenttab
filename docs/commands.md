# Command reference

## Command reference

Examples below write `chrome-bridge <action>` as shorthand for `python3 test_client.py <action>`. Symlink `test_client.py` onto your `PATH` as `chrome-bridge` if you want the short form literally.

New checkout? `scripts/quick_install.sh` runs `./setup.sh` and prints the extension-load and MCP-registration steps in one pass (see `docs/setup.md`).

### Core

```bash
chrome-bridge ping
chrome-bridge navigate <url> [--foreground]
chrome-bridge getTabs
chrome-bridge getCookies <domain>
chrome-bridge executeScript <tabId> <code>
chrome-bridge executeScriptCDP <tabId> <code>
chrome-bridge observe <tabId> [--compact|--full] [--role <role[,role...]>] [--name <text>] [--limit <count>]
```

`observe` prints a compact accessibility view by default (role, accessible name, and value). Use `--role button,link`, `--name Save`, and `--limit 20` to narrow it further. Both compact and full snapshots use Chrome's real accessibility tree, so both attach Chrome's debugger. `--full` also includes node IDs, descriptions, and detailed accessibility properties. Text extraction, HTML capture, and text waits use normal extension page access and do not attach the debugger.

### Navigation and tabs

```bash
chrome-bridge activateTab <tabId>
chrome-bridge closeTab <tabId>
chrome-bridge reload <tabId>
chrome-bridge goBack <tabId>
chrome-bridge goForward <tabId>
```

### Windows

```bash
chrome-bridge windowControl list
chrome-bridge windowControl create [url] [normal|minimized|maximized] [--foreground]
chrome-bridge windowControl focus <windowId>
chrome-bridge windowControl setState <windowId> normal|minimized|maximized
chrome-bridge windowControl close <windowId>
```

`windowControl` is one action with an `op` field. `list` reports only structural facts per window - `id`, `focused`, `state`, `type`, and `tabCount` - and deliberately never returns tab URLs or titles, so its raw output cannot leak browsing context; use `getTabs` when you actually need per-tab detail. `create` opens the new window unfocused unless `--foreground` is passed, and an explicit `minimized`/`maximized` state overrides the focus preference because Chrome rejects the combination. `focus` raises one window; `setState` changes a window's state.

`windowControl close` is destructive: it closes a window and every tab in it. It refuses to close the last remaining `normal` browser window, returning `success: false` with `reason: "lastNormalWindow"` instead of leaving the profile with no browser window. `windowControl` is in the sample policy's allowed actions; add it to `requireConfirmation` if you want every window mutation gated.

### Task-owned tabs

Task sessions give an agent a set of tabs that survives extension-worker restarts and belongs only to that task. New tabs are inactive by default and placed in a named Chrome tab group. Closing a session can only close tabs recorded as belonging to that session. Session records are cleared when Chrome itself restarts so stale tab numbers can never point at unrelated restored tabs.

```bash
chrome-bridge taskSession create "GPU research"
chrome-bridge taskSession navigate <sessionId> <url>
chrome-bridge taskSession navigate <sessionId> <url> --new
chrome-bridge taskSession show [sessionId]
chrome-bridge taskSession state <sessionId> <working|needs_user|completed>
chrome-bridge taskSession close <sessionId>
```

Use `--foreground` only when the user intentionally needs to see the session tab. Prefer task sessions over omitted tab IDs so a human tab change cannot redirect the agent.

The tab group is an ownership boundary, not a place where Chrome can hide its debugger notice. Chrome shows that notice across the browser whenever any extension debugger is attached. On task-owned tabs, the bridge reuses one debugger connection for debugger-backed actions during the active burst and detaches after 30 seconds idle. This prevents the notice from repeatedly opening and closing between nearby actions. A tab manually moved into the task's Chrome group is also treated as task-owned. Commands on unrelated tabs keep the older one-command connection behavior for compatibility and may still re-trigger the notice.

The extension requires Chrome 118 or newer because its 30-second idle timer relies on service-worker timers supported from that version onward.

### Waits

```bash
chrome-bridge waitForLoad <tabId> [timeoutMs]
chrome-bridge waitForSelector <tabId> <selector> [timeoutMs]
chrome-bridge waitForText <tabId> <text> [timeoutMs]
chrome-bridge waitForUrl <tabId> <substring> [timeoutMs]
```

### Batch sequences

```bash
chrome-bridge batch <stepsJson> [tabId] [--continue-on-error]
```

`batch` runs an array of `{ "action": ..., "payload": {...} }` steps in order over one bridge request. Any action the extension dispatches is a valid step, so the wait actions (`waitForLoad`, `waitForSelector`, `waitForText`, `waitForUrl`) interleave freely with mutating steps - no special casing, they resolve through the same dispatch table as a standalone call.

Per step: `delayMs` sleeps before the step runs; `payload.tabId` defaults to the batch-level `tabId`; and a step-level `timeoutMs` is passed through into the step payload when the payload does not set one itself, which is the convenient form for waits (`{"action": "waitForSelector", "timeoutMs": 15000, "payload": {"selector": "#done"}}`). A step with no `action` records `null` and is skipped.

A step fails when it throws or returns `success: false`. `stopOnError` defaults to `true`: the first failure aborts the batch and the whole request fails with `batch step <index> (<action>) failed: <message>`. Pass `--continue-on-error` (wire field `stopOnError: false`) to keep going instead; each failed step is recorded in place as `{"success": false, "step": <index>, "action": ..., "err": ...}` and the batch still reports success. `batch` is confirmation-gated in the sample policy, and host-side redaction applies recursively to batch results.

### Page state and content

```bash
chrome-bridge getCurrentState <tabId>
chrome-bridge screenshot <tabId> <outputPath> [--visible]
chrome-bridge extractText <tabId> [maxChars]
chrome-bridge getHTML <tabId> <outputPath>
chrome-bridge printToPDF <tabId> <outputPath> [--landscape] [--scale <factor>]
```

Navigation opens an inactive tab by default. Use `--foreground` only when the user needs to see the new tab. Screenshots use the background-safe debugger path by default; `--visible` explicitly selects the tab before capturing the visible window. `screenshot` writes a PNG file and prints path, MIME type, and byte count only. `getHTML` writes UTF-8 HTML to a file and prints path and byte count only.

`printToPDF` exports the tab through CDP `Page.printToPDF` on the same background-safe debugger path as `screenshot`, so it never activates or focuses the tab. The CLI writes the PDF to `<outputPath>` and prints path, MIME type, and byte count only; the base64 document never reaches the terminal. `--landscape` and `--scale <factor>` map to the CDP options of the same name, and the wire payload additionally accepts `printBackground`, `paperWidth`, `paperHeight`, and `pageRanges` (for example `"1-3,5"`). The CLI sets `printBackground` to true so the exported page matches what the tab renders. `scale`, `paperWidth`, and `paperHeight` must be positive numbers.

### Pointer, keyboard, and forms

```bash
chrome-bridge click <tabId> <selector>
chrome-bridge clickAt <tabId> <x> <y>
chrome-bridge type <tabId> <selector> <text>
chrome-bridge hover <tabId> <selector>
chrome-bridge scroll <tabId> <deltaX> <deltaY> [selector]
chrome-bridge press <tabId> <keySpec>
chrome-bridge drag <tabId> <fromSelector> <toSelector>
chrome-bridge fill <tabId> <selector> <text>
chrome-bridge select <tabId> <selector> <value>
chrome-bridge uploadFile <tabId> <selector> <path...>
chrome-bridge githubAttachUploadedFiles <tabId> <inputSelector> [formSelector] [timeoutMs]
chrome-bridge githubSubmitComment <tabId> [formSelector] [timeoutMs]
chrome-bridge github-attach-pr-body <tabId> <file...> [--timeout <milliseconds>]
```

`type` focuses and inserts text. `fill` clears first, then inserts text. `click`, `type`, `hover`, `drag`, `fill`, `select`, and `uploadFile` accept plain CSS plus semantic selector prefixes: `css=<selector>`, `text=<visible-text>`, `aria=<accessible-name>`, `label=<form-label>`, and `role=<role>[name=<accessible-name>]`. For example, `chrome-bridge click 123 'aria=Show options'` or `chrome-bridge click 123 'role=button[name=Save]'` avoids guessing GitHub-specific CSS. Use `<host> >>> <shadow-selector>` for open shadow DOM and `frame=<iframe-selector> >> <target-selector>` for iframe targets; these forms also work for `<select>` elements and file inputs. `uploadFile` expands local paths and fails before contacting Chrome when any file is missing.

`clickAt` dispatches CDP `Input.dispatchMouseEvent` (`mouseMoved`, `mousePressed`, `mouseReleased`) directly at the given viewport coordinates, in CSS pixels relative to the top-left of the tab's viewport. `x` and `y` must be non-negative numbers. Prefer selector-based `click`: because `clickAt` resolves no element, there is no tag name, accessible name, or selector to record, so the audit log cannot show what was actually clicked and a stale coordinate can hit an unintended control. For that reason `clickAt` is in the sample policy's `requireConfirmation` list - each call returns a one-use token, and you resume it with `chrome-bridge confirm <token>`. Use it only when no selector can reach the target, such as canvas, map, or PDF-viewer surfaces.

Unlike `click`, `clickAt` has no DOM fallback: it only sends synthesized input. An inactive background tab may therefore ignore the events, so activate the tab (or use `click`) when the target tab is not the foreground one.

For GitHub comments, use `uploadFile` first, then `githubAttachUploadedFiles` to call GitHub's `<file-attachment>` component without opening arbitrary `executeScript*` access. Use `githubSubmitComment` instead of a broad submit-button click on draft PRs; it only clicks an exact `Comment` or `Add comment` button and refuses `Close with comment`. Both GitHub-specific actions also verify the target tab is on `https://github.com`.

For a pull-request description, prefer `github-attach-pr-body`. It performs the whole narrow workflow: verifies a `/owner/repo/pull/number` GitHub page, opens only the PR body's options menu and edit form, sets the requested local files, calls GitHub's own attachment component, waits for new `user-attachments` CDN URLs, and clicks the one exact `Update comment`/`Save` button inside that form. Existing body text is preserved. Missing files fail locally before Chrome is contacted.

### Viewport

```bash
chrome-bridge setViewport <tabId> <width> <height> [deviceScaleFactor]
```

### Emulation

```bash
chrome-bridge setCpuThrottling <tabId> <rate>
chrome-bridge setNetworkConditions <tabId> <offline:0|1> [latencyMs] [downBps] [upBps]
chrome-bridge clearNetworkConditions <tabId>
chrome-bridge setColorScheme <tabId> light|dark|no-preference
chrome-bridge setUserAgent <tabId> <userAgent>
```

`setCpuThrottling` sets Chrome's CPU throttling rate; use `rate >= 1`, with `1` disabling throttling. `setNetworkConditions` applies CDP `Network.emulateNetworkConditions` and persists until `clearNetworkConditions` resets it. `setColorScheme` overrides `prefers-color-scheme`. `setUserAgent` overrides the tab's user agent string.

### Diagnostics, interception, downloads, storage, geolocation, and metrics

```bash
chrome-bridge startMonitoring <tabId>
chrome-bridge stopMonitoring <tabId>
chrome-bridge consoleMessages <tabId>
chrome-bridge networkRequests <tabId>
chrome-bridge handleDialog <tabId> accept|dismiss [promptText]
chrome-bridge startInterception <tabId> <urlPattern> continue|abort|fulfill [status] [body]
chrome-bridge stopInterception <tabId>
chrome-bridge interceptedRequests <tabId>
chrome-bridge downloadUrl <url> [filename]
chrome-bridge storageState <tabId> <outputPath>
chrome-bridge setGeolocation <tabId> <latitude> <longitude> [accuracy]
chrome-bridge clearGeolocation <tabId>
chrome-bridge performanceMetrics <tabId>
chrome-bridge policyCheck <action> [payloadJson]
chrome-bridge policyCheck --plan '<jsonArray>'
chrome-bridge policy info
chrome-bridge policy show
chrome-bridge policy doctor
chrome-bridge policy allow-action <action> [client]
chrome-bridge policy allow-origin <pattern> [client]
chrome-bridge audit tail [count]
chrome-bridge audit summary [--since <ISO8601|7d|12h|30m>]
```

`startMonitoring` leaves Chrome's debugger attached to the tab until `stopMonitoring`, so Chrome's debugger notice may persist across the browser while monitoring is active. `startInterception` leaves Fetch/debugger attached until `stopInterception`. `networkRequests` and `interceptedRequests` store URLs as origin plus pathname and report `hasQuery` instead of query strings. `downloadUrl` writes into Chrome's configured download location; Chrome rejects arbitrary absolute output paths. `storageState` writes cookies, localStorage, and sessionStorage to disk and prints metadata only. `setGeolocation` grants geolocation for the tab origin through Chrome content settings, applies a CDP geolocation override, and `clearGeolocation` resets that origin to `ask`.

`policyCheck` is host-side and never forwards to Chrome: it reports what `bridge_policy.json` would decide (`allowed`, `reason`, `confirmationRequired`, `redact`, `audit`) for the given action/payload. Tab-scoped actions also include `originDependent: true` because the live tab origin is additionally checked at forward time.

`policyCheck --plan` preflights a whole plan in one host-side call. The argument is a JSON array of up to 50 `{"action": ..., "origin": ..., "payload": ...}` steps; the response is `result.plan`, one verdict per step with the same fields plus the `step` index. `origin` is an optional hypothetical tab origin: supply it and a tab-scoped step is evaluated against that origin and reports `originDependent: false`, since the caller has already stated the origin the real request would carry. Nothing is forwarded and no state changes.

Every command also accepts the global `--dry-run` flag. The host runs the full pipeline for the request - token check, policy evaluation, lease check, origin-dependency determination - then stops before forwarding to Chrome and answers `{"success": true, "dryRun": true, "wouldForward": <bool>, "action": ..., "targets": [...], "verdict": {...}}`. A confirmation-gated action reports `confirmationRequired` in its verdict without minting a token, and a dry run never acquires a lease, never triggers an interactive origin-approval prompt, and never resolves a live tab origin (that lookup is itself an extension round-trip, so `originDependent` reports where the real request would additionally be origin-checked).

```bash
chrome-bridge --dry-run navigate https://github.com
```

When an action such as `executeScript` is confirmation-gated, the response includes a one-use token and `resumeCommand`. Resume without rebuilding the original JSON:

```bash
chrome-bridge confirm <confirmationToken>
```

The host stores the exact original client identity, action, and payload only for the short confirmation lifetime (60 seconds by default). This lets the normal CLI resume a token produced by MCP while still re-running the original client's policy, live-origin, lease, and confirmation checks before forwarding. The older `confirm <action> <token> <payloadJson>` form remains compatible but is no longer necessary.

The `policy` subcommands let an agent self-service policy when an action is denied. `policy info` asks the host for the active `bridge_policy.json` / audit-log paths (always answerable, even under a deny-all policy, and it never returns policy contents over the wire). `policy show` prints the local policy file; `policy doctor` reads recent deny events from the audit log and proposes the precise fix for each: a `policy allow-action`/`policy allow-origin` command when an item is missing from an allow-list (`not allowed`), or a manual deny-list edit when a deny-list pattern matched (`denied`, which a grant cannot override). `policy allow-action`/`policy allow-origin` edit the policy file in place (mode `600`); with no client argument they edit the section the host says governs this client, and an explicitly named client always edits its own `clients.<name>` section so a new name never silently broadens the shared `default`. Every deny response also carries a structured `policyDenial` companion (`kind`, `suggestedPatch`, `policyFile`, `batchStep`) alongside the byte-stable `policy denied: <reason>` error string.

The `audit` subcommands read the host's local audit log; they open no socket beyond the `policy info` lookup that resolves the log path, and they add no host action. `audit tail` prints the last `count` entries (default 20) as aligned columns: timestamp, client, action, decision, reason, request ID. `audit summary` aggregates the log into total entries, per-client and per-action counts, allow/deny/confirm/other outcome counts, the top five deny reasons, and the time range covered; `--since` accepts an ISO 8601 stamp or a relative window such as `7d`, `12h`, or `30m`. Both print metadata only - the audit log never stores payload or response bodies, and neither command reconstructs them. When the host cannot be reached, they fall back to the repo-local `bridge_audit.jsonl` and say so; a missing or empty log is reported as such, and malformed JSONL lines are counted and reported rather than printed.

### Cookie and storage writes

```bash
chrome-bridge setCookie <url> <name> <value> [--domain <domain>] [--path <path>] [--secure] [--http-only] [--same-site no_restriction|lax|strict] [--expires <epochSeconds>]
chrome-bridge deleteCookie <url> <name>
chrome-bridge setStorageItem <tabId> local|session <key> <value>
chrome-bridge removeStorageItem <tabId> local|session <key>
chrome-bridge clearStorage <tabId> local|session|both
```

These five commands mutate the real profile's session state, so the example policy confirmation-gates all of them: expect a `confirmationToken` plus `resumeCommand` on the first call and resume with `chrome-bridge confirm <token>`. Responses carry identifiers only. `setCookie` reports the stored cookie's name and domain and never the value; `deleteCookie` reports the removed name; `setStorageItem` and `removeStorageItem` echo scope and key only; `clearStorage` reports removed key counts only. Storage commands run against the target tab's origin and require an `http`/`https` tab.

### History, bookmarks, and cross-tab search

```bash
chrome-bridge searchHistory <query> [maxResults] [--since <epochMillis>]
chrome-bridge searchBookmarks <query>
chrome-bridge searchTabs <query> [--regex] [--max-per-tab <count>] [--case-sensitive]
```

`searchHistory` returns url, title, `lastVisitTime`, and `visitCount` per hit; `maxResults` defaults to 20 and is capped at 100. `searchBookmarks` returns id, title, url, and the parent folder path. Both read the real profile's private browsing record, so the example policy confirmation-gates them.

`searchTabs` scans visible text in every open `http`/`https` tab and returns, per matching tab, the tab id, the origin host (never the full URL), the match count, and up to `--max-per-tab` snippets (default 5, capped at 20) of the match plus 80 characters of context on each side. `--regex` treats the query as a JavaScript regular expression and `--case-sensitive` disables the default case-insensitive match. Tabs that cannot be scripted (`chrome://` pages, the Chrome Web Store) are skipped silently and reported as `skippedTabs`.

### Real-profile moat: session probe and human handoff

These two commands exploit what sets this bridge apart from Playwright/Puppeteer: it drives your **real, already-logged-in Chrome profile**, so existing sessions (cookies, SSO, passkeys) are ambient. Neither command ever reads, imports, or overwrites cookie values - they only observe and hand control to you.

```bash
chrome-bridge sessionStatus <domain> [<domain> ...]
chrome-bridge waitForHandoff <message> [mode] [selectorOrUrlOrText] [timeoutMs] [tabId]
```

`sessionStatus` is a **redacted auth probe**: for each domain it reports cookie count, cookie *names* (never values), whether a session/auth cookie is present, and a `loggedIn` boolean - enough to decide "is this profile already signed in to X?" without exposing secrets. Treat its output as sensitive: cookie names plus logged-in status can reveal which accounts and sites the profile uses.

`waitForHandoff` **pauses automation and hands control to you**: it focuses the target tab, changes its task-group label to `↗ Review needed`, shows a compact bottom card with your `message`, and blocks until the page reaches an expected state. It then restores the previous task state and resumes the agent. Use it for interactive steps an agent should not perform - login, 2FA, captcha, payment confirmation. `mode` is `manual` (default; resolves when you change the page), `selector`, `url`, or `text`; the positional argument after `mode` is the selector/URL-substring/text to wait for. `timeoutMs` defaults to 120000. The CLI raises its socket read timeout to cover the wait, so long handoffs do not time out in transport. Under MCP auto-lease, the cooperative lease is extended to span the whole handoff window so another agent cannot mutate the profile while you are acting.

## Raw-output safety

These commands can reveal private browsing context:

- `getTabs`
- `getCurrentState`
- `extractText`
- `getHTML`
- `screenshot`
- `printToPDF`
  - The written PDF contains the full rendered page; treat the file like `screenshot` output and do not paste its contents.
- `consoleMessages`
- `networkRequests`
- `interceptedRequests`
- `storageState`
  - Raw output is written to the requested file and may include cookies, localStorage, and sessionStorage.
  - Do not paste the file contents into transcripts.
- `searchHistory`
  - Raw output is the human's private browsing record: URLs, titles, and visit counts.
- `searchBookmarks`
  - Bookmark titles, URLs, and folder names reveal private context.
- `searchTabs`
  - Snippets are page content taken from every open tab; report counts and domains, not snippet text.
Never paste raw cookies, raw tab URLs/titles, screenshot contents, raw HTML, or network URLs into transcripts unless the user explicitly asks for that output.

Use redacted summaries:

```bash
chrome-bridge getTabs | python3 -c 'import sys,json,urllib.parse as u; d=json.load(sys.stdin); tabs=d.get("result", []); print("success:", d.get("success")); print("tab_count:", len(tabs) if isinstance(tabs, list) else tabs); print("active_domains:", sorted({u.urlparse(t.get("url","")).netloc for t in tabs if isinstance(t, dict) and t.get("active")}))'
```

```bash
chrome-bridge networkRequests <tabId> | python3 -c 'import sys,json; d=json.load(sys.stdin); reqs=d.get("result",{}).get("requests",[]); print("success:", d.get("success")); print("request_count:", len(reqs)); print("paths:", sorted({r.get("url","") for r in reqs if isinstance(r, dict)})[:10]); print("any_query:", any(r.get("hasQuery") for r in reqs if isinstance(r, dict)))'
```

Cookie checks should print counts and names only:

```bash
chrome-bridge getCookies "github.com" | python3 -c 'import sys,json; d=json.load(sys.stdin); r=d.get("result", []); print("success:", d.get("success")); print("cookie_count:", len(r) if isinstance(r, list) else r); print("cookie_names:", sorted(c.get("name","") for c in r) if isinstance(r, list) else [])'
```
