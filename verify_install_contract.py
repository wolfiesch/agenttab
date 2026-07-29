#!/usr/bin/env python3
"""Offline contract test for extension identity and install/deploy scripts."""
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import extension_identity

SCRIPT_DIR = Path(__file__).resolve().parent
failures = []


PACKAGE_RELEASE_SPEC = importlib.util.spec_from_file_location(
    "package_release", SCRIPT_DIR / "scripts" / "package_release.py"
)
if PACKAGE_RELEASE_SPEC is None or PACKAGE_RELEASE_SPEC.loader is None:
    raise RuntimeError("cannot load scripts/package_release.py")
package_release = importlib.util.module_from_spec(PACKAGE_RELEASE_SPEC)
PACKAGE_RELEASE_SPEC.loader.exec_module(package_release)

PACKAGE_STORE_SPEC = importlib.util.spec_from_file_location(
    "package_extension_store", SCRIPT_DIR / "scripts" / "package_extension_store.py"
)
if PACKAGE_STORE_SPEC is None or PACKAGE_STORE_SPEC.loader is None:
    raise RuntimeError("cannot load scripts/package_extension_store.py")
package_extension_store = importlib.util.module_from_spec(PACKAGE_STORE_SPEC)
PACKAGE_STORE_SPEC.loader.exec_module(package_extension_store)

BROWSER_MANIFEST_SPEC = importlib.util.spec_from_file_location(
    "generate_browser_manifests", SCRIPT_DIR / "scripts" / "generate_browser_manifests.py"
)
if BROWSER_MANIFEST_SPEC is None or BROWSER_MANIFEST_SPEC.loader is None:
    raise RuntimeError("cannot load scripts/generate_browser_manifests.py")
generate_browser_manifests = importlib.util.module_from_spec(BROWSER_MANIFEST_SPEC)
BROWSER_MANIFEST_SPEC.loader.exec_module(generate_browser_manifests)

def expect(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"FAIL: {msg}")


def run(cmd, **kwargs):
    return subprocess.run(cmd, cwd=SCRIPT_DIR, text=True, capture_output=True, **kwargs)


def last_json(stdout):
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            return json.loads(line)
    raise ValueError(f"no JSON object in output: {stdout!r}")


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def visible_names(path):
    return sorted(p.name for p in Path(path).iterdir() if not p.name.startswith("."))


def expect_zip_names(zip_path, expected, label):
    with zipfile.ZipFile(zip_path) as archive:
        names = sorted(archive.namelist())
    expect(names == sorted(expected), f"{label} mismatch: got {names}")


def expect_source_archive_omits_scratch_files(repo_root, dist, version):
    scratch_files = [
        "mcp/uv.lock",
        ".env",
        "bridge_token.txt",
        "bridge_tokens.txt",
        "bridge_tokens.txt.lock",
        "bridge_token_release-test.txt",
        ".bridge_tokens.release-test",
        "com.automation.bridge.json",
        "com.automation.bridge.rust.json",
        "bridge-host-launch.sh",
        "bridge-host-python-launch.sh",
        "bridge_policy.json",
        "extension_id.txt",
        "verify_release_scratch_contract.py",
        "verify_xchat_capture_contract.py",
    ]
    created = []
    try:
        for relative in scratch_files:
            path = repo_root / relative
            if path.exists():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("local scratch\n", encoding="utf-8")
            created.append(path)

        source_zip = package_release.add_source_zip(repo_root, dist, version)
        with zipfile.ZipFile(source_zip) as archive:
            source_names = set(archive.namelist())

        for relative in scratch_files:
            expect(relative not in source_names, f"source package should omit local scratch file {relative}")

        expected_tracked_public_files = [
            "bridge_policy.example.json",
            "bridge_policy_bundle.example.json",
            "bridge_policy_bundle.lock.example",
            "bridge_tokens.txt.example",
            "com.automation.bridge.json.template",
        ]
        for relative in expected_tracked_public_files:
            expect(relative in source_names, f"source package should keep tracked public template {relative}")
        expect_package_requires_git_checkout()
    finally:
        for path in reversed(created):
            path.unlink(missing_ok=True)


