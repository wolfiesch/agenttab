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
chrome-bridge observe <tabId> [--compact|--full] [--diff] [--role <role[,role...]>] [--name <text>] [--limit <count>]
```

`observe` prints a compact accessibility view by default (role, accessible name, and value). Use `--role button,link`, `--name Save`, and `--limit 20` to narrow it further. Both compact and full snapshots use Chrome's real accessibility tree, so both attach Chrome's debugger. `--full` also includes node IDs, descriptions, and detailed accessibility properties. Text extraction, HTML capture, and text waits use normal extension page access and do not attach the debugger.

Every observed node carries a stable `ref` such as `e12`. Pass it back as `ref=e12` wherever a selector is accepted, which removes the guesswork of turning an accessibility node back into a CSS selector. Refs are minted per tab in extension memory and are invalidated by a navigation or by an extension service-worker restart; the per-tab counter never rewinds, so a ref is never reused for a different element. Using an unknown or invalidated ref fails loudly with `{"success": false, "error": "staleRef", "hint": "re-run observe"}` - it never falls back to matching the literal text as CSS. Re-run `observe` and use the fresh ref.

`--diff` returns only what changed since the previous `observe` of that tab: `added` (nodes), `removed` (refs), and `changed` (nodes whose role, name, or value changed), plus `baseEpoch` (the snapshot the diff is against) and `epoch` (the snapshot just taken). The first `--diff` call with no baseline - a fresh tab, after a navigation, or after an extension restart - returns the full snapshot with `"diffBase": true`. Only the latest snapshot is retained per tab, capped at 5000 nodes, so a diff is always against the immediately preceding `observe`.

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

### Deterministic postconditions

```bash
chrome-bridge expect <tabId> selector <selector> [--negate] [--timeout <ms>]
chrome-bridge expect <tabId> text <expectedText> [--negate] [--timeout <ms>]
chrome-bridge expect <tabId> url <urlSubstring> [--negate] [--timeout <ms>]
chrome-bridge expect <tabId> schema <schemaPath> [--negate] [--timeout <ms>]
```

A wait answers "has this happened yet"; `expect` answers "did the thing I intended actually happen", and answers it as a **check with an exit code** rather than as prose a model has to grade. There is no model anywhere in the path: each mode is a deterministic evaluation against the same machinery the mutating actions use.

- `selector` passes when the selector resolves. It goes through the normal locator grammar, so CSS, `text=`/`label=`/`role=`/`aria=`, `frame=... >> ...`, `shadow >>>`, and `ref=eN` all behave exactly as they do for a click.
- `text` passes when the page text contains the string.
- `url` passes when the tab URL contains the substring.
- `schema` passes when structured extraction against the JSON Schema file at `<schemaPath>` reports no `missingRequired` errors. It reuses `extractStructured`, so the supported schema subset is identical.
- `--negate` inverts the outcome. That is how you assert **absence**: the poll then runs until the condition stops holding.
- `--timeout` polls (every 250 ms) until the condition holds or the deadline passes. Default 5000 ms, capped at 60000 ms.

`expect` is an assertion, **not a read**. The response carries `mode`, `negate`, `passed`, `attempts`, `elapsedMs`, and - only when `passed` is `false` - a short `reason`. The matched element, the matched text, the tab URL, and the extracted values are never returned, so a failing assertion cannot be used as a back-door page read. The exit code is the deliverable: `0` when the condition held, `1` when it did not, which is what makes it composable.

```bash
chrome-bridge click 42 "text=Place order" \
  && chrome-bridge expect 42 text "Order confirmed" --timeout 10000 \
  && chrome-bridge expect 42 selector "#cart-badge" --negate
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
chrome-bridge extractStructured <tabId> <schemaPath> [outputPath] [--selector <selector>] [--max-chars <count>]
chrome-bridge scanPromptInjection <tabId> [--selector <selector>] [--max-chars <count>]
```

Navigation opens an inactive tab by default. Use `--foreground` only when the user needs to see the new tab. Screenshots use the background-safe debugger path by default; `--visible` explicitly selects the tab before capturing the visible window. `screenshot` writes a PNG file and prints path, MIME type, and byte count only. `getHTML` writes UTF-8 HTML to a file and prints path and byte count only.

`printToPDF` exports the tab through CDP `Page.printToPDF` on the same background-safe debugger path as `screenshot`, so it never activates or focuses the tab. The CLI writes the PDF to `<outputPath>` and prints path, MIME type, and byte count only; the base64 document never reaches the terminal. `--landscape` and `--scale <factor>` map to the CDP options of the same name, and the wire payload additionally accepts `printBackground`, `paperWidth`, `paperHeight`, and `pageRanges` (for example `"1-3,5"`). The CLI sets `printBackground` to true so the exported page matches what the tab renders. `scale`, `paperWidth`, and `paperHeight` must be positive numbers.

`extractStructured` reads a page into JSON that a schema you supply describes, instead of a wall of text. `schemaPath` is a local JSON file holding a **JSON Schema subset**: `object`, `array`, `string`, `number`, `boolean`, plus `enum`, `required`, `properties`, and `items`. Anything outside that subset is rejected up front rather than silently ignored, so a constraint you wrote is either enforced or reported.

Mapping is deterministic and heuristic, with no model inference in the loop: field names (and their de-camel-cased forms) are matched against `dl` term/definition pairs, single-value table rows, form-control labels, `aria-label`, `itemprop`/`data-field`, `name` attributes, headings followed by a value block, and `Key: value` text lines. Arrays of objects are read from a table whose headers match the item properties; arrays of scalars from a labelled `ul`/`ol` or a delimited value. `--selector` scopes the read to one subtree (CSS or a semantic selector, resolved in the main frame; a cross-origin iframe is not reachable this way). A field with no confident value is **omitted** rather than guessed, and every missing required field appears in `errors` with a `path` and a `code` such as `missingRequired`, `typeMismatch`, or `enumMismatch`. The result carries `data`, `errors`, and `schemaVersion`; the extracted data is then re-validated against the schema, so nothing ships that the schema does not describe. With `outputPath` the data is written there and stdout carries only path, byte count, `schemaVersion`, and `errors`; without it the validated data is printed. Raw page text is never returned either way - but the extracted values are still page content, so treat them as untrusted data.

`scanPromptInjection` reports a **posture signal** for a page or subtree: it scans the extracted text for instruction-like patterns aimed at an agent, its tools, its secrets, or its policy - ignore previous instructions, reveal the system prompt, exfiltrate tokens or cookies, run a shell command, click Allow, disable policy, hide this from the user. It returns `risk` (`low`, `medium`, `high`), `matches` with `kind`, `severity`, and a snippet capped at 160 characters, and `scannedChars`; the full text never leaves the extension. `extractText` and `getHTML` accept a wire-level `scanPromptInjection: true` that adds the same block as an `injectionScan` field without changing their existing result fields. The scan is heuristic: a hit is a warning for you, never a permission grant or denial by itself, and a clean result is not a guarantee that the page is safe to follow.

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

`type` focuses and inserts text. `fill` clears first, then inserts text. `click`, `type`, `hover`, `drag`, `fill`, `select`, `uploadFile`, `scroll`, and `waitForSelector` accept plain CSS plus semantic selector prefixes: `ref=e<N>` (an element ref from `observe`), `css=<selector>`, `text=<visible-text>`, `aria=<accessible-name>`, `label=<form-label>`, and `role=<role>[name=<accessible-name>]`. For example, `chrome-bridge click 123 'ref=e12'`, `chrome-bridge click 123 'aria=Show options'`, or `chrome-bridge click 123 'role=button[name=Save]'` avoids guessing GitHub-specific CSS. A `ref=` target is resolved from the live node recorded by `observe`, not re-matched by text, and a navigation or extension service-worker restart invalidates it: the action then fails with `error: staleRef` rather than silently acting on a different element. Use `<host> >>> <shadow-selector>` to reach into an open shadow root and `frame=<iframe-selector> >> <selector>` to reach into an iframe.

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

### Screencast recording

```bash
chrome-bridge startScreencast <tabId> [--quality <1-100>] [--max-width <pixels>]
chrome-bridge screencastSave <tabId> <outputDir> [--fps <rate>] [--mp4]
chrome-bridge stopScreencast <tabId>
```

`startScreencast` attaches Chrome's debugger and starts CDP `Page.startScreencast` on the tab, so recording works on a background tab and never activates it. Frames default to JPEG at quality 70 and every frame (`everyNthFrame` 1); `png`, `maxWidth`, `maxHeight`, and `everyNthFrame` are also accepted in the action payload. The debugger stays attached (and Chrome's debugger infobar may persist) until `stopScreencast`.

Frames buffer **only in the extension service worker**: recording does not survive a service-worker restart, and a restart drops whatever was buffered. The buffer is bounded at 600 frames or roughly 50MB of base64; past either bound the **oldest** frames are dropped and counted in `droppedFrames`, so a gapped recording is always distinguishable from a complete one.

`screencastSave` drains the buffer once, writes contiguous zero-padded `frame-00000.jpg`/`.png` files plus a `frames.json` manifest (`count`, `dropped`, `timestamps`) into `outputDir`, and prints only the directory, frame count, dropped count, byte total, manifest path, and `staleArtifactsRemoved` - never frame data. `outputDir` is created and checked for writability **before** any frame is drained, because draining consumes the extension's buffer irrecoverably; a destination that cannot be prepared fails while the frames are still recoverable. Only artifacts a previous save wrote (`frame-*.png`, `frame-*.jpg`, `frames.json`, `screencast.mp4`) are removed from it first, so a shorter second save into the same directory cannot present an earlier recording's tail as part of itself, and unrelated files there are left alone. The manifest is written to a temp file and renamed, so its `count` always matches the frames on disk. With `--mp4` it additionally calls the **system** `ffmpeg` (resolved from `PATH`; never bundled) to assemble `screencast.mp4` at `--fps` (default 8). If `ffmpeg` is missing or fails, the frames are kept and the response carries a `note` explaining why no mp4 was written.

`stopScreencast` stops the screencast and detaches the debugger unless monitoring or interception still holds it, reporting `remainingFrames`, `droppedFrames`, and `capturedFrames`. Frames still buffered at stop are discarded, so run `screencastSave` first.

Continuous capture of a real, logged-in profile is high-exposure: every pixel the tab renders while recording is buffered, including anything the human happens to have on screen in that tab. The example policy therefore confirmation-gates `startScreencast` while leaving `screencastFrames` and `stopScreencast` ungated, so a recording cannot begin without an explicit human confirmation.

### Diagnostics, interception, downloads, storage, geolocation, and metrics

```bash
chrome-bridge startMonitoring <tabId>
chrome-bridge stopMonitoring <tabId>
chrome-bridge consoleMessages <tabId> [--source-maps]
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
chrome-bridge policy bundle verify <bundlePath> --lockfile <lockPath>
chrome-bridge policy bundle lock <bundlePath> --lockfile <lockPath> [--force]
chrome-bridge policy bundle show
chrome-bridge policy allow-action <action> [client]
chrome-bridge policy allow-origin <pattern> [client]
chrome-bridge policy allow-egress <pattern> [client]
chrome-bridge policy clear-egress <pattern> [client]
chrome-bridge policy site-mode <originPattern> manual|auto|skip [client]
chrome-bridge policy clear-site-mode <originPattern> [client]
chrome-bridge policy dlp <clipboard|upload|download|screenShare> allow|audit|block [client]
chrome-bridge audit tail [count]
chrome-bridge audit summary [--since <ISO8601|7d|12h|30m>]
chrome-bridge audit export --format <jsonl|syslog|cef> --destination <dest> [--since <ISO8601|7d|12h>] [--limit N]
chrome-bridge audit export --format <jsonl|syslog|cef> --dry-run
chrome-bridge trace summary <traceId> [--trace-dir <dir>]
chrome-bridge trace tail <traceId> [count] [--trace-dir <dir>]
```

`consoleMessages` returns the buffered console entries for a monitored tab. Every entry now carries a `stack` array of the raw generated frames CDP reported: `url`, 0-based `lineNumber` and `columnNumber`, `functionName`, and the CDP `scriptId`. Entries without a stack (most `Log.entryAdded` records) fall back to a single frame built from the entry's own url and line.

`--source-maps` adds best-effort source-map resolution on top of that, leaving the rest of the response shape unchanged. For each frame the extension reads the script (CDP `Debugger.getScriptSource`, falling back to a plain fetch), looks for a trailing `//# sourceMappingURL=` comment, and decodes a source-map v3 map in the service worker. A resolved frame gains `originalLocation` with `source`, `name`, and 0-based `lineNumber`/`columnNumber`; an unresolved frame gains `sourceMapStatus`:

