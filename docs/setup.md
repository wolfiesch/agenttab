# Setup and project layout

Chrome Bridge is published from the canonical GitHub repository `wolfiesch/chrome-bridge`. Your local checkout directory may have a different name; commands in this document assume you are running from the repository root.

## Layout

```text
chrome-bridge/
├── extension/                          <- public unkeyed extension source copy
│   ├── manifest.json
│   ├── background.js
│   ├── wake.html
│   └── wake.js
├── background.js                       <- editable service-worker source
├── wake.html / wake.js                 <- legacy explicit wake page; routine retries never open it
├── manifest.json                       <- public unkeyed source manifest
├── extension_identity.py               <- local key and extension ID helper
├── bridge.py                           <- native host
├── broker.py                           <- opt-in launchd TCP broker for stable client port 9223
├── bridge_policy.example.json          <- explicit opt-in policy template
├── com.automation.bridge.json.template <- host-manifest template (setup.sh fills it in)
├── setup.sh / setup-rs.sh              <- generates token/policy, deploys extension, registers host
├── setup-windows.ps1                   <- user-scope (HKCU) native-host registration on Windows
├── setup-edge.sh                       <- adds a Microsoft Edge registration for an existing install
├── setup-broker.sh                     <- installs launchd broker mode on macOS
├── uninstall-broker.sh                 <- stops launchd broker mode
├── bridge_wake.py                      <- shared wake-page discovery/opening helper
├── test_client.py                      <- CLI client
├── benchmark_harness.py                <- benchmark and comparison harness
├── verify_bridge.py                    <- offline framing/auth test
├── verify_cli_contract.py              <- offline CLI dispatch test
├── verify_heartbeat_contract.py        <- offline heartbeat/structure test
├── verify_benchmark_harness.py         <- offline benchmark contract test
├── verify_install_contract.py           <- offline install/identity contract test
├── verify_agent_actions_live.py        <- manual live browser gate
└── README.md
```

`setup.sh` generates `bridge_token.txt` (0600 shared secret), installs `bridge_policy.json` from `bridge_policy.example.json` when absent, deploys a local keyed extension manifest, and writes `com.automation.bridge.json`. `setup-rs.sh` additionally generates `com.automation.bridge.rust.json` and the `bridge-host-launch.sh` wrapper. The optional `bridge_tokens.txt` named-token registry (see Multi-client tokens and leasing) is also a local secret. All of these are git-ignored and stay local. Keep Python files out of Chrome-loaded extension directories: running them creates `__pycache__`, and Chrome refuses folders containing `_`-prefixed names.

## Components

| File | Role |
|---|---|
| `extension/manifest.json` | Public unkeyed MV3 source manifest. `setup.sh` and `deploy.sh --with-local-key` write a keyed copy into the local extension directory for a deterministic unpacked ID. |
| `extension/background.js` | Service worker: connects to the native host, runs browser actions, and uses `chrome.alarms` plus heartbeat messages to self-heal after idle or sleep. |
| `wake.html`, `wake.js` | Legacy explicit recovery page retained for packaging compatibility. The CLI and broker never open it during routine retries. |
| `bridge.py` | Native host. Talks to Chrome over stdio and exposes a token-gated TCP server on `127.0.0.1:9223` for local clients. |
| `com.automation.bridge.json.template` | Host-manifest template. `setup.sh` substitutes the absolute host path and local or packaged extension ID. |
| `test_client.py` | Positional CLI client (`python3 test_client.py <action> ...`). |
| `.github/workflows/ci.yml` | Pull-request and `main` push gates for syntax, offline contracts, Rust parity, benchmarks, and packaging checks. |
| `.github/workflows/release.yml` | Tag-driven release workflow for `v*` tags after the CI command set passes. |
| `scripts/package_release.py` | Stdlib release packager for source archives, unpacked extension bundles, and Rust host binaries. |
| `scripts/quick_install.sh` | One-command bootstrap: runs `setup.sh`, probes the bridge, and prints the extension-load and MCP-registration steps. |
| `scripts/generate_browser_manifests.py` | Deterministic Edge/Firefox native-messaging manifest generator plus the Firefox extension staging directory. Writes into `dist/browsers` and prints metadata only. |

## Requirements

- Google Chrome, Chrome Beta, or Chromium with Developer mode. The macOS installer also registers Chrome Canary.
- Python 3.9+ for the core bridge and CLI; Python 3.10+ for the MCP server (`mcp/`, matching `mcp/pyproject.toml`).
- macOS or Linux for `setup.sh` and `setup-rs.sh`; Windows for `setup-windows.ps1`. Broker mode and `setup-broker.sh` are macOS-only because they use launchd.

## Platform and browser matrix