def expect_package_requires_git_checkout():
    with tempfile.TemporaryDirectory() as td:
        non_repo = Path(td) / "source"
        non_repo.mkdir()
        try:
            package_release.tracked_source_paths(non_repo)
        except SystemExit as exc:
            expect(exc.code == 2, f"non-git package error should exit 2, got {exc.code}")
        else:
            expect(False, "source packaging should fail clearly outside a git checkout")


def expect_store_package_contract(dist):
    out = dist / "chrome-bridge-extension-store.zip"
    metadata = package_extension_store.build_store_package(out)
    expect_zip_names(out, ["background.js", "manifest.json", "wake.html", "wake.js"],
                     "store package contents")
    expect(metadata["path"] == out.as_posix(), f"store metadata path mismatch: {metadata['path']}")
    expect(metadata["bytes"] == out.stat().st_size, "store metadata byte count should match the written zip")
    expect(len(metadata["sha256"]) == 64, "store metadata should carry a sha256 digest")
    expect(sorted(entry["name"] for entry in metadata["files"]) ==
           ["background.js", "manifest.json", "wake.html", "wake.js"],
           "store metadata file list mismatch")

    with zipfile.ZipFile(out) as archive:
        names = archive.namelist()
        manifest = json.loads(archive.read("manifest.json"))
        stamps = {info.date_time for info in archive.infolist()}
    expect(not package_extension_store.forbidden_matches(names),
           f"store package must not contain local artifacts: {names}")
    expect(manifest.get("manifest_version") == 3, "store manifest must be manifest_version 3")
    expect("key" not in manifest, "store manifest must not carry a local extension key")
    root_permissions = set(json.loads((SCRIPT_DIR / "manifest.json").read_text()).get("permissions", []))
    expect(root_permissions <= set(manifest.get("permissions", [])),
           "store manifest must keep every canonical root permission")
    expect(stamps == {package_extension_store.ZIP_TIMESTAMP},
           "store package entries should use the fixed deterministic timestamp")

    rebuilt = package_extension_store.build_store_package(dist / "store-rebuild.zip")
    expect(rebuilt["sha256"] == metadata["sha256"], "store package should be byte-deterministic")

    staging = dist / "staging"
    staging.mkdir()
    for name in package_extension_store.EXTENSION_FILES:
        shutil.copy2(SCRIPT_DIR / name, staging / name)
    bad_manifest = json.loads((staging / "manifest.json").read_text())
    bad_manifest["permissions"] = ["nativeMessaging"]
    (staging / "manifest.json").write_text(json.dumps(bad_manifest), encoding="utf-8")
    try:
        package_extension_store.build_store_package(dist / "store-bad.zip", source=staging)
    except package_extension_store.PackagingError:
        pass
    else:
        expect(False, "store packaging should reject a manifest missing root permissions")

    # A staged manifest carrying a private extension key must fail closed BEFORE
    # anything is written: the packager used to strip "key" silently, which
    # produced a clean-looking upload from a manifest that still had the local
    # unpacked-extension key on disk.
    keyed = dist / "staging-keyed"
    keyed.mkdir()
    for name in package_extension_store.EXTENSION_FILES:
        shutil.copy2(SCRIPT_DIR / name, keyed / name)
    keyed_manifest = json.loads((keyed / "manifest.json").read_text())
    keyed_manifest["key"] = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AFAKEKEYFORCONTRACT"
    (keyed / "manifest.json").write_text(json.dumps(keyed_manifest), encoding="utf-8")
    keyed_out = dist / "store-keyed.zip"
    try:
        package_extension_store.build_store_package(keyed_out, source=keyed)
    except package_extension_store.PackagingError as exc:
        expect("key" in str(exc),
               f"key rejection should name the offending field: {exc}")
    else:
        expect(False, "store packaging should reject a staged manifest carrying a 'key' field")
    expect(not keyed_out.exists(),
           "store packaging must write no archive when the staged manifest carries a 'key'")