- `notFound` - no script source, no `sourceMappingURL`, or the map could not be fetched
- `invalid` - the map is not decodable source-map v3 (index maps with `sections` are not supported)
- `unmapped` - the map decoded, but the generated position has no mapping. This includes a position **left of the first mapping segment on its line**: the nearest segment to the right is not a mapping for that column, so reporting it would fabricate an original location the map never claimed
- `crossOriginRefused` - the `sourceMappingURL` resolved off the script's own origin

Only same-origin (or inline `data:application/json`) maps are read, so resolution never contacts a third-party origin. Parsed maps are cached in service-worker memory per tab and script URL, capped at 100 entries and dropped when the tab closes. Script text and the map's `sourcesContent` are never returned or printed; the CLI additionally scrubs any source-text-shaped field before printing `--source-maps` output.

`startMonitoring` leaves Chrome's debugger attached to the tab until `stopMonitoring`, so Chrome's debugger notice may persist across the browser while monitoring is active. `startInterception` leaves Fetch/debugger attached until `stopInterception`. `networkRequests` and `interceptedRequests` store URLs as origin plus pathname and report `hasQuery` instead of query strings. `downloadUrl` writes into Chrome's configured download location; Chrome rejects arbitrary absolute output paths. `storageState` writes cookies, localStorage, and sessionStorage to disk and prints metadata only. `setGeolocation` grants geolocation for the tab origin through Chrome content settings, applies a CDP geolocation override, and `clearGeolocation` resets that origin to `ask`.

