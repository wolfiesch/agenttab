# AgentTab v2 setup

AgentTab v2 is currently local, prerelease source at `2.0.0-rc.1`. It has no public package, signed release artifact, Chrome Web Store installation, or hosted setup page. **Chrome Bridge v1.0.1 is still the public stable legacy path.**

This guide distinguishes the contributor source path from the future signed RC and stable paths. Do not substitute an old Chrome Bridge script, Python host, TCP port, bearer token, or hand-written native-host manifest for any of them.

## Prerequisites and trust boundary

- Chrome must be version 127 or later for the current extension manifest.
- AgentTab runs in the existing signed-in Chrome profile. It is task-scoped browser control, not a separate profile, cookie jar, or identity boundary.
- Keep page content untrusted. Use **Your Turn** for passwords, passkeys, 2FA, CAPTCHA, payment secrets, and other human-only input. Review a staged **Commit** before performing it.
- A future installation needs an AgentTab extension and the `dev.agenttab.host` native host. Standard mode does not require a TCP listener, a bearer token, or a Python process.

The product boundary and residual Commit risk are described in the [runtime ADR](adr/0001-agenttab-runtime.md) and [Security](security.md).

## Current source path

A checkout is a contributor build path, not a supported consumer installation. From the repository root, the following pathless commands build the source components. They are written for POSIX shells, PowerShell, and `cmd.exe` when run from the repository root:

```text
bun install --frozen-lockfile
bun run extension:build
bun run workspace:build
cargo build --locked --manifest-path host-rs/Cargo.toml
```

`bun run extension:build` creates the unpacked development extension in `packages/extension/dist/` from the canonical source in `packages/extension/src/`. `bun run workspace:build` builds the TypeScript adapters, installer packages, and site. The Rust command builds the host workspace.

These commands do **not** create a public release, verify a signed artifact, register a complete consumer installation, or make the extension available through the Chrome Web Store. This repository does not publish a manual source host-registration recipe. The supported consumer path must be the artifact-verifying installer once an RC is available.

## Future signed RC path

When, and only when, an explicitly signed `2.0.0-rc.1` package and immutable RC artifact manifest are made available to approved testers, the intended command is:

```text
npx agenttab@2.0.0-rc.1 install --version 2.0.0-rc.1 --verify-readiness
```

That is not a command to run today. The package and signing material are not public. The installer rejects `latest` URLs, verifies the signed manifest, requires the exact `vX.Y.Z` tag and matching host asset, then records an install receipt. `--verify-readiness` opens Chrome unless `--no-open-browser` is supplied, creates a disposable task tab, captures an accessibility snapshot, and closes the tab.