def expect_windows_installer_contract():
    """Static shape checks for setup-windows.ps1; the script itself needs Windows."""
    script = SCRIPT_DIR / "setup-windows.ps1"
    expect(script.exists(), "setup-windows.ps1 should exist")
    if not script.exists():
        return
    text = script.read_text(encoding="utf-8")

    expect('$ChromeRegistryPath = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\$HostName"' in text,
           "setup-windows.ps1 should register the Chrome HKCU NativeMessagingHosts key")
    expect('$EdgeRegistryPath = "HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\$HostName"' in text,
           "setup-windows.ps1 should register the Edge HKCU NativeMessagingHosts key")
    expect("HKLM:" not in text and "HKEY_LOCAL_MACHINE" not in text,
           "setup-windows.ps1 must never write machine-wide HKLM registry keys")
    expect("RunAsAdministrator" not in text and "RunAs" not in text,
           "setup-windows.ps1 must not request elevation")

    # Chrome/Edge resolve the native host manifest through the registry key's
    # UNNAMED default value. `Set-ItemProperty -Name "(Default)"` writes a value
    # literally named "(Default)" instead, leaving the real default empty and the
    # host unregistered, so the old pattern is rejected outright.
    expect('-Name "(Default)"' not in text and "-Name '(Default)'" not in text,
           "setup-windows.ps1 must not write the manifest path with Set-ItemProperty -Name \"(Default)\"")
    expect("Set-Item -LiteralPath $registryPath -Value $manifestPath" in text,
           "setup-windows.ps1 should write the manifest path to the key's unnamed default value via Set-Item")
    expect("(Get-ItemProperty -LiteralPath $registryPath).'(default)'" in text,
           "setup-windows.ps1 should read back the default value it wrote")
    expect("throw \"Registry default value at $registryPath is" in text,
           "setup-windows.ps1 should fail loudly when the default value did not take")

    for param in ("[string] $RepoRoot", "[int] $HostPort", "[string] $ExtensionId", "[switch] $UseRustHost"):
        expect(param in text, f"setup-windows.ps1 should accept {param}")

    expect("bridge-host-launch.cmd" in text,
           "setup-windows.ps1 should write a .cmd launcher for the native host")
    expect("host-rs\\target\\release\\bridge-host.exe" in text,
           "setup-windows.ps1 -UseRustHost should point at the Rust host executable")
    expect('Write-Output "Existing $Label kept at $Path"' in text,
           "setup-windows.ps1 must keep existing secrets instead of overwriting them")
    expect("bridge_policy.example.json" in text,
           "setup-windows.ps1 should seed the policy from the tracked example")

    leaks = [line.strip() for line in text.splitlines()
             if "$token" in line and ("Write-Output" in line or "Write-Host" in line)]
    expect(not leaks, f"setup-windows.ps1 must never print the bridge token: {leaks}")
    expect(text.count("{") == text.count("}"),
           "setup-windows.ps1 braces should balance")
    expect(text.count("(") == text.count(")"),
           "setup-windows.ps1 parentheses should balance")

    ignored = (SCRIPT_DIR / ".gitignore").read_text(encoding="utf-8")
    expect("bridge-host-launch.cmd" in ignored,
           "the generated Windows launcher should be git-ignored")


def expect_edge_setup_contract():
    script = SCRIPT_DIR / "setup-edge.sh"
    expect(script.exists(), "setup-edge.sh should exist")
    if not script.exists():
        return
    text = script.read_text(encoding="utf-8")
    expect("Microsoft Edge/NativeMessagingHosts" in text,
           "setup-edge.sh should register under the macOS Edge native-messaging directory")
    expect("microsoft-edge/NativeMessagingHosts" in text,
           "setup-edge.sh should register under the Linux Edge native-messaging directory")
    expect("scripts/generate_browser_manifests.py" in text,
           "setup-edge.sh should build its manifest through the shared generator")
    expect("setup-windows.ps1 -Browser Edge" in text,
           "setup-edge.sh should point Windows users at the PowerShell installer")
    for secret in ("secrets.token_hex", "extension_key.pem", "bridge_token.txt"):
        expect(secret not in text,
               f"setup-edge.sh must not create or read {secret}; it only adds a registration")