`policyCheck` is host-side and never forwards to Chrome: it reports what `bridge_policy.json` would decide (`allowed`, `reason`, `confirmationRequired`, `redact`, `audit`) for the given action/payload. Tab-scoped actions also include `originDependent: true` because the live tab origin is additionally checked at forward time. Every verdict - single, per plan step, and dry-run - also carries `effectiveTier`: `read_only` or `mutating` for that exact action **and payload**, which is the tier a `manual` `siteModes` origin gates on. It is computed from the payload, so `screencastFrames` with `consume: false` is `read_only` while the consuming default is `mutating`, and a `batch`/`replayWorkflow` is `read_only` only when every one of its steps is. See docs/security.md for the full escalation table.

Every verdict - single, per plan step, and dry-run - also carries `dlp`: the resolved data-loss-prevention mode for that action's channel (`allow`, `audit`, or `block`), or `null` when the action belongs to no channel. A `block` shows up as `allowed: false` with `reason: "dlp blocked"`; see `policy dlp` below and docs/security.md.

`policyCheck --plan` preflights a whole plan in one host-side call. The argument is a JSON array of up to 50 `{"action": ..., "origin": ..., "payload": ...}` steps; the response is `result.plan`, one verdict per step with the same fields plus the `step` index. `origin` is an optional hypothetical tab origin: supply it and a tab-scoped step is evaluated against that origin and reports `originDependent: false`, since the caller has already stated the origin the real request would carry. Nothing is forwarded and no state changes.