| Browser | Platform | Installer | Status |
|---|---|---|---|
| Chrome / Chromium | macOS, Linux | `./setup.sh`, `./setup-rs.sh` | Supported. Full action surface, live gates run here. |
| Chrome | Windows | `setup-windows.ps1` | Supported registration. Same extension and same host code; HKCU registry registration instead of a manifest directory. Broker mode is unavailable (launchd only). |
| Microsoft Edge (Chromium) | macOS, Linux | `./setup-edge.sh` | Supported registration. Same `chrome-extension://` origin scheme, same MV3 service worker, canonical extension unchanged. |
| Microsoft Edge (Chromium) | Windows | `setup-windows.ps1 -Browser Edge` | Supported registration under the Edge HKCU key. |
| Firefox | any | `scripts/generate_browser_manifests.py --browser firefox` | Generated artifacts only. The native-messaging manifest and a staged extension directory are produced deterministically; the runtime is **not supported**. See Firefox limitations below. |

## Quickstart

From a fresh checkout, one command runs the installer and prints everything left to do by hand:

```bash
scripts/quick_install.sh
```

It detects macOS or Linux, runs `./setup.sh --print-json` from the repository root, probes the bridge with `python3 test_client.py ping` (a failure there is expected and non-fatal until the extension is loaded), and then prints the unpacked-extension directory reported by `setup.sh`, the `chrome://extensions/` steps, and a ready-to-paste MCP registration block with this checkout's absolute path already substituted.

To install on a non-default port, pass it positionally or through `PORT`; either form is forwarded to `./setup.sh --host-port`:

```bash
scripts/quick_install.sh 9224
PORT=9224 scripts/quick_install.sh
```

Only macOS and Linux are supported, matching `setup.sh`'s native-host auto-registration. Everything the script does can be done by hand with the steps below.

## Setup

Default local install:

```bash
./setup.sh
```

The script generates or reuses `extension_key.pem`, deploys `background.js` plus a keyed manifest into a per-user extension directory, registers the native host for that deterministic extension ID, creates `bridge_token.txt` when absent, and installs `bridge_policy.json` from the example template when absent. It prints the extension directory at the end.

Then:

1. Open `chrome://extensions/` and enable Developer mode.
2. Load unpacked: the extension directory printed by `./setup.sh`.
3. Enable only one bridge extension at a time. Duplicate bridge extensions race to bind port `9223`.
4. Verify:
   ```bash
   python3 test_client.py ping
   python3 test_client.py policyCheck getTabs '{}'
   ```
   Expected: `ping` succeeds. `policyCheck getTabs '{}'` is allowed when setup installed the example policy.

Advanced setup:

```bash
./setup.sh --extension-id <id>
```

Use this for an already-packaged or future Web Store extension ID. It registers that packaged/store extension ID separately and does not generate or inject a local extension key for the developer-mode unpacked copy.

```bash
cargo build --release --manifest-path host-rs/Cargo.toml
./setup-rs.sh
```

Use this to register the Rust host with the same extension-ID resolution flow.

### Windows (Chrome or Edge)

Windows has no native-messaging manifest directory; Chrome and Edge read a registry key instead. `setup-windows.ps1` performs that registration for the current user only:

```powershell
powershell -ExecutionPolicy Bypass -File setup-windows.ps1
```