def expect_browser_manifest_contract(tmp):
    gen = generate_browser_manifests
    host_path = "/tmp/fixture/bridge-host-launch.sh"
    extension_id = "abcdefghijklmnopabcdefghijklmnop"
    addon_id = gen.DEFAULT_FIREFOX_ADDON_ID
    out_dir = tmp / "browsers"

    metadata = gen.generate(out_dir, host_path, extension_id=extension_id)

    edge_manifest = json.loads((out_dir / "edge" / "com.automation.bridge.json").read_text())
    expect(edge_manifest == {
        "name": "com.automation.bridge",
        "description": "Chrome Native Messaging Automation Bridge",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }, f"edge host manifest mismatch: {edge_manifest}")

    firefox_manifest = json.loads((out_dir / "firefox" / "com.automation.bridge.json").read_text())
    expect(firefox_manifest == {
        "name": "com.automation.bridge",
        "description": "Chrome Native Messaging Automation Bridge",
        "path": host_path,
        "type": "stdio",
        "allowed_extensions": [addon_id],
    }, f"firefox host manifest mismatch: {firefox_manifest}")

    staging = out_dir / "firefox" / "extension"
    expect(visible_names(staging) == ["background.js", "manifest.json", "wake.html", "wake.js"],
           f"firefox staging dir contents mismatch: {visible_names(staging)}")
    expect(not package_extension_store.forbidden_matches(visible_names(staging)),
           "firefox staging dir must not contain local artifacts")
    for name in ("background.js", "wake.html", "wake.js"):
        expect((staging / name).read_bytes() == (SCRIPT_DIR / name).read_bytes(),
               f"firefox staging should copy {name} byte-identically from the canonical root")

    root_manifest = json.loads((SCRIPT_DIR / "manifest.json").read_text())
    staged = json.loads((staging / "manifest.json").read_text())
    expect(staged.get("manifest_version") == 3, "firefox staged manifest must stay manifest_version 3")
    expect("key" not in staged, "firefox staged manifest must not carry a local extension key")
    expect(staged.get("background") == {"scripts": ["background.js"]},
           f"firefox staged manifest must use an event page, got {staged.get('background')}")
    expect(staged.get("browser_specific_settings", {}).get("gecko", {}).get("id") == addon_id,
           "firefox staged manifest must carry the gecko add-on id")
    expected_permissions = [p for p in root_manifest["permissions"]
                            if p not in gen.FIREFOX_UNSUPPORTED_PERMISSIONS]
    expect(staged.get("permissions") == expected_permissions,
           f"firefox staged permissions mismatch: {staged.get('permissions')}")
    expect("nativeMessaging" in staged.get("permissions", []),
           "firefox staged manifest must keep nativeMessaging")
    expect(metadata["firefox"]["supported"] is False,
           "firefox metadata must state that the runtime is unsupported")
    expect(metadata["firefox"]["extension"]["droppedPermissions"] ==
           sorted(p for p in root_manifest["permissions"] if p in gen.FIREFOX_UNSUPPORTED_PERMISSIONS),
           "firefox metadata should report every dropped Chrome-only permission")
    expect(len(metadata["firefox"]["limitations"]) >= 3,
           "firefox metadata should name the runtime limitations")
    expect(root_manifest.get("background") == {"service_worker": "background.js"},
           "canonical Chrome manifest must keep its service worker unchanged")

    rebuilt = gen.generate(tmp / "browsers-rebuild", host_path, extension_id=extension_id)
    expect(rebuilt["edge"]["hostManifest"]["sha256"] == metadata["edge"]["hostManifest"]["sha256"],
           "edge manifest generation should be deterministic")
    expect([f["sha256"] for f in rebuilt["firefox"]["extension"]["files"]] ==
           [f["sha256"] for f in metadata["firefox"]["extension"]["files"]],
           "firefox staging generation should be deterministic")

    bad_inputs = (
        ({"browser": "edge"}, "edge without an extension id"),
        ({"browser": "edge", "extension_id": "nope"}, "an invalid extension id"),
        ({"browser": "firefox", "addon_id": "not-an-id"}, "an invalid add-on id"),
    )
    for kwargs, label in bad_inputs:
        try:
            gen.generate(tmp / "browsers-bad", host_path, **kwargs)
        except gen.GenerationError:
            pass
        else:
            expect(False, f"generator should reject {label}")
    try:
        gen.generate(tmp / "browsers-bad", "relative/bridge.py",
                     browser="edge", extension_id=extension_id)
    except gen.GenerationError:
        pass
    else:
        expect(False, "generator should reject a relative host path")