Every command also accepts the global `--dry-run` flag. The host runs the full pipeline for the request - token check, policy evaluation, lease check, origin-dependency determination - then stops before forwarding to Chrome and answers `{"success": true, "dryRun": true, "wouldForward": <bool>, "action": ..., "targets": [...], "verdict": {...}}`. A confirmation-gated action reports `confirmationRequired` in its verdict without minting a token, and a dry run never acquires a lease, never triggers an interactive origin-approval prompt, and never resolves a live tab origin (that lookup is itself an extension round-trip, so `originDependent` reports where the real request would additionally be origin-checked).

```bash
chrome-bridge --dry-run navigate https://github.com
```

Every command also accepts the global `--traceparent <value>` flag: a W3C trace-context header value naming the trace this run belongs to. The host continues that trace when its opt-in OpenTelemetry spans are enabled (`BRIDGE_OTEL_ENABLED`, see `docs/telemetry.md`) and otherwise ignores it; either way the field is host-only and stripped before anything reaches Chrome, exactly like the bridge token and `--dry-run`. A malformed value starts a fresh trace rather than failing the command.

```bash
chrome-bridge --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 getTabs
```

When an action such as `executeScript` is confirmation-gated, the response includes a one-use token and `resumeCommand`. Resume without rebuilding the original JSON:

```bash
chrome-bridge confirm <confirmationToken>
```

The host stores the exact original client identity, action, and payload only for the short confirmation lifetime (60 seconds by default). This lets the normal CLI resume a token produced by MCP while still re-running the original client's policy, live-origin, lease, and confirmation checks before forwarding. The older `confirm <action> <token> <payloadJson>` form remains compatible but is no longer necessary.

The `policy` subcommands let an agent self-service policy when an action is denied. `policy info` asks the host for the active `bridge_policy.json` / audit-log paths (always answerable, even under a deny-all policy, and it never returns policy contents over the wire). `policy show` prints the local policy file; `policy doctor` reads recent deny events from the audit log and proposes the precise fix for each: a `policy allow-action`/`policy allow-origin` command when an item is missing from an allow-list (`not allowed`), or a manual deny-list edit when a deny-list pattern matched (`denied`, which a grant cannot override). `policy allow-action`/`policy allow-origin` edit the policy file in place (mode `600`); with no client argument they edit the section the host says governs this client, and an explicitly named client always edits its own `clients.<name>` section so a new name never silently broadens the shared `default`. Every deny response also carries a structured `policyDenial` companion (`kind`, `suggestedPatch`, `policyFile`, `batchStep`) alongside the byte-stable `policy denied: <reason>` error string.

`policy site-mode` and `policy clear-site-mode` edit the `siteModes` map, which attaches a permission mode to an origin pattern rather than to an action. `manual` makes every mutating or high-risk action on a matching origin require a confirmation token even when `requireConfirmation` is empty; `auto` is the behavior when no pattern matches; `skip` pre-approves the confirmation gate for that origin so no token is minted. A mode never widens the action or origin gates - a `deniedActions`/`deniedOrigins` match still denies - and `skip` can never waive `executeScript`, `executeScriptCDP`, `getCookies`, `storageState`, `setCookie`, `deleteCookie`, `setStorageItem`, `removeStorageItem`, `clearStorage`, `startScreencast`, or `clickAt`. When several patterns match, the longest pattern wins. `siteModes` is merged per pattern across the `default` and `clients.<name>` layers, so a client-layer entry overrides only the origin it names. `policyCheck` and `--dry-run` verdicts report the resolved `siteMode`, and every `skip`-waived confirmation is recorded in the audit log as `confirmation_waived`. See docs/security.md for the full semantics.