For an approved development artifact, `agenttab install --development` accepts an explicitly supplied manifest URL, signature URL, and public-key file. Those inputs are supplied by the release workflow, not inferred from a local checkout. See the exact flag behavior in [Commands](commands.md#agenttab-install).

## Future public stable path

After signing, registry, Chrome Web Store, controlled-domain, and platform gates are complete, the stable host installation flow will be:

```text
npx agenttab install
```

This is a future command, not evidence of a live package. The final stable flow requires the publicly reachable AgentTab extension from the Chrome Web Store and the matching versioned installer artifact. Until those are published, load only a development extension for approved source or RC testing.

## Loading and enabling the development extension

The installer deliberately stages the extension but does not silently install or enable a browser extension. Its result identifies the extension directory. For an approved source or RC test:

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the installer-reported AgentTab extension directory. For a source build, that is `packages/extension/dist/`.
4. Confirm that **AgentTab** is enabled.
5. Open the AgentTab popup and choose **Enable AgentTab automation**. Chrome requests the optional `scripting` permission. The required `debugger` permission is already present from extension installation; both capabilities are required for Standard browser automation.
6. Run `agenttab doctor --layer extension` after the extension is enabled. Use `agenttab doctor --layer ipc` to check the local host path.

The manifest keeps `nativeMessaging`, `debugger`, `tabs`, `tabGroups`, `storage`, and `alarms` as required permissions because Chrome rejects `debugger` in `optional_permissions`. `scripting` is optional and is requested only from the user-facing popup. Removing it disables automation and detaches active task debugger sessions until it is enabled again.

## Native identity, registration, and local paths

The frozen native host identity is `dev.agenttab.host`. The extension build derives its stable development identity and the native-host allowed origins from [config/identity.json](../config/identity.json). Do not edit a generated native-host JSON, substitute an extension ID, or add an origin by hand.

A successful installer registers the same native-host manifest for supported browser locations. The manifest launches the small `agenttab-native` relay; the per-user `agenttab-host daemon` keeps Core IPC and the journal alive across Chrome service-worker or native-port churn. Stable installs attempt to activate a user-level launchd, systemd, or Windows scheduled-task entry without elevation. If that service manager is unavailable, the relay starts the daemon on demand instead:

| Platform | Native Messaging registration |
|---|---|
| macOS | Per-user Chrome, Chromium, and Microsoft Edge `NativeMessagingHosts` directories below `~/Library/Application Support/`. |
| Linux | Per-user Google Chrome, Chromium, and Microsoft Edge `NativeMessagingHosts` directories below `~/.config/`. |
| Windows | A manifest below the installer state directory plus current-user `HKCU` registrations for Chrome, Chromium, and Microsoft Edge. |

The Rust host uses `AGENTTAB_STATE_DIR` when it is explicitly set. Without it, the host root is `~/.agenttab` on Unix and `%LOCALAPPDATA%\AgentTab` on Windows. The installer has its own `--state-dir` default of `~/.agenttab`; use its receipt rather than assuming that the installer directory is the host state root on Windows. The TypeScript client also uses `AGENTTAB_STATE_DIR` for private resume-capability storage and for its Unix fallback endpoint.

Normal local adapter traffic uses one of these OS-native endpoints:

| Platform | Endpoint |
|---|---|
| macOS and Linux | `$XDG_RUNTIME_DIR/agenttab/agenttab.sock` only when that runtime directory belongs to the current user; otherwise `$AGENTTAB_STATE_DIR/run/agenttab.sock`, defaulting to `~/.agenttab/run/agenttab.sock`. |
| Windows | `\\.\pipe\agenttab-<current-user-SID>`. |

On Unix, AgentTab requires its state and runtime directories to be current-user owned and mode `0700`; its socket and host lock are mode `0600`. The host authenticates local peers with OS credentials. On Windows, the named-pipe DACL is limited to the current user SID and `SYSTEM`. `AGENTTAB_SOCKET` and `AGENTTAB_PIPE_NAME` are adapter overrides for configured local endpoints, not normal setup switches.

## Migration from Chrome Bridge v1.0.1

AgentTab v2 is side-by-side and recoverable:

1. Leave the existing Chrome Bridge extension, `com.automation.bridge` native-host registration, legacy token or policy files, and logs intact.
2. Install and prove AgentTab first, including an enabled extension and a successful `agenttab doctor` check.
3. Only then disable the old unpacked Chrome Bridge extension manually in `chrome://extensions`.
4. Keep v1 repair or recovery work pinned to `v1.0.1` until the v2 release is public.

The installer detects the old native-host registration and known legacy state artifacts, reports them, and leaves them untouched. It never silently removes the v1 extension, registration, files, policies, or logs.

## Update, rollback, and uninstall

The installer serializes each install, update, rollback, uninstall, or prune for a state directory with a cross-process lock. It records a recovery intent, stages changed files, creates backups for replaced or deleted files, and preflights required same-directory hard links on every target filesystem before the first target mutation. Unsupported exFAT/SMB configurations therefore fail without partially activating AgentTab. It rolls back touched files and exact Windows registry defaults if a multi-file transaction or requested readiness gate fails. A later mutating command recovers an interrupted, uncommitted intent before planning new work; it preserves and reports any resource that no longer matches either recorded transaction side. Unix uses directory durability barriers. Node exposes no equivalent Windows directory barrier, so Windows guarantees process-crash recovery but not sudden power-loss namespace atomicity; the installation doctor check reports this explicitly. A second successful installation of the same verified version leaves matching files unchanged. An update is explicit and version-aware: `agenttab update --version X.Y.Z` accepts only an exact version newer than the active managed receipt. The prior version stays staged for `agenttab rollback`.

To return a test profile to the available legacy path, disable AgentTab manually in `chrome://extensions` and continue using the preserved Chrome Bridge v1.0.1 setup. Do not delete Chrome Bridge files as part of that rollback.

For a managed v2 test installation, `agenttab rollback`, `agenttab uninstall`, and `agenttab prune --keep N` use schema-v2 receipts. Cleanup restores or removes a file only while its hash and mode still match the receipt. Rollback aborts before any mutation if an activation file, owned client entry, or Windows registry default drifted. Prune restores a receipt's prior file when an inactive artifact displaced one, and deletes only when the prior snapshot records absence. Client and registry cleanup restores exact owned values while preserving later user edits and unrelated configuration. Registry cleanup deletes only the owned default value, never a browser/vendor key recursively. File cleanup names every exact receipt-owned file; it does not recursively delete the state directory or a version tree. Use `--dry-run` before cleanup when inspecting a test machine.

Uninstall affects only AgentTab v2 receipts and values. It never removes the preserved Chrome Bridge v1 extension, registration, state, policy, token, or logs. Receipt-less or older schema-v1 test installs are intentionally not guessed at; reinstall them through the managed v2 flow before using automated lifecycle commands.

## Supported-platform state

The installer source recognizes host target triples for macOS ARM64 and x86_64, Linux ARM64 and x86_64, and Windows ARM64 and x86_64. Those mappings are implementation support, not a public release promise: no signed v2 artifact matrix is available yet. A public v2 installation is unavailable on every platform until the release gates are complete.

## Next steps

- [Command reference](commands.md)
- [MCP stdio setup and tool semantics](mcp.md)
- [Security and trust boundary](security.md)
- [Runtime architecture decision](adr/0001-agenttab-runtime.md)
