#!/usr/bin/env python3
"""Fresh-profile live install smoke test for the Chrome native bridge."""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKIP_LINE = "SKIP live install smoke: Chrome/Chromium executable not found"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        return


def choose_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def run_setup(tmp, env, bridge_port):
    proc = subprocess.run(
        [
            "./setup.sh",
            "--ext",
            str(tmp / "extension"),
            "--state-dir",
            str(tmp / "state"),
            "--host-port",
            str(bridge_port),
            "--print-json",
        ],
        cwd=SCRIPT_DIR,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"setup.sh failed with {proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        raise AssertionError("setup.sh produced no stdout")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise AssertionError(f"setup.sh final stdout line is not JSON: {lines[-1]!r}") from exc








def chrome_for_testing_executables():
    if sys.platform != "darwin":
        return []
    names = ("Google Chrome for Testing",)
    roots = [
        Path.home() / "Library" / "Caches" / "ms-playwright",
        Path.home() / ".cache" / "puppeteer" / "chrome",
    ]
    candidates = []
    for root in roots:
        for name in names:
            candidates.extend(root.glob(f"**/{name}.app/Contents/MacOS/{name}"))
    return [str(path) for path in candidates if path.exists()]


def expected_manifest_paths(tmp):
    if sys.platform == "darwin":
        base = tmp / "home" / "Library" / "Application Support"
        cft_manifest = base / "ChromeForTesting" / "NativeMessagingHosts" / "com.automation.bridge.json"
        paths = {executable: cft_manifest for executable in chrome_for_testing_executables()}
        paths.update(
            {
                "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing": cft_manifest,
                "/Applications/Chromium.app/Contents/MacOS/Chromium": base / "Chromium" / "NativeMessagingHosts" / "com.automation.bridge.json",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome": base / "Google" / "Chrome" / "NativeMessagingHosts" / "com.automation.bridge.json",
            }
        )
        return paths
    if sys.platform.startswith("linux"):
        xdg = tmp / "xdg"
        return {
            "google-chrome": xdg / "google-chrome" / "NativeMessagingHosts" / "com.automation.bridge.json",
            "google-chrome-stable": xdg / "google-chrome" / "NativeMessagingHosts" / "com.automation.bridge.json",
            "google-chrome-beta": xdg / "google-chrome-beta" / "NativeMessagingHosts" / "com.automation.bridge.json",
            "chromium": xdg / "chromium" / "NativeMessagingHosts" / "com.automation.bridge.json",
            "chromium-browser": xdg / "chromium" / "NativeMessagingHosts" / "com.automation.bridge.json",
        }
    return {}


def setup_created_manifest_paths(tmp):
    if sys.platform == "darwin":
        base = tmp / "home" / "Library" / "Application Support"
        return [
            base / "Google" / "Chrome" / "NativeMessagingHosts" / "com.automation.bridge.json",
            base / "ChromeForTesting" / "NativeMessagingHosts" / "com.automation.bridge.json",
            base / "Google" / "ChromeForTesting" / "NativeMessagingHosts" / "com.automation.bridge.json",
            base / "Google" / "Chrome for Testing" / "NativeMessagingHosts" / "com.automation.bridge.json",
            base / "Google" / "Chrome Beta" / "NativeMessagingHosts" / "com.automation.bridge.json",
            base / "Google" / "Chrome Canary" / "NativeMessagingHosts" / "com.automation.bridge.json",
            base / "Chromium" / "NativeMessagingHosts" / "com.automation.bridge.json",
        ]
    if sys.platform.startswith("linux"):
        xdg = tmp / "xdg"
        return [
            xdg / "google-chrome" / "NativeMessagingHosts" / "com.automation.bridge.json",
            xdg / "google-chrome-beta" / "NativeMessagingHosts" / "com.automation.bridge.json",
            xdg / "chromium" / "NativeMessagingHosts" / "com.automation.bridge.json",
        ]
    return []


def assert_reported_paths(setup_json, bridge_port):
    expected_keys = [
        "extensionDir",
        "extensionId",
        "hostManifest",
        "policyFile",
        "tokenFile",
        "tokensFile",
        "launcher",
        # setup.sh and setup-rs.sh install the host outside the checkout and
        # report the installed copy here, in this position, so the strict
        # key-order check below has to include it.
        "nativeHost",
        "extensionIdFile",
        "hostPort",
    ]
    if list(setup_json.keys()) != expected_keys:
        raise AssertionError(f"setup JSON keys mismatch: {list(setup_json.keys())}")
    for key in expected_keys:
        if key == "extensionId":
            if not setup_json[key]:
                raise AssertionError("extensionId is empty")
            continue
        if key == "hostPort":
            if setup_json[key] != str(bridge_port):
                raise AssertionError(f"setup hostPort mismatch: {setup_json[key]!r} != {bridge_port!r}")
            continue
        path = Path(setup_json[key])
        if not path.exists():
            raise AssertionError(f"reported path does not exist for {key}: {path}")


def assert_manifest(path, launcher, extension_id):
    if not path.exists():
        raise AssertionError(f"expected native host manifest missing: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("path") != launcher:
        raise AssertionError(f"manifest {path} points at {data.get('path')!r}, expected {launcher!r}")
    origin = f"chrome-extension://{extension_id}/"
    if origin not in data.get("allowed_origins", []):
        raise AssertionError(f"manifest {path} missing allowed origin {origin}")


def install_profile_manifest(profile_dir, selected_manifest):
    target = profile_dir / "NativeMessagingHosts" / "com.automation.bridge.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(selected_manifest, target)
    return target








def find_browser(candidates):
    for candidate, manifest in candidates.items():
        if sys.platform == "darwin":
            if Path(candidate).exists():
                return candidate, manifest
        else:
            resolved = shutil.which(candidate)
            if resolved:
                return resolved, manifest
    return None, None







def start_fixture(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text("<!doctype html><title>Chrome Bridge Smoke</title><h1>ready</h1>", encoding="utf-8")
    server = ThreadingHTTPServer(("127.0.0.1", 0), lambda *args, **kwargs: QuietHandler(*args, directory=str(root), **kwargs))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/index.html"


def client_env(base_env, setup_json, bridge_port):
    env = base_env.copy()
    env.update(
        {
            "BRIDGE_TOKEN_FILE": setup_json["tokenFile"],
            "BRIDGE_PORT": str(bridge_port),
            "BRIDGE_CONNECT_TIMEOUT_SECONDS": "1",
        }
    )
    return env


def run_client(args, env):
    return subprocess.run(
        [sys.executable, "test_client.py", *args],
        cwd=SCRIPT_DIR,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def read_tail(path, limit=4000):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return "<missing>"
    return text[-limit:] if text else "<empty>"


def profile_has_extension(profile_dir, extension_id):
    prefs = profile_dir / "Default" / "Secure Preferences"
    if not prefs.exists():
        return False
    try:
        data = json.loads(prefs.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False
    settings = data.get("extensions", {}).get("settings", {})
    return extension_id in settings


def poll_ping(env, deadline, diagnostics):
    last = None
    while time.monotonic() < deadline:
        last = run_client(["ping"], env)
        if last.returncode == 0:
            return
        time.sleep(0.5)
    detail = "" if last is None else f"\nSTDOUT:\n{last.stdout}\nSTDERR:\n{last.stderr}"
    raise AssertionError(f"ping did not succeed within 20 seconds{detail}{diagnostics()}")


def assert_policy_allowed(env):
    proc = run_client(["policyCheck", "getTabs", "{}"], env)
    if proc.returncode != 0:
        raise AssertionError(f"policyCheck failed\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    response = json.loads(proc.stdout)
    result = response.get("result") if isinstance(response, dict) else None
    if not isinstance(result, dict) or result.get("allowed") is not True:
        raise AssertionError(f"policyCheck getTabs was not allowed: {proc.stdout}")












def terminate_browser(proc):
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def main():
    tmp_path = Path(tempfile.mkdtemp(prefix="chrome-bridge-live-install-"))
    browser = None
    fixture = None
    browser_stderr = None
    try:
        for name in ("home", "xdg", "state", "extension", "chrome-profile"):
            (tmp_path / name).mkdir(parents=True, exist_ok=True)
        bridge_port = choose_free_port()
        env = os.environ.copy()
        env.update({"HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "xdg")})
        setup_json = run_setup(tmp_path, env, bridge_port)
        assert_reported_paths(setup_json, bridge_port)
        for manifest_path in setup_created_manifest_paths(tmp_path):
            assert_manifest(manifest_path, setup_json["launcher"], setup_json["extensionId"])

        candidates = expected_manifest_paths(tmp_path)
        browser_path, selected_manifest = find_browser(candidates)
        if browser_path is None:
            print(SKIP_LINE)
            return 0
        if not selected_manifest.exists():
            print(f"ERROR: native host manifest missing for selected browser: {selected_manifest}", file=sys.stderr)
            return 1
        install_profile_manifest(tmp_path / "chrome-profile", selected_manifest)

        fixture, url = start_fixture(tmp_path / "fixture")
        browser_env = env.copy()
        browser_env["BRIDGE_PORT"] = str(bridge_port)
        stderr_path = tmp_path / "chrome-stderr.log"
        browser_stderr = stderr_path.open("w", encoding="utf-8")
        browser = subprocess.Popen(
            [
                browser_path,
                f"--user-data-dir={tmp_path / 'chrome-profile'}",
                f"--load-extension={tmp_path / 'extension'}",
                f"--disable-extensions-except={tmp_path / 'extension'}",
                "--no-first-run",
                "--no-default-browser-check",
                "--use-mock-keychain",
                url,
            ],
            cwd=SCRIPT_DIR,
            env=browser_env,
            stdout=subprocess.DEVNULL,
            stderr=browser_stderr,
        )

        def diagnostics():
            browser_stderr.flush()
            loaded = profile_has_extension(tmp_path / "chrome-profile", setup_json["extensionId"])
            exited = browser.poll()
            return (
                f"\nBROWSER: {browser_path}"
                f"\nBROWSER_EXIT_CODE: {exited}"
                f"\nEXTENSION_REGISTERED_IN_PROFILE: {loaded}"
                f"\nCHROME_STDERR_TAIL:\n{read_tail(stderr_path)}"
            )

        poll_ping(client_env(env, setup_json, bridge_port), time.monotonic() + 20, diagnostics)
        assert_policy_allowed(client_env(env, setup_json, bridge_port))
        print("Live install smoke OK")
        return 0
    finally:
        if browser is not None:
            terminate_browser(browser)
        if browser_stderr is not None:
            browser_stderr.close()
        if fixture is not None:
            fixture.shutdown()
            fixture.server_close()
        shutil.rmtree(tmp_path, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