`policy allow-egress` and `policy clear-egress` edit the `egressAllowlist` list, which bounds **where the agent may make the browser send a new outbound request** rather than which page an action may act upon. They follow the same editor rules as `policy allow-origin`: mode `600` write, no client argument edits the section the host reports for this client, and a named client always edits `clients.<name>` after seeding the list from the inherited effective list so one grant never revokes what was inherited. An empty or absent list means no egress constraint. When the list is non-empty, the host denies `navigate`, `navigateTaskSession`, `downloadUrl`, and `setCookie` to a host outside it - including inside a `batch` or `replayWorkflow` step, reported as `batch step <n>: egress not allowed` - with the error `policy denied: egress not allowed` and a `policyDenial` whose `kind` is `egress`. Site policy still wins: a `deniedOrigins`/`allowedOrigins` denial is reported as before, and an egress grant never authorizes an origin site policy refuses. The host cannot see click-driven in-page navigation, script-issued requests, or a page's own resource loads, so those are deliberately out of scope; see docs/security.md for the full coverage table and limitations.

`policy dlp` edits the `dlp` map, which attaches a data-loss-prevention mode to a *channel* rather than to an action or an origin. It follows the same editor rules as `policy site-mode`: mode `600` write, no client argument edits the section the host reports for this client, and the map is merged **per channel** by both hosts, so a client-layer entry never drops the default layer's other channels. `allow` is the default and what an absent channel resolves to; `audit` permits the action and writes exactly one audit event with decision `dlp_audit` naming the channel and nothing else; `block` denies with reason `dlp blocked` before anything is forwarded, so no file is opened and no frame is read. A mode outside those three resolves to `block`, deliberately failing closed. `upload` gates `uploadFile`, `githubAttachUploadedFiles`, and `githubAttachPrBody`; `download` gates `downloadUrl`; `screenShare` gates `startScreencast` and `screencastFrames`; a gated action nested in a `batch` or `replayWorkflow` step is denied as `batch step <n>: dlp blocked` with the step index in `policyDenial.batchStep`. `clipboard` is a declared channel with **no chokepoint**: no bridge action reads or writes the clipboard and a page-driven copy never crosses the bridge, so setting it records intent and enforces nothing - the CLI says so in the command's `note` field. Read the resolved mode back with `policyCheck`, whose verdict carries `dlp`. See docs/security.md for the channel table and the exact limits.

The `policy bundle` subcommands manage a content-addressed org policy bundle (`policyBundle`, see docs/security.md). They print **metadata only** - paths, digests, match/mismatch - and never bundle contents. `policy bundle verify` hashes the bundle, compares it against the `sha256` in the lockfile, prints the full digest, the 12-character short digest, the expected digest, and `match`, and exits `0` on a match, `1` on a mismatch or an unreadable/malformed bundle or lockfile, and `2` on a usage error - the same verdict the host reaches, so a mismatch here means the host would fail closed to the built-in default policy. `policy bundle lock` writes the current digest into the lockfile (mode `600`), refusing to overwrite a lockfile that pins a *different* digest unless `--force` is given, so repinning an org baseline is always deliberate. Both are offline file operations and need no running host: an admin locks a bundle before the host ever loads it. `policy bundle show` asks the host for the active bundle metadata from `policy info` and exits `1` when the active bundle is unverified.

The `audit` subcommands read the host's local audit log; they open no socket beyond the `policy info` lookup that resolves the log path, and they add no host action. `audit tail` prints the last `count` entries (default 20) as aligned columns: timestamp, client, action, decision, reason, request ID. `audit summary` aggregates the log into total entries, per-client and per-action counts, allow/deny/confirm/other outcome counts, the top five deny reasons, and the time range covered; `--since` accepts an ISO 8601 stamp or a relative window such as `7d`, `12h`, or `30m`. Both print metadata only - the audit log never stores payload or response bodies, and neither command reconstructs them. When the host cannot be reached, they fall back to the repo-local `bridge_audit.jsonl` and say so; a missing or empty log is reported as such, and malformed JSONL lines are counted and reported rather than printed.

`audit export` is a one-shot re-encode of that same local log to a SIEM destination, independent of the `auditExport` policy key. Use it to backfill a collector that was added late, or to prove a destination works before turning the policy sink on. `--format` picks `jsonl`, RFC 5424 `syslog`, or ArcSight `cef`; `--destination` is a local file path for `jsonl`/`cef`, or `udp://host:port`, `tcp://host:port`, or a unix datagram socket path for `syslog`. `--since` takes the same ISO 8601 stamp or relative window as `audit summary`, and `--limit N` keeps the most recent N matching events. `--dry-run` formats and counts without writing or connecting, so `--destination` becomes optional. Output is a metadata JSON object only - audit log path, format, destination, events read, events selected, events exported, byte total, and the counts of malformed, unformattable, and undated lines skipped - never an exported line. The command uses the host's own encoders, so a backfilled line and a live forwarded line are the same bytes; it performs no rotation and no pruning, unlike the policy sink. See docs/security.md for the field mapping tables and the fail-closed behavior of the policy sink.

