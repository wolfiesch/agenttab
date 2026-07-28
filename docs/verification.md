# Verification and release packaging

## Verification

Offline checks (no browser needed), run from the repo root:

```bash
PYTHONDONTWRITEBYTECODE=1 ./verify_cli_contract.py
PYTHONDONTWRITEBYTECODE=1 ./verify_heartbeat_contract.py
PYTHONDONTWRITEBYTECODE=1 ./verify_broker_contract.py
PYTHONDONTWRITEBYTECODE=1 ./verify_task_session_contract.py
PYTHONDONTWRITEBYTECODE=1 ./verify_quiet_debugger_contract.py
node verify_quiet_debugger_behavior.mjs
PYTHONDONTWRITEBYTECODE=1 ./verify_github_attachment_contract.py
PYTHONDONTWRITEBYTECODE=1 ./verify_bridge.py
PYTHONDONTWRITEBYTECODE=1 ./verify_mcp_contract.py
PYTHONDONTWRITEBYTECODE=1 ./verify_benchmark_harness.py
PYTHONDONTWRITEBYTECODE=1 ./verify_moat_contract.py
PYTHONDONTWRITEBYTECODE=1 ./verify_guardrails_contract.py
PYTHONDONTWRITEBYTECODE=1 ./verify_install_contract.py
python3 benchmark_harness.py run --adapter noop --iterations 2 --output /tmp/results.json
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile bridge.py broker.py bridge_wake.py test_client.py benchmark_harness.py extension_identity.py scripts/background_reliability.py scripts/generate_browser_manifests.py verify_bridge.py verify_cli_contract.py verify_broker_contract.py verify_github_attachment_contract.py verify_heartbeat_contract.py verify_task_session_contract.py verify_quiet_debugger_contract.py verify_benchmark_harness.py verify_install_contract.py verify_agent_actions_live.py verify_capability_matrix.py verify_mcp_contract.py
node --check background.js
node --check wake.js
diff -q manifest.json extension/manifest.json
diff -q background.js extension/background.js
diff -q wake.html extension/wake.html
diff -q wake.js extension/wake.js
```

Manual live gates after reloading the unpacked extension (opens real Chrome tabs):

```bash
python3 test_client.py ping
python3 scripts/background_reliability.py --duration-seconds 60 --output /tmp/background-reliability.json
PYTHONDONTWRITEBYTECODE=1 ./verify_live_install_smoke.py
PYTHONDONTWRITEBYTECODE=1 ./verify_agent_actions_live.py
PYTHONDONTWRITEBYTECODE=1 ./verify_capability_matrix.py
```

`verify_capability_matrix.py` skips `downloadUrl` by default in live profiles because Chrome's "Ask where to save each file before downloading" setting can open a modal save dialog and block unattended smoke runs. To exercise that capability intentionally, run:

```bash
CHROME_BRIDGE_TEST_DOWNLOAD=1 PYTHONDONTWRITEBYTECODE=1 ./verify_capability_matrix.py
```

`verify_live_install_smoke.py` uses a temporary HOME/XDG_CONFIG_HOME and exits 0 with `SKIP live install smoke: Chrome/Chromium executable not found` only when no Chrome/Chromium executable is available.

The default sample policy is intentionally fail-closed and denies loopback URLs. For these localhost live gates, temporarily use an explicit smoke-test policy, then restore your normal policy:

```json
{
  "default": {
    "allowedActions": ["*"],
    "allowedOrigins": ["http://127.0.0.1:*"],
    "deniedActions": [],
    "deniedOrigins": [],
    "requireConfirmation": [],
    "redact": true,
    "audit": true
  }
}
```

`verify_capability_matrix.py` binds its HTTP fixture to port `0`, derives the URL at runtime, writes screenshots/HTML/storage to temp files, and prints compact redacted JSON.

## Release packaging

Pull requests run `.github/workflows/ci.yml`. Tags that match `v*` run `.github/workflows/release.yml`.

The extension artifact is an unpacked, developer-mode bundle and remains unkeyed. A packaged or Web Store extension uses its own store-managed ID and must be registered separately:

```bash
./setup.sh --extension-id <store-id>
```

Build local release artifacts with:

```bash
python3 scripts/package_release.py --version <version> --dist dist
```

## Store package verification

`scripts/package_extension_store.py` builds the zip that is uploaded by hand to the Chrome Web Store developer dashboard. The script writes a local file and prints metadata; it performs no upload and makes no Chrome Web Store API call.

```bash
python3 scripts/package_extension_store.py --out dist/chrome-bridge-extension-store.zip
```

Optional JavaScript syntax gate, skipped by default and requiring `node` on `PATH`:

```bash
python3 scripts/package_extension_store.py --out dist/chrome-bridge-extension-store.zip --check-js
```

Before writing anything the script fails closed when:

- `extension/background.js` or `extension/manifest.json` exists and is not byte-identical to the canonical root file;
- `manifest_version` is not `3`, the service worker is not `background.js`, or `nativeMessaging` is missing;
- the packaged manifest drops any permission held by the canonical root `manifest.json`;
- the manifest carries a `key` field;
- `background.js` does not reference the `com.automation.bridge` native messaging host;
- any forbidden local artifact pattern (tokens, `bridge_policy.json`, `*.pem`, logs, caches, docs, tests) matches a member name.

The archive contains exactly `background.js`, `manifest.json`, `wake.html`, and `wake.js`, written in sorted order with a fixed timestamp, so repeated runs on unchanged inputs produce the same sha256. `verify_install_contract.py` covers this: it packages into a temp directory and asserts the exact member set, the absence of forbidden patterns, `manifest_version` 3, no `key`, root-permission coverage, the fixed timestamp, digest stability across two builds, and rejection of a staged manifest that drops root permissions.

`--source <dir>` packages a prepared staging directory instead of the repository root; the canonical root `manifest.json` is still the permission baseline.

## Cross-platform install verification

`setup-windows.ps1` needs Windows and a live browser, so `verify_install_contract.py` covers it statically instead of running it: the Chrome and Edge `HKCU` registry path strings are present, `HKLM:`/`HKEY_LOCAL_MACHINE` and any elevation request are absent, the `-RepoRoot`/`-HostPort`/`-ExtensionId`/`-UseRustHost` parameters exist, the Rust host path and the `.cmd` launcher are referenced, the launcher is git-ignored, secrets are kept rather than overwritten, the policy is seeded from `bridge_policy.example.json`, no output statement can print the token, and braces and parentheses balance.

`setup-edge.sh` is checked the same way: it references the macOS and Linux Edge native-messaging directories, builds its manifest through `scripts/generate_browser_manifests.py`, points Windows users at the PowerShell installer, and never creates or reads a token, key, or policy.

`scripts/generate_browser_manifests.py` is exercised for real in a temp directory with a fixture host path. The contract asserts the exact Edge and Firefox host-manifest objects, that the Firefox staging directory holds exactly `background.js`, `manifest.json`, `wake.html`, and `wake.js` with no forbidden artifact, that the three copied files are byte-identical to the canonical root files, that the staged manifest keeps `manifest_version` 3 and `nativeMessaging`, carries no `key`, uses `background: {"scripts": [...]}` plus the gecko id, and drops exactly `debugger`, `tabGroups`, and `contentSettings`, that the canonical Chrome manifest still declares its service worker, that a second run reproduces every digest, and that a missing or malformed extension ID, a malformed add-on ID, and a relative host path are all rejected.

No live Firefox or Edge gate exists. Edge shares Chrome's action surface, so the Chrome live gates cover it once registration succeeds; Firefox is generated output only.