Parameters, all optional: `-RepoRoot <path>` (defaults to the script's directory), `-HostPort <port>` (default `9223`), `-ExtensionId <id>`, `-UseRustHost`, and `-Browser Chrome|Edge|Both` (default `Chrome`).

What it does:

1. Creates `bridge_token.txt`, `bridge_tokens.txt`, and `bridge_policy.json` (from `bridge_policy.example.json`) only when they are absent, and restricts each to the current user with `icacls`. Existing files are never overwritten, and no token value is printed.
2. Writes `bridge-host-launch.cmd`, a git-ignored launcher that exports `BRIDGE_PORT`, the token/policy paths, and the log paths, then runs `python.exe bridge.py` - or `host-rs\target\release\bridge-host.exe` with `-UseRustHost`. Windows native messaging launches the manifest `path` directly, so the interpreter has to live in a wrapper.
3. Writes `com.automation.bridge.json` with the resolved launcher path and `chrome-extension://<id>/` origin.
4. Sets the default value of `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.automation.bridge` (and the matching `HKCU:\Software\Microsoft\Edge\...` key for `-Browser Edge|Both`) to that manifest path.
5. Prints metadata only: manifest path, host name, host kind, port, extension ID, and next steps.

The extension ID resolves from `-ExtensionId`, then `extension_id.txt`, then an existing `extension_key.pem`. If none of those exist, load the unpacked extension from `chrome://extensions/` first and re-run with the ID Chrome assigned.

Windows notes: broker mode is macOS-only, so clients talk to the host directly on `BRIDGE_PORT`. Nothing is written to `HKLM` and no elevated shell is required; a machine-wide registration would let any account on the box drive your profile.

### Microsoft Edge (Chromium)

Edge is Chromium: same `chrome-extension://` origin scheme, same MV3 service worker, same extension bytes. Only the native-messaging host directory differs. Run `./setup.sh` first, then add the Edge registration:

```bash
./setup-edge.sh
```

`setup-edge.sh` creates no secrets. It reads the extension ID from `extension_id.txt` (or `--extension-id`), reads the host path from the generated `com.automation.bridge.json` (or `--host-path`), regenerates the Edge manifest into `dist/browsers/edge/`, and symlinks it into the Edge, Edge Beta, Edge Dev, and Edge Canary native-messaging directories on macOS, or Edge/Edge Beta/Edge Dev on Linux. Load the same unpacked extension directory from `edge://extensions/` and confirm the ID matches. On Windows use `setup-windows.ps1 -Browser Edge`.

Enable only one bridge extension across all installed browsers; they compete for the same host port.

### Firefox (generated artifacts, unsupported runtime)

Firefox artifacts are generated, not installed:

```bash
python3 scripts/generate_browser_manifests.py \
  --browser firefox \
  --host-path "$PWD/bridge.py" \
  --addon-id chrome-bridge@wolfie.gg \
  --out-dir dist/browsers
```

This writes `dist/browsers/firefox/com.automation.bridge.json` (a Firefox host manifest using `allowed_extensions` instead of `allowed_origins`) and `dist/browsers/firefox/extension/`, a staging directory holding `background.js`, `wake.html`, and `wake.js` byte-identical to the canonical root files plus a manifest that is the canonical manifest with only the Gecko differences applied:

- `browser_specific_settings.gecko.id` and `strict_min_version`;
- `background: {"scripts": ["background.js"]}` instead of a service worker;
- the Chrome-only permissions `debugger`, `tabGroups`, and `contentSettings` removed and reported as `droppedPermissions`.

The canonical Chrome `manifest.json` is untouched, and `dist/` is git-ignored. `--browser all` also emits the Edge manifest; `--browser edge` requires `--extension-id`. Output is deterministic: the same inputs produce the same digests. Nothing is registered and no secret is read.

Firefox limitations - these are why the runtime is not supported, not a to-do list:

- Firefox has no `chrome.debugger`/CDP API. Every debugger-backed action is unavailable: background-safe `screenshot`, `printToPDF`, `clickAt`, screencast recording, `executeScriptCDP`, performance metrics, network/CPU throttling, and emulation.
- Firefox has no `chrome.tabGroups`, so task sessions cannot create named tab groups.
- Firefox has no `chrome.contentSettings`, so permission and content-setting control is unavailable.
- Firefox MV3 runs an event page, not a service worker; the keepalive and heartbeat paths in `background.js` are tuned for Chrome's worker lifecycle.
- No live gate in this repository exercises Firefox. Treat the staged output as material for a future port, not as a working install.

### Packaged/store extension

Build the upload zip for the Chrome Web Store developer dashboard:

```bash
python3 scripts/package_extension_store.py --out dist/chrome-bridge-extension-store.zip
```

The script creates `dist/` when needed, packages only `manifest.json`, `background.js`, `wake.html`, and `wake.js`, validates the surface before writing, and prints metadata only: output path, sha256, byte count, and per-file list. Add `--check-js` to also run `node --check` on the packaged JavaScript; that gate is off by default so the script works without `node`. Nothing is uploaded and no Chrome Web Store API is contacted - upload the zip yourself through the developer dashboard.

Stable extension identity: the script never creates, reads, or packages `extension_key.pem`. A store listing gets a permanent item ID from the Chrome Web Store itself, and that is the ID to register:

```bash
./setup.sh --extension-id <store-id>
```

If you need a locally packed CRX with a stable ID instead, keep the private key outside the repository (never commit it) and pass it to Chrome's "Pack extension" flow; the repository stays key-free either way.

## Managed distribution: shipping one policy to a fleet

Chrome Bridge has no server, so an org baseline travels as a file plus a digest. The host applies the file only when the digest matches, which makes distribution channel-agnostic: MDM, config management, a signed package, or a shared read-only mount all work, because the lockfile - not the transport - is what authorizes the bundle.

On the admin's machine, author the baseline and pin it:

```bash
cp bridge_policy_bundle.example.json org-policy.json
# edit org-policy.json: default + clients layers, exactly like bridge_policy.json
chrome-bridge policy bundle lock org-policy.json --lockfile org-policy.lock
```

`policy bundle lock` writes the bundle's SHA-256 into the lockfile (mode `600`). Editing the bundle later changes its digest, so re-run the same command; it refuses to repin a lockfile that holds a different digest unless you pass `--force`, which keeps an accidental edit from silently becoming the new baseline. `bridge_policy_bundle.lock.example` ships a placeholder digest of all zeros that can never verify - a real digest must come from this command.

Ship both files to each machine (same directory, any path the host user can read), then point the machine's local policy at them:

```json
{
  "policyBundle": {
    "path": "/etc/chrome-bridge/org-policy.json",
    "lockfile": "/etc/chrome-bridge/org-policy.lock"
  }
}
```

Confirm on the machine:

```bash
chrome-bridge policy bundle verify /etc/chrome-bridge/org-policy.json \
  --lockfile /etc/chrome-bridge/org-policy.lock
chrome-bridge policy bundle show
```

`verify` exits `0` only on a match; `show` reports what the running host resolved (`path`, `verified`, and a 12-character digest) and exits `1` when the active bundle is unverified. If a machine reports `verified: false`, the host is serving the built-in fail-closed default policy - only `ping`, `policyCheck`, `policyInfo`, and lease actions - and `chrome-bridge audit tail` shows one `policy_bundle_rejected` entry with the expected and actual digests.

Two properties matter operationally. A machine's local `bridge_policy.json` still layers on top of the bundle, so a stricter machine can tighten the baseline without a separate bundle. And a bundle can never loosen a local deny list: composed `deniedActions`/`deniedOrigins` are the union of the bundle's and the machine's. To roll out a change, update the bundle, re-run `policy bundle lock`, and ship both files together - shipping a new bundle without its lockfile fails every machine closed rather than leaving the old policy in force. See docs/security.md for the full precedence and verification rules.

## Launchd broker mode

Broker mode is optional on macOS. launchd keeps a small Python broker listening on public port `9223`; Chrome-launched Python or Rust native hosts bind backend port `19223`. Clients keep using `BRIDGE_PORT=9223`, or no override. On first install, `setup-broker.sh` seeds the state-dir token from the repo token so the existing `chrome-bridge` CLI keeps working; if both token files already exist and differ, the script warns and clients should set `BRIDGE_TOKEN_FILE` to the state token path.

Install Python-host broker mode:

```bash
./setup-broker.sh --host python
```

Install Rust-host broker mode after building Rust:

```bash
cargo build --release --manifest-path host-rs/Cargo.toml
./setup-broker.sh --host rust
```

After setup completes, load the state-dir extension path printed by `setup-broker.sh` and disable any older bridge extension. Broker mode uses state under `~/Library/Application Support/chrome-native-bridge` by default, including its own extension key, extension ID, token, policy, and launcher. If you are migrating from a repo-local install, reload exactly the printed state-dir extension so the loaded extension ID matches the broker native-host registration.

Verify the broker process and public endpoint:

```bash
launchctl print gui/$UID/gg.wolfie.chrome-native-bridge.broker
chrome-bridge ping
```

Disable broker mode:

```bash
./uninstall-broker.sh
```

`extension_key.pem` is a private local identity key for the developer-mode unpacked extension. Keep it git-ignored and never commit it. A packaged or Web Store extension has a separate store-managed ID; register that ID with `./setup.sh --extension-id <store-id>`.

## Troubleshooting

The host writes a local `bridge_debug.log` (git-ignored) next to `bridge.py`:

```bash
tail -f bridge_debug.log
```

Run `python3 scripts/diagnose_install.py` for a read-only comparison of repository and deployed files plus broker/backend connection state. It never launches Chrome or opens a tab.

- `Connection refused` after retry in direct mode: Chrome is closed, no bridge extension is enabled, or the native connection is down. Routine retries never open Chrome or create a tab. Open Chrome normally, then inspect the extension service worker and `bridge_debug.log`.
- MCP says `server not connected` while `chrome-bridge ping` works: update to a build containing the packaged-startup path fix, then restart the MCP client once so it launches the corrected server. The MCP package now adds `BRIDGE_REPO_ROOT` before importing repo-local helpers and retries one safe pre-send connection failure automatically; a separate `PYTHONPATH` entry is no longer required.
- `Connection refused` in broker mode: launchd broker is not loaded. Run `launchctl print gui/$UID/gg.wolfie.chrome-native-bridge.broker`.
- `broker backend unavailable: native host did not start`: broker is up, but Chrome, the extension, or the native host did not connect within `BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS`. The broker returns `status: browser_unavailable` without opening Chrome. Reload the extension and check `broker_debug.log` plus `bridge_debug.log`.
- `FATAL: could not bind 127.0.0.1:9223`: two direct-mode bridge extensions are enabled, or direct mode is racing the broker.
- `unauthorized`: token mismatch, or the native-host manifest authorized the wrong extension ID. Re-run `./setup.sh`, reload the printed extension directory, and disable duplicate bridge extensions.