The `trace` subcommands read a session trace artifact. When a policy layer sets `traceDir`, the host appends exactly one JSONL event per trace-eligible request to `<traceDir>/<traceId>.jsonl`: a request is eligible when its payload carries `sessionId`, `taskSessionId`, or an explicit `traceId`, when the action is `createTaskSession`/`navigateTaskSession`/`closeTaskSession`, or when the response result carries a `sessionId`. The trace id is taken in that order (`traceId` first, the response `sessionId` last, the action name as a fallback) and the file name keeps only `[A-Za-z0-9._-]`, capped at 80 characters. Each event records `ts`, `client`, `action`, `decision`, `reason`, `requestId`, `durationMs`, `targets` (tab ids only), `traceId`, `responseHash`, `snapshotHash` when the response carried an observe snapshot or diff, and `success`. `trace tail` prints the last `count` events (default 20) as aligned columns; `trace summary` prints per-action and per-decision counts, the time range, and duration totals. Both are metadata only - a trace stores no payload, no response body, and no page content, so neither command can reconstruct them. `--trace-dir` overrides the directory; otherwise the path comes from `policy info`, falling back to the repo-local `bridge_traces/`.

### Recorded workflows and the selector cache

```bash
chrome-bridge workflow record start [--tab <tabId>] [--name <name>] [--record-sensitive]
chrome-bridge workflow record stop [--id <recordingId>] [--out <path>]
chrome-bridge workflow record save <path>
chrome-bridge workflow replay <path> [--tab <tabId>] [--binding key=value] [--continue-on-error]
chrome-bridge cache selectors list [--sync]
chrome-bridge cache selectors clear [--local-only]
chrome-bridge cache selectors export <path>
chrome-bridge cache selectors import <path>
```

A recording captures **only what this bridge dispatched**. Every mutating action that returns successfully through the extension's dispatch table is appended to each active recording; human clicks and keystrokes in the tab are never observed, and a failed action is never recorded. `--tab` scopes a recording to one tab (it still records profile-wide steps such as `setCookie` that carry no `tabId`); with no `--tab` the recording is global. Recordings live only in extension service-worker memory, capped at 500 steps, so a worker restart drops them - that is why `stop` hands the workflow back for you to persist.

The serialized format is shared with `chrome-bridge schedule`: `{"version": 2, "name": ..., "steps": [{"action": ..., "payload": {...}, "wait": <ms>}], "policy": {"requiredOrigins": [...]}}`. `wait` is the recorded gap before the step, clamped to 10000 ms so a long human pause never stalls a replay. `requiredOrigins` collects every tab origin the recording touched.

**Version 2 adds per-step postconditions.** Both new keys are optional and additive, so a `"version": 1` file has neither and replays byte-for-byte under the version-2 reader; `replay` accepts version 1 and version 2 and reports the file's own version back as `workflowVersion`.

- `expect`: one object with the same shape as the `expect` payload minus `tabId` (`{mode, selector?, text?, urlSubstring?, schema?, negate?, timeoutMs?}`). It is evaluated against the step's effective tab after the step succeeds. The host enumerates it as a nested read-only `expect` step, so a postcondition is origin-checked like any other tab-scoped action.
- `retry`: `{max, delayMs}`. `max` is clamped to `0..5`, `delayMs` to `0..10000`. Out-of-range, malformed, or missing values clamp rather than reject, so an over-eager workflow degrades into a bounded one instead of refusing to run.

Recording never invents an `expect` clause - `startWorkflowRecording` cannot know what you meant to assert, so postconditions are authored or added to the file by hand.