def expect_policy_bundle_examples():
    # The tracked org-bundle examples must parse and must be obviously inert:
    # a placeholder digest can never verify, so copying the pair verbatim fails
    # closed instead of silently pinning something real.
    bundle_path = SCRIPT_DIR / "bridge_policy_bundle.example.json"
    lock_path = SCRIPT_DIR / "bridge_policy_bundle.lock.example"
    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except Exception as exc:
        expect(False, f"example policy bundle should parse as JSON: {exc}")
        return
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except Exception as exc:
        expect(False, f"example bundle lockfile should parse as JSON: {exc}")
        return
    expect(isinstance(bundle.get("default"), dict) and isinstance(bundle.get("clients"), dict),
           "example policy bundle should carry the default and clients layers a host merges")
    expect("policyBundle" not in bundle,
           "a bundle must not name another bundle; policyBundle belongs in the local policy file")
    digest = lock.get("sha256")
    expect(isinstance(digest, str) and len(digest) == 64 and set(digest) <= set("0123456789abcdef"),
           f"example lockfile digest should be 64 lowercase hex characters, got {digest!r}")
    expect(isinstance(digest, str) and set(digest) == {"0"},
           f"example lockfile digest must be an obvious placeholder, got {digest!r}")
    actual = hashlib.sha256(bundle_path.read_bytes()).hexdigest()
    expect(digest != actual,
           "example lockfile must not pin the example bundle; a real digest comes from "
           "'chrome-bridge policy bundle lock'")
    note = " ".join(str(v) for v in (lock.get("_comment"), bundle.get("_comment")) if v)
    expect("policy bundle lock" in note,
           "the examples should say a real digest must come from the lock command")


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        key = tmp / "extension_key.pem"
        out_manifest = tmp / "manifest.json"

        r = run([sys.executable, "extension_identity.py", "ensure", "--key", str(key)])
        expect(r.returncode == 0, f"ensure failed: {r.stderr}")
        expect(key.exists(), "ensure should create key")
        if os.name == "posix":
            expect(mode(key) == 0o600, f"key mode should be 0600, got {oct(mode(key))}")

        r = run([sys.executable, "extension_identity.py", "write-manifest",
                 "--source", "manifest.json", "--output", str(out_manifest), "--key", str(key)])
        expect(r.returncode == 0, f"write-manifest failed: {r.stderr}")
        cli_id = r.stdout.strip()
        manifest = json.loads(out_manifest.read_text())
        root_manifest = json.loads((SCRIPT_DIR / "manifest.json").read_text())
        expect("key" in manifest, "keyed output manifest should include key")
        expect("storage" in manifest.get("permissions", []), "keyed manifest should keep storage permission")
        expect("key" not in root_manifest, "root manifest must remain unkeyed")
        der = base64.b64decode(manifest["key"])
        expect(extension_identity.extension_id_from_der(der) == cli_id,
               "CLI extension ID should match independently derived ID")

        ext_dir = tmp / "extension"
        r = run(["./deploy.sh", "--ext", str(ext_dir), "--with-local-key", "--key-file", str(key)])
        expect(r.returncode == 0, f"keyed deploy failed: {r.stderr}")
        expected_extension_names = [
            "background.js", "icons", "manifest.json", "popup.css", "popup.html", "popup.js", "wake.html", "wake.js",
        ]
        expect(visible_names(ext_dir) == expected_extension_names,
               f"extension deploy contents mismatch, got {visible_names(ext_dir)}")
        deployed = json.loads((ext_dir / "manifest.json").read_text())
        expect("key" in deployed, "keyed deploy manifest should include key")

        missing_mode_dir = tmp / "missing-mode-extension"
        r = run(["./deploy.sh", "--ext", str(missing_mode_dir)])
        expect(r.returncode != 0, "deploy without manifest mode should fail")
        expect("ERROR: choose exactly one extension manifest mode" in r.stderr,
               f"missing mode error mismatch: {r.stderr}")

        host_dir = tmp / "host"
        r = run(["./deploy.sh", "--host", str(host_dir), "--copy-policy", "--copy-token"])
        expect(r.returncode == 0, f"host deploy failed: {r.stderr}")
        expect((host_dir / "bridge_policy.json").exists(), "host policy should be copied")
        if os.name == "posix":
            expect(mode(host_dir / "bridge_policy.json") == 0o600,
                   f"host policy mode should be 0600, got {oct(mode(host_dir / 'bridge_policy.json'))}")
            if (SCRIPT_DIR / "bridge_token.txt").exists():
                expect(mode(host_dir / "bridge_token.txt") == 0o600,
                       f"host token mode should be 0600, got {oct(mode(host_dir / 'bridge_token.txt'))}")

        custom = {"default": {"allowedActions": ["ping"]}}
        policy_path = host_dir / "bridge_policy.json"
        policy_path.write_text(json.dumps(custom))
        try:
            os.chmod(policy_path, 0o644)
        except OSError:
            pass
        r = run(["./deploy.sh", "--host", str(host_dir), "--copy-policy"])
        expect(r.returncode == 0, f"host redeploy failed: {r.stderr}")
        expect(json.loads(policy_path.read_text()) == custom,
               "deploy --copy-policy must not overwrite an existing custom policy")
        if os.name == "posix":
            expect(mode(policy_path) == 0o600,
                   f"host redeploy should restrict existing broad policy to 0600, got {oct(mode(policy_path))}")

        install_env = os.environ.copy()
        install_env["HOME"] = str(tmp / "home")
        install_env["XDG_CONFIG_HOME"] = str(tmp / "xdg-config")
        state_dir = tmp / "state"
        r = run([
            "./setup.sh",
            "--state-dir", str(state_dir),
            "--ext", str(tmp / "extension"),
            "--host-port", "19223",
            "--print-json",
        ], env=install_env)
        expect(r.returncode == 0, f"setup state-dir failed: {r.stderr}")
        if r.returncode == 0:
            setup_info = last_json(r.stdout)
            launcher = Path(setup_info["launcher"])
            expect(launcher.exists(), "setup state-dir launcher should exist")
            expect('BRIDGE_PORT="${BRIDGE_PORT:-19223}"' in launcher.read_text(),
                   "setup state-dir launcher should use host port 19223")
            native_host = Path(setup_info["nativeHost"])
            expect(native_host == state_dir / "bridge.py",
                   "setup state-dir should install the Python runtime into durable state")
            expect(native_host.exists() and os.access(native_host, os.X_OK),
                   "setup state-dir native host should exist and be executable")
            expect(native_host.read_bytes() == (SCRIPT_DIR / "bridge.py").read_bytes(),
                   "installed Python native host should match repository source")
            expect(str(native_host) in launcher.read_text(),
                   "setup state-dir launcher should execute the durable native host")
            expect((state_dir / "extension_id.txt").exists(),
                   "setup state-dir should write extension_id.txt")
            expect(setup_info.get("extensionIdFile") == str(state_dir / "extension_id.txt"),
                   "setup JSON should include extensionIdFile")
            expect(setup_info.get("hostPort") == "19223",
                   "setup JSON should include hostPort 19223")

        store_extension_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        store_state_dir = tmp / "store-state"
        store_ext_dir = tmp / "store-extension"
        r = run([
            "./setup.sh",
            "--state-dir", str(store_state_dir),
            "--ext", str(store_ext_dir),
            "--extension-id", store_extension_id,
            "--host-port", "19223",
            "--print-json",
        ], env=install_env)
        expect(r.returncode == 0, f"setup provided extension-id failed: {r.stderr}")
        if r.returncode == 0:
            expect("Load unpacked:" not in r.stdout,
                   "setup with provided extension-id should not imply an unpacked extension was deployed")
            expect("Install or package the extension that owns this ID" in r.stdout,
                   "setup with provided extension-id should print packaged/store extension guidance")
            expect(not store_ext_dir.exists(),
                   "setup with provided extension-id should not deploy the extension directory")

        rust_state_dir = tmp / "state-rs"
        r = run([
            "./setup-rs.sh",
            "--state-dir", str(rust_state_dir),
            "--ext", str(tmp / "extension-rs"),
            "--host-port", "19223",
            "--print-json",
        ], env=install_env)
        if r.returncode == 0:
            setup_info = last_json(r.stdout)
            launcher = Path(setup_info["launcher"])
            expect(launcher.exists(), "setup-rs state-dir launcher should exist")
            expect('BRIDGE_PORT="${BRIDGE_PORT:-19223}"' in launcher.read_text(),
                   "setup-rs state-dir launcher should use host port 19223")
            native_host = Path(setup_info["nativeHost"])
            expect(native_host == rust_state_dir / "bridge-host",
                   "setup-rs state-dir should install the Rust runtime into durable state")
            expect(native_host.exists() and os.access(native_host, os.X_OK),
                   "setup-rs state-dir native host should exist and be executable")
            expect(str(native_host) in launcher.read_text(),
                   "setup-rs state-dir launcher should execute the durable native host")
            expect((rust_state_dir / "extension_id.txt").exists(),
                   "setup-rs state-dir should write extension_id.txt")
            expect(setup_info.get("extensionIdFile") == str(rust_state_dir / "extension_id.txt"),
                   "setup-rs JSON should include extensionIdFile")
            expect(setup_info.get("hostPort") == "19223",
                   "setup-rs JSON should include hostPort 19223")
        else:
            expect("Build the Rust host first" in (r.stdout + r.stderr),
                   f"setup-rs missing build-first message: stdout={r.stdout} stderr={r.stderr}")

        rust_store_state_dir = tmp / "store-state-rs"
        rust_store_ext_dir = tmp / "store-extension-rs"
        r = run([
            "./setup-rs.sh",
            "--state-dir", str(rust_store_state_dir),
            "--ext", str(rust_store_ext_dir),
            "--extension-id", store_extension_id,
            "--host-port", "19223",
            "--print-json",
        ], env=install_env)
        expect("Load unpacked:" not in r.stdout,
               "setup-rs with provided extension-id should not imply an unpacked extension was deployed")
        if r.returncode == 0:
            expect("Install or package the extension that owns this ID" in r.stdout,
                   "setup-rs with provided extension-id should print packaged/store extension guidance")
            expect(not rust_store_ext_dir.exists(),
                   "setup-rs with provided extension-id should not deploy the extension directory")

        broker_python_ok = run(["python3", "-c", "import plistlib"]).returncode == 0
        if sys.platform == "darwin" and broker_python_ok:
            broker_state_dir = tmp / "broker-state"
            broker_ext_dir = tmp / "broker-extension"
            r = run([
                "./setup-broker.sh",
                "--state-dir", str(broker_state_dir),
                "--ext", str(broker_ext_dir),
                "--backend-port", "19224",
                "--public-port", "9224",
                "--no-load",
                "--print-json",
            ], env=install_env)
            expect(r.returncode == 0, f"setup-broker --no-load failed: {r.stderr}")
            if r.returncode == 0:
                expect(f"Load unpacked: {broker_ext_dir}" in r.stdout,
                       "setup-broker success should print which extension directory to load")
                expect(f"BRIDGE_TOKEN_FILE={broker_state_dir / 'bridge_token.txt'}" in r.stdout,
                       "setup-broker success should print state-dir token advice")

        dist = tmp / "dist"
        dist.mkdir()
        backup = SCRIPT_DIR / "bridge_policy.json.bak-contract"
        try:
            backup.write_text('{"local": true}\n', encoding="utf-8")
            package_release.add_source_zip(SCRIPT_DIR, dist, "contract")
            package_release.add_extension_zip(SCRIPT_DIR, dist, "contract")
            expect_zip_names(
                dist / "chrome-native-bridge-extension-unpacked-contract.zip",
                [
                    "background.js",
                    "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png",
                    "manifest.json", "popup.css", "popup.html", "popup.js", "wake.html", "wake.js",
                ],
                "extension package contents",
            )
            with zipfile.ZipFile(dist / "chrome-native-bridge-source-contract.zip") as archive:
                source_names = set(archive.namelist())
            expect("bridge_policy.json.bak-contract" not in source_names,
                   "source package should exclude local policy backups")
            expect("bridge_policy.example.json" in source_names,
                   "source package should include example policy")
            expect_source_archive_omits_scratch_files(SCRIPT_DIR, dist, "scratch-contract")
            expect_store_package_contract(dist)
        finally:
            backup.unlink(missing_ok=True)

        expect_windows_installer_contract()
        expect_edge_setup_contract()
        expect_browser_manifest_contract(tmp)
        expect_policy_bundle_examples()
    if failures:
        print(f"\n{len(failures)} install contract failure(s).")
        return 1
    print("Install contract OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