**Typed and stored values are redacted by default.** `type`/`fill` text, `setCookie` and `setStorageItem` values, `handleDialog` prompt text, and any payload key that looks like a credential (`token`, `password`, `secret`, `credential`, `authorization`, `api_key`) are recorded as `<redacted>`, and the step is marked `"requiresValue": true` with a `bindingKeys` entry such as `step3.text`. Replay refuses the **whole** workflow - before running any step - until every one of those keys is supplied with `--binding step3.text=<value>`, so a half-run macro can never stop at the password field. Start the recording with `--record-sensitive` (or send `recordSensitive: true` in a single action's payload) to keep a value verbatim; then the workflow file itself holds that secret.

`stop` prints metadata only (step count, redacted step count, required bindings and origins, duration) and writes the workflow JSON to `bridge_workflow_last.json` in the repo, plus `--out <path>` when given. `save <path>` writes the stashed workflow to a caller path. Both files are git-ignored and mode `600`.

`replay` reproduces real mutating actions through the normal host pipeline. **The host evaluates every step before the replay is forwarded at all:** it walks `workflow.steps[]`, applies the same `--tab` retargeting the extension will apply, and runs each step through the action, origin, `siteModes`, lease, and blackout gates. A denied step denies the whole replay (`policy denied: workflow step <n>: <reason>`); nothing runs. A step that still requires confirmation fails the replay with `policy denied: workflow step <n> requires confirmation` and no token is issued - a single outer approval cannot stand in for per-step approval, so grant that step through policy or a `skip` site mode instead. The extension then additionally refuses any step whose live tab origin is not in the workflow's `requiredOrigins`. `--tab` retargets every tab-scoped step at one tab; `--continue-on-error` records failures in place instead of stopping at the first one. Output is per-step metadata (`step`, `action`, `success`, `selfHealed`, result shape) - never page content.

A step's postcondition runs **after** the step's own action reports success. If the assertion does not hold, the whole step - dispatch plus assertion - is re-run up to `retry.max` times with `retry.delayMs` between attempts. If it still does not hold, the step fails with `{"success": false, "err": "expect failed", "step": <index>, "action": ..., "expect": {"mode": ..., "reason": ...}}` and the usual `stopOnError` semantics apply (`--continue-on-error` keeps going). An `expect` clause that is malformed is a workflow authoring error and fails the step immediately without spending the retry budget.

Every step in the replay result carries `attempts` and `retried`, and a step with a postcondition also carries `expectPassed`; the result totals add `retriedSteps` and `expectFailedSteps`. That is the evidence the run actually produced, not a model's account of it - and it is metadata only: no matched element, matched text, or extracted value ever appears in it.

The **selector cache** makes replay deterministic. For `click`, `type`, `fill`, `select`, and `hover`, a *semantic* selector (`text=`, `label=`, `role=`, `aria=`) is resolved once and the concrete CSS path it landed on is cached against `(urlPattern, selector)`, where `urlPattern` is the tab's origin plus pathname. The next replay resolves **both** the cached path and the original semantic selector and uses the cached path only when the two land on the *same live DOM node* (compared by CDP backend node id). A cached path that still resolves but now points at a replacement element is discarded exactly like one that no longer resolves: the semantic selector wins, the cache is rewritten, and the step reports `"selfHealed": true`. That is deliberate - "the old CSS still matches something" is not evidence that it still matches what the author named. Imported entries are validated the same way at resolution time, so an edited cache file cannot make replay act on a substituted element. A **CSS selector is never cached and never retargeted**: it is a literal address, so a failing CSS step fails rather than silently clicking a different element. Frame- and shadow-scoped selectors resolve normally but are reported `cacheable: false`, because their CSS path is relative to another document.

`cache selectors list` prints the intent selectors, their url patterns, and their ages from the local `bridge_action_cache.json` (git-ignored, mode `600`); `--sync` merges the extension's live in-memory cache into the file first. `export <path>` writes the full entries, including the resolved CSS paths, to a caller path. `import <path>` merges a file into the local cache and pushes it into the extension; entries whose selector is not semantic are rejected and counted, so an edited cache file cannot make a CSS selector point somewhere new. `clear` empties both copies (`--local-only` leaves the extension cache alone).

### Scheduled workflows (local metadata only)

```bash
chrome-bridge schedule workflow <workflowPath> --at <ISO8601> [--name <name>]
chrome-bridge schedule workflow <workflowPath> --interval <seconds> [--name <name>]
chrome-bridge schedule list
chrome-bridge schedule remove <name>
```

`schedule` registers a validated pointer to a replayable workflow file. **It runs nothing.** Chrome Bridge has no scheduler daemon and no timer: the command only appends an entry to git-ignored `bridge_schedules.json` (mode `600`, overridable with `BRIDGE_SCHEDULE_FILE`) and prints the `runCommand` you must wire into cron, launchd, systemd timers, a CI job, or a manual step. Every response carries `runsUnattended: false` for exactly that reason.

The workflow file contract is `{version, name, steps: [{action, payload?, wait?}], policy: {requiredOrigins?}}`, where `wait` is milliseconds to pause after a step. `schedule workflow` validates that shape before writing anything and exits `2` with the offending step index if it does not hold. Give exactly one trigger: `--at` takes an ISO 8601 timestamp (a trailing `Z` is accepted), `--interval` takes whole seconds and rejects anything under 60. `--name` defaults to the workflow's own `name`, and re-registering an existing name replaces that entry instead of duplicating it.

A version-2 step may also carry `expect` and `retry` (see above). `schedule workflow` accepts them without change: it validates `action`, `payload`, and `wait` and leaves the postcondition clauses to the replay that actually runs.

An entry records the name, the absolute workflow path, the trigger, the step count, the workflow's declared `policy.requiredOrigins`, the registration timestamp, and the run command - never a step payload, because a recorded step can carry typed text or form values. Registration authorizes nothing: the host evaluates each replayed step against the live policy when it actually runs, so grant the origins first and decide the origin's `siteModes` mode before the first unattended run. See docs/security.md for the no-human-present trust model.

```bash
chrome-bridge schedule workflow ./workflows/nightly-report.json --interval 86400 --name nightly-report
# then, e.g. in crontab:
#   0 6 * * *  cd /path/to/chrome-native-bridge && ./test_client.py workflow replay ./workflows/nightly-report.json
```

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

### Real-profile moat: session probe, human handoff, credential handoff

These commands exploit what sets this bridge apart from Playwright/Puppeteer: it drives your **real, already-logged-in Chrome profile**, so existing sessions (cookies, SSO, passkeys) are ambient. None of them ever reads, imports, or overwrites cookie values - they only observe and hand control to you.

```bash
chrome-bridge sessionStatus <domain> [<domain> ...]
chrome-bridge waitForHandoff <message> [mode] [selectorOrUrlOrText] [timeoutMs] [tabId]
chrome-bridge credentialHandoff <tabId> <selector> [message] [--mode filled|submitted] [--timeout <milliseconds>]
```

`sessionStatus` is a **redacted auth probe**: for each domain it reports cookie count, cookie *names* (never values), whether a session/auth cookie is present, and a `loggedIn` boolean - enough to decide "is this profile already signed in to X?" without exposing secrets. Treat its output as sensitive: cookie names plus logged-in status can reveal which accounts and sites the profile uses.

`waitForHandoff` **pauses automation and hands control to you**: it focuses the target tab, changes its task-group label to `↗ Review needed`, shows a compact bottom card with your `message`, and blocks until the page reaches an expected state. It then restores the previous task state and resumes the agent. Use it for interactive steps an agent should not perform - login, 2FA, captcha, payment confirmation. `mode` is `manual` (default; resolves when you change the page), `selector`, `url`, or `text`; the positional argument after `mode` is the selector/URL-substring/text to wait for. `timeoutMs` defaults to 120000. The CLI raises its socket read timeout to cover the wait, so long handoffs do not time out in transport. Under MCP auto-lease, the cooperative lease is extended to span the whole handoff window so another agent cannot mutate the profile while you are acting. While the handoff is in flight the host also blacks out observation for every client - `screenshot`, `extractText`, `getHTML`, `storageState`, `printToPDF`, `searchTabs`, `getCurrentState`, and `screencastFrames` are denied with `handoff in progress` (scoped to the handoff's `tabId`, or all tabs when it has none), so nothing can watch you type credentials.

`waitForHandoff` is a **top-level action only**. A `batch` or `replayWorkflow` carrying it is denied as `batch step <n>: handoff not allowed in a composite` before anything is forwarded, because a composite runs its remaining steps inside the extension: those steps never pass back through the host, so no blackout could be applied to them and a later step would observe the tab while you are still on it. Ask for the handoff as its own request, then send the rest of the sequence.

`credentialHandoff` is `waitForHandoff` narrowed to **one field**, and it is the supported way to get a password, passphrase, recovery code, or one-time code into a page. Never route a secret through `fill`: that puts the value in a command line, in the request payload, and in whatever transcript the caller keeps. `credentialHandoff` instead drops every capture buffer for the tab, focuses the tab, window, and the field named by `selector` (CSS, semantic, or `ref=eN`; frame-scoped selectors are not supported), shows the banner with `message`, and waits for you to type. **The value is never read, and neither is its length.** The injected probe returns only whether the field is present, whether it is empty, whether its form submitted, and whether it is focused. A character count is excluded on purpose, because the length of a secret narrows a brute-force search, so the response carries no value-derived datum at all. `--mode filled` (default) resolves on a short run of consecutive non-empty probes, which debounces a partially typed value; `--mode submitted` resolves when the field's owning form submits or the page navigates. `--timeout` defaults to 120000 and the CLI raises its socket read timeout to cover the wait. For the whole window the native host holds a handoff blackout over the tab, so `screenshot`, `getHTML`, `observe`, and every other observation action are denied to every client - including the one that asked for the handoff. A successful response is `{success, tabId, selector, mode, filled, elapsedMs, scrubbedCaptures}`; a timeout is `credential handoff timeout after <n>ms`.

Like `waitForHandoff`, `credentialHandoff` is a **top-level action only** - a `batch` or `replayWorkflow` containing it is refused (`batch step <n>: handoff not allowed in a composite`) rather than run without a blackout, since the composite's later steps would execute inside the extension while you are still typing the secret.

## Raw-output safety

These commands can reveal private browsing context:

- `getTabs`
- `getCurrentState`
- `extractText`
- `getHTML`
- `extractStructured`
  - Output is limited to the schema's fields, but those values are still page content; with `outputPath` they are written to the file and stdout stays metadata.
- `scanPromptInjection`
  - Match snippets are page text, capped at 160 characters each. Report `risk` and `kind`, not snippet text, unless the user asked to see it.
- `screenshot`
- `printToPDF`
  - The written PDF contains the full rendered page; treat the file like `screenshot` output and do not paste its contents.
- `consoleMessages`
  - Console text and stack frames can carry page data and script URLs.
  - `--source-maps` resolves frames to original build paths, which can expose private source file names and directory layout. Report resolved locations only when the user asked for them.
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
- `startScreencast` / `screencastFrames`
  - A screencast is a continuous stream of rendered page pixels; `screencastFrames` returns base64 image data.
  - Always drain through `screencastSave`, which writes the frames to disk and prints only counts and byte totals. Never print raw `screencastFrames` output.
- `workflow record stop` / `workflow record save` / `cache selectors export`
  - The written files are not page content, but a workflow reproduces mutating actions against a real logged-in profile and a selector cache maps a site's DOM structure. Both are git-ignored and mode `600`; review a workflow before replaying it and do not paste either file into transcripts.
  - A workflow recorded with `--record-sensitive` contains the literal typed value. Prefer the default redaction plus `--binding` at replay time.
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
