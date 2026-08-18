#!/usr/bin/env python3
import base64
import glob
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime
from bridge_wake import token_file_path

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))

# Mirrors the extension's accepted chrome.windows states for windowControl.
WINDOW_STATES = ("normal", "minimized", "maximized")


def load_token():
    token_file = token_file_path(SCRIPT_DIR)
    try:
        with open(token_file) as f:
            return f.read().strip()
    except Exception:
        return None


def parse_int(value, name):
    try:
        return int(value)
    except (TypeError, ValueError):
        print(f"Invalid {name}: {value}", file=sys.stderr)
        sys.exit(2)


def parse_float(value, name):
    try:
        return float(value)
    except (TypeError, ValueError):
        print(f"Invalid {name}: {value}", file=sys.stderr)
        sys.exit(2)


def parse_timeout(args, index, default=10000):
    if len(args) > index:
        return parse_int(args[index], "timeoutMs")
    return default


def expand_existing_files(paths):
    expanded = []
    for path in paths:
        abs_path = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(abs_path):
            print(f"Upload file not found: {abs_path}", file=sys.stderr)
            sys.exit(2)
        expanded.append(abs_path)
    return expanded


def expand_output_path(path):
    return os.path.abspath(os.path.expanduser(path))


def parse_observe_args(args):
    """Parse the small, intentionally dependency-free observe flag surface."""
    payload = {
        "tabId": parse_int(args[2], "tabId"),
        "compact": True,
    }
    explicit_limit = None
    index = 3
    roles = []
    while index < len(args):
        flag = args[index]
        if flag == "--full":
            payload["compact"] = False
            index += 1
            continue
        if flag == "--compact":
            payload["compact"] = True
            index += 1
            continue
        if flag == "--diff":
            payload["diff"] = True
            index += 1
            continue
        if flag in {"--role", "--name", "--limit"}:
            if index + 1 >= len(args):
                print(f"Missing value for {flag}", file=sys.stderr)
                sys.exit(2)
            value = args[index + 1]
            if flag == "--role":
                roles.extend(part.strip().lower() for part in value.split(",") if part.strip())
            elif flag == "--name":
                payload["name"] = value
            else:
                explicit_limit = parse_int(value, "limit")
            index += 2
            continue
        print(f"Unknown observe option: {flag}", file=sys.stderr)
        sys.exit(2)
    if roles:
        payload["roles"] = roles
    payload["limit"] = explicit_limit if explicit_limit is not None else (50 if payload["compact"] else 250)
    return payload




# Global ``--dry-run``: the host runs token, policy, lease, and confirmation
# checks for the request and reports the verdict without forwarding anything to
# Chrome. Set once in main() and applied to every request this process sends.
DRY_RUN = False

# Global ``--traceparent <value>``: a W3C trace-context header value naming the
# trace this run belongs to. The host continues that trace when its opt-in
# OpenTelemetry spans are enabled (BRIDGE_OTEL_ENABLED) and otherwise ignores
# it; either way the field is stripped host-side and never reaches Chrome.
TRACEPARENT = None


def env_float(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def response_timeout_seconds(read_timeout_ms=None):
    """Keep the wire read deadline beyond broker and extension deadlines."""
    broker_timeout = env_float("BRIDGE_BROKER_BACKEND_TIMEOUT_SECONDS", 10.0)
    configured = os.environ.get("BRIDGE_RESPONSE_TIMEOUT_SECONDS")
    if configured is None:
        timeout = max(15.0, broker_timeout + 5.0)
    else:
        timeout = env_float("BRIDGE_RESPONSE_TIMEOUT_SECONDS", max(15.0, broker_timeout + 5.0))
    if isinstance(read_timeout_ms, (int, float)) and read_timeout_ms > 0:
        timeout = max(timeout, read_timeout_ms / 1000 + 10.0)
    return timeout


def send_command_data(
        action, payload=None, read_timeout_ms=None, confirmation_token=None,
        dry_run=False, connect_timeout_seconds=None, response_timeout_seconds_override=None):
    if payload is None:
        payload = {}

    # Any action carrying a payload ``timeoutMs`` (waits, human handoff) may run
    # longer than the default 15s socket read; derive the read timeout from it
    # unless the caller passed one explicitly, mirroring the host-side per-request
    # timeout so no layer times out before the extension legitimately finishes.
    if read_timeout_ms is None and isinstance(payload, dict):
        pt = payload.get("timeoutMs")
        if isinstance(pt, (int, float)) and pt > 0:
            read_timeout_ms = pt

    token = load_token()
    if not token:
        return 2, None, "Error: could not read bridge token. Is bridge_token.txt present?"

    port = int(os.environ.get('BRIDGE_PORT', 9223))
    retry_seconds = (
        env_float('BRIDGE_CONNECT_TIMEOUT_SECONDS', 45.0)
        if connect_timeout_seconds is None
        else max(0.0, float(connect_timeout_seconds))
    )
    response_timeout = (
        response_timeout_seconds(read_timeout_ms)
        if response_timeout_seconds_override is None
        else max(0.1, float(response_timeout_seconds_override))
    )
    deadline = time.monotonic() + retry_seconds
    sock = None

    try:
        while True:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(min(15.0, max(0.1, response_timeout)))
                sock.connect(('127.0.0.1', port))
                # Use a post-connect deadline with headroom over both the broker's
                # backend wait and any extension-side action deadline.
                sock.settimeout(response_timeout)
                break
            except ConnectionRefusedError:
                try:
                    sock.close()
                except Exception:
                    pass
                if time.monotonic() >= deadline:
                    raise
                time.sleep(min(0.5, max(0.0, deadline - time.monotonic())))

        cmd = {
            "action": action,
            "payload": payload,
            "token": token
        }
        if DRY_RUN or dry_run:
            cmd["dryRun"] = True
        if TRACEPARENT:
            cmd["traceparent"] = TRACEPARENT
        if isinstance(confirmation_token, str) and confirmation_token:
            cmd["confirmationToken"] = confirmation_token
        sock.sendall((json.dumps(cmd) + "\n").encode('utf-8'))

        buffer = b""
        while b"\n" not in buffer:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buffer += chunk
        if buffer.strip():
            response = json.loads(buffer.split(b"\n", 1)[0].decode('utf-8'))
            exit_code = 0
            if response.get("success") is not True:
                exit_code = 1
            result = response.get("result")
            if isinstance(result, dict) and result.get("success") is False:
                exit_code = 1
            return exit_code, response, ""
        return 1, None, "Received empty response from bridge."
    except socket.timeout:
        return 124, None, (
            f"Error: timed out after {response_timeout:g}s waiting for a bridge response. "
            "The broker/native-host connection may be unavailable, or the extension "
            "may be stalled. Check bridge_debug.log and run chrome-bridge doctor."
        )
    except ConnectionRefusedError:
        return 111, None, (
            "Error: browser unavailable. Chrome may be closed, the extension may be disabled, "
            "or the native connection may be disconnected. No tab was opened automatically."
        )
    except Exception as e:
        return 1, None, f"Error communicating with bridge: {e}"
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


def send_command(action, payload=None, read_timeout_ms=None, confirmation_token=None):
    exit_code, response, stderr = send_command_data(action, payload, read_timeout_ms, confirmation_token)
    if response is not None:
        print(json.dumps(response, indent=2))
    if stderr:
        print(stderr, file=sys.stderr)
    return exit_code


def result_payload(response):
    if not response:
        return None
    result = response.get("result")
    return result if isinstance(result, dict) else response


# The extension returns resolved positions only, never script or source-map
# bodies. This scrub is a defensive backstop for --source-maps output so a
# future extension build can never dump a private codebase into the terminal.
SOURCE_TEXT_KEYS = {"sourcesContent", "scriptSource", "sourceText", "mappings", "sourceMap"}


def redact_source_text(value):
    if isinstance(value, dict):
        return {
            key: "[redacted]" if key in SOURCE_TEXT_KEYS else redact_source_text(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_source_text(item) for item in value]
    return value


def save_screenshot(tab_id, output_path, quiet=True):
    payload = {"tabId": tab_id, "format": "png", "quiet": quiet}
    exit_code, response, stderr = send_command_data("screenshot", payload)
    if exit_code != 0:
        if response is not None:
            print(json.dumps(response, indent=2))
        if stderr:
            print(stderr, file=sys.stderr)
        return exit_code
    result = result_payload(response)
    data_url = result.get("dataUrl", "") if result else ""
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        print("Error: screenshot response did not include PNG dataUrl", file=sys.stderr)
        return 1
    data = base64.b64decode(data_url[len(prefix):])
    path = expand_output_path(output_path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(json.dumps({"success": True, "path": path, "mimeType": "image/png", "bytes": len(data)}, indent=2))
    return 0


def save_pdf(tab_id, output_path, options=None):
    payload = {"tabId": tab_id}
    if options:
        payload.update(options)
    exit_code, response, stderr = send_command_data("printToPDF", payload)
    if exit_code != 0:
        if response is not None:
            print(json.dumps(response, indent=2))
        if stderr:
            print(stderr, file=sys.stderr)
        return exit_code
    result = result_payload(response)
    encoded = result.get("base64") if result else None
    if not isinstance(encoded, str) or not encoded:
        print("Error: printToPDF response did not include base64 PDF data", file=sys.stderr)
        return 1
    try:
        data = base64.b64decode(encoded)
    except Exception as exc:
        print(f"Error: printToPDF response was not valid base64: {exc}", file=sys.stderr)
        return 1
    path = expand_output_path(output_path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(json.dumps({"success": True, "path": path, "mimeType": "application/pdf", "bytes": len(data)}, indent=2))
    return 0


def save_html(tab_id, output_path):
    exit_code, response, stderr = send_command_data("getHTML", {"tabId": tab_id})
    if exit_code != 0:
        if response is not None:
            print(json.dumps(response, indent=2))
        if stderr:
            print(stderr, file=sys.stderr)
        return exit_code
    result = result_payload(response)
    html = result.get("html") if result else None
    if not isinstance(html, str):
        print("Error: getHTML response did not include html", file=sys.stderr)
        return 1
    encoded = html.encode("utf-8")
    path = expand_output_path(output_path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(encoded)
    print(json.dumps({"success": True, "path": path, "bytes": len(encoded)}, indent=2))
    return 0


# Artifacts a previous screencastSave (or its --mp4 step) wrote into the output
# directory. Only these names are ever removed: a caller may legitimately point
# two saves at one notes directory, and unrelated files there are not ours.
SCREENCAST_ARTIFACT_PATTERNS = ("frame-*.png", "frame-*.jpg", "frames.json", "frames.json.tmp", "screencast.mp4")


def prepare_screencast_dir(directory):
    """Create/validate the output directory and clear prior save artifacts.

    Runs BEFORE the frames are drained: draining consumes the extension's buffer
    irrecoverably, so a destination that cannot be written must fail while the
    frames are still in the service worker. Stale ``frame-*`` files from an
    earlier, longer save are removed so a second shorter save cannot present
    another recording's tail as part of this one.

    Returns the number of stale artifacts removed. Raises ``OSError`` when the
    destination cannot be prepared.
    """
    if os.path.exists(directory) and not os.path.isdir(directory):
        raise NotADirectoryError(f"{directory} exists and is not a directory")
    os.makedirs(directory, exist_ok=True)
    if not os.access(directory, os.W_OK):
        raise PermissionError(f"{directory} is not writable")
    removed = 0
    for pattern in SCREENCAST_ARTIFACT_PATTERNS:
        for path in glob.glob(os.path.join(glob.escape(directory), pattern)):
            if not os.path.isfile(path):
                continue
            os.unlink(path)
            removed += 1
    return removed


def save_screencast(tab_id, output_dir, fps=8, make_mp4=False):
    """Drain the extension's buffered screencast frames to local image files.

    Frame bytes are written to disk and never printed: stdout carries only the
    directory, counts, and byte totals so a recording of the real profile cannot
    leak into a transcript.
    """
    directory = expand_output_path(output_dir)
    try:
        stale_removed = prepare_screencast_dir(directory)
    except OSError as exc:
        print(f"Error: cannot prepare screencast output directory: {exc}", file=sys.stderr)
        return 1
    exit_code, response, stderr = send_command_data("screencastFrames", {"tabId": tab_id, "consume": True})
    if exit_code != 0:
        if response is not None:
            print(json.dumps(response, indent=2))
        if stderr:
            print(stderr, file=sys.stderr)
        return exit_code
    result = result_payload(response) or {}
    frames = result.get("frames")
    if not isinstance(frames, list):
        print("Error: screencastFrames response did not include a frames list", file=sys.stderr)
        return 1
    extension = "png" if result.get("format") == "png" else "jpg"
    total_bytes = 0
    timestamps = []
    written = 0
    for frame in frames:
        encoded = frame.get("base64") if isinstance(frame, dict) else None
        if not isinstance(encoded, str) or not encoded:
            continue
        try:
            data = base64.b64decode(encoded)
        except Exception:
            continue
        # Contiguous zero-padded numbering keeps the ffmpeg image sequence valid
        # even when a malformed frame is skipped.
        with open(os.path.join(directory, f"frame-{written:05d}.{extension}"), "wb") as f:
            f.write(data)
        total_bytes += len(data)
        timestamps.append(frame.get("timestamp"))
        written += 1
    manifest_path = os.path.join(directory, "frames.json")
    dropped = result.get("droppedFrames", 0)
    # Manifest last, written to a temp file and renamed, so a reader never sees a
    # frame count that does not match the files on disk.
    manifest_tmp = manifest_path + ".tmp"
    with open(manifest_tmp, "w") as f:
        json.dump({"count": written, "dropped": dropped, "timestamps": timestamps}, f)
    os.replace(manifest_tmp, manifest_path)
    summary = {
        "success": True,
        "dir": directory,
        "frames": written,
        "dropped": dropped,
        "bytes": total_bytes,
        "manifest": manifest_path,
        "staleArtifactsRemoved": stale_removed,
    }
    if make_mp4:
        summary.update(assemble_screencast_mp4(directory, extension, fps, written))
    print(json.dumps(summary, indent=2))
    return 0


def assemble_screencast_mp4(directory, extension, fps, frame_count):
    """Assemble frames into screencast.mp4 with the system ffmpeg, if present.

    ffmpeg is never bundled. When it is missing or fails, the frames stay on
    disk and the caller reports a note instead of failing the save.
    """
    if frame_count == 0:
        return {"mp4": None, "note": "No frames were buffered, so no mp4 was assembled."}
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"mp4": None, "note": "ffmpeg was not found on PATH; frames were kept and no mp4 was assembled."}
    mp4_path = os.path.join(directory, "screencast.mp4")
    proc = subprocess.run(
        [
            ffmpeg, "-y", "-framerate", str(fps),
            "-i", os.path.join(directory, f"frame-%05d.{extension}"),
            "-pix_fmt", "yuv420p", mp4_path,
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or not os.path.exists(mp4_path):
        # ffmpeg may leave a truncated container behind; do not present it as output.
        try:
            os.unlink(mp4_path)
        except OSError:
            pass
        return {"mp4": None, "note": f"ffmpeg exited {proc.returncode}; frames were kept."}
    return {"mp4": mp4_path, "mp4Bytes": os.path.getsize(mp4_path), "fps": fps}


def save_storage_state(tab_id, output_path):
    exit_code, response, stderr = send_command_data("storageState", {"tabId": tab_id})
    if exit_code != 0:
        if response is not None:
            print(json.dumps(response, indent=2))
        if stderr:
            print(stderr, file=sys.stderr)
        return exit_code
    result = result_payload(response)
    if not isinstance(result, dict):
        print("Error: storageState response was empty or invalid", file=sys.stderr)
        return 1
    encoded = json.dumps(result, indent=2).encode("utf-8")
    path = expand_output_path(output_path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(encoded)
    origin = result.get("origin")
    cookie_count = len(result.get("cookies", []))
    ls_origins = [origin] if (origin and result.get("localStorage")) else []
    ss_origins = [origin] if (origin and result.get("sessionStorage")) else []
    out = {
        "success": True,
        "path": path,
        "bytes": len(encoded),
        "cookieCount": cookie_count,
        "localStorageOrigins": ls_origins,
        "sessionStorageOrigins": ss_origins
    }
    print(json.dumps(out, indent=2))
    return 0


def load_schema_file(path):
    resolved = os.path.abspath(os.path.expanduser(path))
    try:
        with open(resolved) as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"Error: schema file not found: {resolved}", file=sys.stderr)
        sys.exit(2)
    except Exception as exc:
        print(f"Error: schema file at {resolved} is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(2)


def extract_structured(tab_id, schema, output_path=None, selector=None, max_chars=None):
    """Print or save schema-validated fields from a page.

    Only values the schema describes cross this boundary: the page text the
    extension read to find them is never returned. Structured output can still
    quote page content, so treat it as untrusted data, not instructions.
    """
    payload = {"tabId": tab_id, "schema": schema}
    if selector:
        payload["selector"] = selector
    if max_chars is not None:
        payload["maxChars"] = max_chars
    exit_code, response, stderr = send_command_data("extractStructured", payload)
    if exit_code != 0:
        if response is not None:
            print(json.dumps(response, indent=2))
        if stderr:
            print(stderr, file=sys.stderr)
        return exit_code
    result = result_payload(response)
    if not isinstance(result, dict) or "data" not in result:
        print("Error: extractStructured response did not include data", file=sys.stderr)
        return 1
    errors = result.get("errors") or []
    if not output_path:
        print(json.dumps({
            "success": True,
            "schemaVersion": result.get("schemaVersion"),
            "data": result.get("data"),
            "errors": errors,
        }, indent=2, ensure_ascii=False))
        return 0
    encoded = json.dumps(result.get("data"), indent=2, ensure_ascii=False).encode("utf-8")
    path = expand_output_path(output_path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(encoded)
    print(json.dumps({
        "success": True,
        "path": path,
        "bytes": len(encoded),
        "schemaVersion": result.get("schemaVersion"),
        "errors": errors,
    }, indent=2))
    return 0



def require_args(argv, count, usage):
    if len(argv) < count:
        print(usage, file=sys.stderr)
        sys.exit(1)

def _policy_paths():
    # Ask the host for the authoritative policy/audit file paths. The host is the
    # only component that knows BRIDGE_POLICY_FILE as the running host saw it, so
    # never assume a repo-local path here.
    exit_code, response, stderr = send_command_data("policyInfo")
    if exit_code != 0 or not response:
        print(stderr or "Error: could not reach host for policyInfo", file=sys.stderr)
        return None
    return result_payload(response)


def _load_policy_file(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception as exc:
        print(f"Error: policy file at {path} is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(1)


def _write_policy_file(path, policy):
    # Persist with mode 600: the policy governs which origins automation may
    # touch, so it must not be world-readable.
    encoded = json.dumps(policy, indent=2) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        if hasattr(os, "fchmod"):
            try:
                os.fchmod(fd, 0o600)
            except OSError:
                pass
        os.write(fd, encoded.encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
def _restrict_policy_file_perms(path):
    if not os.path.exists(path):
        return
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
def _policy_section(policy, client, explicit):
    # Return (container, key) for the list-bearing section governing ``client``.
    # An explicitly-named client always edits clients.<name> (created if absent)
    # so naming a new client never silently broadens the shared default policy.
    # The host-reported inherited client edits clients.<name> only when that
    # layer already exists, else default.
    if explicit and client:
        clients = policy.setdefault("clients", {})
        return clients, client
    if client and isinstance(policy.get("clients"), dict) and isinstance(policy["clients"].get(client), dict):
        return policy["clients"], client
    policy.setdefault("default", {})
    return policy, "default"


# Built-in fail-closed defaults, mirrored from the host (bridge.py DEFAULT_POLICY
# / host-rs default_policy). Used only to seed a newly-created list so an "allow"
# never silently drops inherited grants -- the host remains the source of truth.
_BUILTIN_DEFAULT_LISTS = {
    "allowedActions": ["ping", "policyCheck", "policyInfo", "lease", "release", "leaseStatus"],
    "deniedActions": [],
    "allowedOrigins": [],
    "deniedOrigins": [
        "file://*", "chrome://*", "chrome-extension://*",
        "*://localhost", "*://localhost:*",
        "*://127.0.0.1", "*://127.0.0.1:*",
        "*://0.0.0.0", "*://0.0.0.0:*",
        "*://*.local", "*://*.local:*",
        "*://[[]::1[]]", "*://[[]::1[]]:*",
    ],
    # Where the agent may make the browser SEND traffic. Empty (the built-in
    # default) means unconstrained.
    "egressAllowlist": [],
}


def _effective_inherited_list(policy, container, key, list_key):
    # The list the host would resolve for this section BEFORE our edit, following
    # its merge order: built-in default -> default.<list> -> clients.<name>.<list>.
    # Editing default inherits only the built-in; editing clients.<name> inherits
    # the default layer (its own list when present, else built-in).
    base = list(_BUILTIN_DEFAULT_LISTS.get(list_key, []))
    if key != "default":
        default_list = (policy.get("default") or {}).get(list_key)
        if isinstance(default_list, list):
            base = list(default_list)
    return base


def _policy_add_to_list(policy, client, list_key, value, explicit):
    container, key = _policy_section(policy, client, explicit)
    section = container.setdefault(key, {})
    if list_key not in section:
        # Seed a new list from the inherited effective list so appending one
        # grant does not replace (and thus revoke) everything inherited.
        section[list_key] = _effective_inherited_list(policy, container, key, list_key)
    lst = section[list_key]
    if value in lst:
        return False
    lst.append(value)
    return True


def _policy_remove_from_list(policy, client, list_key, value, explicit):
    # Mirror of _policy_add_to_list. A missing list is seeded from the inherited
    # effective list first, so clearing a pattern the default layer supplied
    # actually takes effect for a client layer instead of silently doing nothing.
    container, key = _policy_section(policy, client, explicit)
    section = container.setdefault(key, {})
    if list_key not in section:
        section[list_key] = _effective_inherited_list(policy, container, key, list_key)
    lst = section[list_key]
    if value not in lst:
        return False
    while value in lst:
        lst.remove(value)
    return True


# The host's accepted values for a siteModes entry, mirrored from bridge.py
# SITE_MODES / host-rs SITE_MODES. Validated locally so a typo is rejected here
# instead of being silently ignored by the host at evaluation time.
_SITE_MODES = ("manual", "auto", "skip")

# The host's DLP channels and modes, mirrored from bridge.py DLP_CHANNELS /
# DLP_MODES and host-rs DLP_CHANNELS / DLP_MODES. Validated locally so a typo is
# rejected here rather than resolving to the host's fail-closed ``block``.
_DLP_CHANNELS = ("clipboard", "upload", "download", "screenShare")
_DLP_MODES = ("allow", "audit", "block")


def _policy_set_dlp_mode(policy, client, channel, mode, explicit):
    # dlp is merged per channel by both hosts, so a client-layer entry never drops
    # the default layer's other channels and needs no inherited seeding.
    container, key = _policy_section(policy, client, explicit)
    section = container.setdefault(key, {})
    modes = section.get("dlp")
    if not isinstance(modes, dict):
        modes = {}
        section["dlp"] = modes
    if modes.get(channel) == mode:
        return False
    modes[channel] = mode
    return True


def _policy_set_site_mode(policy, client, pattern, mode, explicit):
    # siteModes is merged per key by both hosts, so a client-layer entry never
    # drops the default layer's other patterns and needs no inherited seeding.
    container, key = _policy_section(policy, client, explicit)
    section = container.setdefault(key, {})
    modes = section.get("siteModes")
    if not isinstance(modes, dict):
        modes = {}
        section["siteModes"] = modes
    if modes.get(pattern) == mode:
        return False
    modes[pattern] = mode
    return True


def _policy_clear_site_mode(policy, client, pattern, explicit):
    container, key = _policy_section(policy, client, explicit)
    section = container.setdefault(key, {})
    modes = section.get("siteModes")
    if not isinstance(modes, dict) or pattern not in modes:
        return False
    del modes[pattern]
    return True


# --- Content-addressed org policy bundles (host key ``policyBundle``) -------
# These subcommands hash a bundle and manage its lockfile. They print METADATA
# only -- path, digest, match -- never bundle contents, matching what the
# host's policyInfo discloses.

# Truncated digest length, mirroring bridge.py POLICY_BUNDLE_DIGEST_CHARS and
# host-rs POLICY_BUNDLE_DIGEST_CHARS.
POLICY_BUNDLE_DIGEST_CHARS = 12

POLICY_BUNDLE_USAGE = (
    "Usage: python3 test_client.py policy bundle "
    "<verify|lock|show> [<bundlePath> --lockfile <lockPath>] [--force]")


def _flag_value(args, flag):
    # (value, remaining). Returns (None, args) when the flag is absent.
    if flag not in args:
        return None, args
    index = args.index(flag)
    if index + 1 >= len(args):
        return None, args
    return args[index + 1], args[:index] + args[index + 2:]


def _bundle_digest(path):
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                digest.update(chunk)
    except OSError as exc:
        print(f"Error: cannot read policy bundle {path}: {exc}", file=sys.stderr)
        return None
    return digest.hexdigest()


def _read_bundle_lock(path):
    # (digest, status). status is "ok", "missing", or "malformed"; the host
    # treats anything but a 64-hex ``sha256`` string as malformed and fails
    # closed, so this mirrors that check instead of guessing.
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return None, "missing"
    except OSError:
        return None, "malformed"
    except Exception:
        return None, "malformed"
    if not isinstance(data, dict):
        return None, "malformed"
    digest = data.get("sha256")
    if not isinstance(digest, str):
        return None, "malformed"
    digest = digest.strip().lower()
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        return None, "malformed"
    return digest, "ok"


def _write_bundle_lock(path, bundle_path, digest):
    # Mode 600 like the policy file: the lockfile is what authorizes an org
    # baseline to take effect on this machine.
    encoded = json.dumps({
        "sha256": digest,
        "bundle": os.path.basename(bundle_path),
        "updated": datetime.now().astimezone().replace(microsecond=0).isoformat(),
    }, indent=2) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        if hasattr(os, "fchmod"):
            try:
                os.fchmod(fd, 0o600)
            except OSError:
                pass
        os.write(fd, encoded.encode("utf-8"))
    finally:
        os.close(fd)


def _cmd_policy_bundle(args):
    # verify/lock are local file operations and deliberately do NOT require a
    # running host: an admin locks a bundle before the host ever loads it.
    verb = args[3] if len(args) > 3 else ""
    rest = list(args[4:])
    force = "--force" in rest
    rest = [a for a in rest if a != "--force"]
    lockfile, rest = _flag_value(rest, "--lockfile")
    bundle_path = rest[0] if rest else ""
    if verb == "show":
        info = _policy_paths()
        if info is None:
            return 1
        bundle = info.get("policyBundle")
        if not bundle:
            print(json.dumps({
                "policyFile": info.get("policyFile"),
                "policyBundle": None,
                "note": "No policyBundle configured; the local policy file is the only source.",
            }, indent=2))
            return 0
        print(json.dumps({"policyFile": info.get("policyFile"),
                          "policyBundle": bundle}, indent=2))
        return 0 if bundle.get("verified") else 1
    if verb not in ("verify", "lock") or not bundle_path or not lockfile:
        print(POLICY_BUNDLE_USAGE, file=sys.stderr)
        return 2
    digest = _bundle_digest(bundle_path)
    if digest is None:
        return 1
    expected, status = _read_bundle_lock(lockfile)
    if verb == "verify":
        matched = status == "ok" and expected == digest
        exit_code = 0 if matched else 1
        print(json.dumps({
            "bundle": bundle_path,
            "lockfile": lockfile,
            "lockfileStatus": status,
            "digest": digest,
            "shortDigest": digest[:POLICY_BUNDLE_DIGEST_CHARS],
            "expected": expected,
            "match": matched,
            "exitCode": exit_code,
        }, indent=2))
        if not matched:
            print("Policy bundle does not match its lockfile; the host will "
                  "fail closed to the built-in default policy.", file=sys.stderr)
        return exit_code
    if status == "malformed" and not force:
        print(f"Error: lockfile {lockfile} is malformed; re-run with --force to "
              "overwrite it.", file=sys.stderr)
        return 1
    if status == "ok" and expected != digest and not force:
        print(f"Error: lockfile {lockfile} pins {expected[:POLICY_BUNDLE_DIGEST_CHARS]} "
              f"but {bundle_path} hashes to {digest[:POLICY_BUNDLE_DIGEST_CHARS]}; "
              "re-run with --force to repin.", file=sys.stderr)
        return 1
    _write_bundle_lock(lockfile, bundle_path, digest)
    print(json.dumps({
        "bundle": bundle_path,
        "lockfile": lockfile,
        "digest": digest,
        "shortDigest": digest[:POLICY_BUNDLE_DIGEST_CHARS],
        "changed": expected != digest,
        "forced": bool(force and status == "ok" and expected != digest),
    }, indent=2))
    return 0


def cmd_policy(args):
    sub = args[2] if len(args) > 2 else ""
    if sub == "info":
        return send_command("policyInfo")
    if sub == "bundle":
        # Handled before _policy_paths: verify/lock are offline file operations
        # an admin runs before (or without) a running host.
        return _cmd_policy_bundle(args)
    info = _policy_paths()
    if info is None:
        return 1
    policy_file = info.get("policyFile")
    audit_file = info.get("auditLogFile")
    client = info.get("client")
    if sub == "show":
        policy = _load_policy_file(policy_file)
        if policy is None:
            print(json.dumps({"policyFile": policy_file, "exists": False,
                              "note": "No policy file; built-in fail-closed default is active."}, indent=2))
            return 0
        print(json.dumps({"policyFile": policy_file, "exists": True, "policy": policy}, indent=2))
        return 0
    if sub == "doctor":
        return _policy_doctor(audit_file, policy_file)
    if sub == "allow-action":
        require_args(args, 4, "Usage: python3 test_client.py policy allow-action <action> [client]")
        explicit = len(args) > 4
        target_client = args[4] if explicit else client
        policy = _load_policy_file(policy_file) or {}
        changed = _policy_add_to_list(policy, target_client, "allowedActions", args[3], explicit)
        if changed:
            _write_policy_file(policy_file, policy)
        else:
            _restrict_policy_file_perms(policy_file)
        print(json.dumps({"success": True, "changed": changed, "action": args[3],
                          "policyFile": policy_file}, indent=2))
        return 0
    if sub == "allow-origin":
        require_args(args, 4, "Usage: python3 test_client.py policy allow-origin <pattern> [client]")
        explicit = len(args) > 4
        target_client = args[4] if explicit else client
        policy = _load_policy_file(policy_file) or {}
        changed = _policy_add_to_list(policy, target_client, "allowedOrigins", args[3], explicit)
        if changed:
            _write_policy_file(policy_file, policy)
        else:
            _restrict_policy_file_perms(policy_file)
        print(json.dumps({"success": True, "changed": changed, "origin": args[3],
                          "policyFile": policy_file}, indent=2))
        return 0
    if sub == "allow-egress":
        # Egress is CLI-managed only: MCP exposes no policy mutation.
        require_args(args, 4, "Usage: python3 test_client.py policy allow-egress <pattern> [client]")
        explicit = len(args) > 4
        target_client = args[4] if explicit else client
        policy = _load_policy_file(policy_file) or {}
        changed = _policy_add_to_list(policy, target_client, "egressAllowlist", args[3], explicit)
        if changed:
            _write_policy_file(policy_file, policy)
        else:
            _restrict_policy_file_perms(policy_file)
        print(json.dumps({"success": True, "changed": changed, "egress": args[3],
                          "policyFile": policy_file}, indent=2))
        return 0
    if sub == "clear-egress":
        require_args(args, 4, "Usage: python3 test_client.py policy clear-egress <pattern> [client]")
        explicit = len(args) > 4
        target_client = args[4] if explicit else client
        policy = _load_policy_file(policy_file) or {}
        changed = _policy_remove_from_list(policy, target_client, "egressAllowlist", args[3], explicit)
        if changed:
            _write_policy_file(policy_file, policy)
        else:
            _restrict_policy_file_perms(policy_file)
        print(json.dumps({"success": True, "changed": changed, "egress": args[3],
                          "policyFile": policy_file}, indent=2))
        return 0
    if sub == "site-mode":
        require_args(args, 5, "Usage: python3 test_client.py policy site-mode <originPattern> manual|auto|skip [client]")
        mode = args[4]
        if mode not in _SITE_MODES:
            print(f"Site mode must be one of {', '.join(_SITE_MODES)}", file=sys.stderr)
            return 2
        explicit = len(args) > 5
        target_client = args[5] if explicit else client
        policy = _load_policy_file(policy_file) or {}
        changed = _policy_set_site_mode(policy, target_client, args[3], mode, explicit)
        if changed:
            _write_policy_file(policy_file, policy)
        else:
            _restrict_policy_file_perms(policy_file)
        print(json.dumps({"success": True, "changed": changed, "origin": args[3],
                          "siteMode": mode, "policyFile": policy_file}, indent=2))
        return 0
    if sub == "clear-site-mode":
        require_args(args, 4, "Usage: python3 test_client.py policy clear-site-mode <originPattern> [client]")
        explicit = len(args) > 4
        target_client = args[4] if explicit else client
        policy = _load_policy_file(policy_file) or {}
        changed = _policy_clear_site_mode(policy, target_client, args[3], explicit)
        if changed:
            _write_policy_file(policy_file, policy)
        else:
            _restrict_policy_file_perms(policy_file)
        print(json.dumps({"success": True, "changed": changed, "origin": args[3],
                          "policyFile": policy_file}, indent=2))
        return 0
    if sub == "dlp":
        require_args(args, 5, "Usage: python3 test_client.py policy dlp <clipboard|upload|download|screenShare> allow|audit|block [client]")
        channel = args[3]
        mode = args[4]
        if channel not in _DLP_CHANNELS:
            print(f"DLP channel must be one of {', '.join(_DLP_CHANNELS)}", file=sys.stderr)
            return 2
        if mode not in _DLP_MODES:
            print(f"DLP mode must be one of {', '.join(_DLP_MODES)}", file=sys.stderr)
            return 2
        explicit = len(args) > 5
        target_client = args[5] if explicit else client
        policy = _load_policy_file(policy_file) or {}
        changed = _policy_set_dlp_mode(policy, target_client, channel, mode, explicit)
        if changed:
            _write_policy_file(policy_file, policy)
        else:
            _restrict_policy_file_perms(policy_file)
        out = {"success": True, "changed": changed, "channel": channel,
               "dlp": mode, "policyFile": policy_file}
        if channel == "clipboard":
            # Never let a policy edit imply coverage the bridge does not have.
            out["note"] = ("clipboard is a declared channel with no bridge chokepoint: no "
                           "bridge action reads or writes the clipboard and a page-driven copy "
                           "never crosses the bridge, so this mode records intent and "
                           "enforces nothing.")
        print(json.dumps(out, indent=2))
        return 0
    print("Usage: python3 test_client.py policy "
          "<info|show|doctor|bundle|allow-action|allow-origin|allow-egress|clear-egress|"
          "site-mode|clear-site-mode|dlp> ...", file=sys.stderr)
    return 64


_TASK_SESSION_CAPABILITY = (
    "createTaskSession",
    "navigateTaskSession",
    "getTaskSessions",
    "updateTaskSessionState",
    "closeTaskSession",
    "navigateAndSnapshot",
)
_KNOWN_POLICY_ACTION_RENAMES = {
    "taskSessionNavigate": "navigateTaskSession",
}


def _policy_configuration_issues(policy_file):
    policy = _load_policy_file(policy_file)
    if not isinstance(policy, dict):
        return []
    sections = [("default", policy.get("default"))]
    clients = policy.get("clients")
    if isinstance(clients, dict):
        sections.extend(
            (f"clients.{name}", layer) for name, layer in clients.items()
        )
    issues = []
    required = set(_TASK_SESSION_CAPABILITY)
    for section_name, layer in sections:
        if not isinstance(layer, dict):
            continue
        actions = layer.get("allowedActions")
        if not isinstance(actions, list):
            continue
        action_names = {action for action in actions if isinstance(action, str)}
        for action in sorted(action_names):
            replacement = _KNOWN_POLICY_ACTION_RENAMES.get(action)
            if replacement:
                issues.append({
                    "kind": "unknownAction",
                    "section": section_name,
                    "action": action,
                    "replacement": replacement,
                })
        present = required.intersection(action_names)
        missing = required.difference(action_names)
        if present and missing:
            issues.append({
                "kind": "incompleteCapability",
                "section": section_name,
                "capability": "taskSession",
                "present": sorted(present),
                "missing": sorted(missing),
                "remediation": (
                    "Grant the complete task-session capability so sessions can "
                    "be created, navigated, inspected, and closed safely."
                ),
            })
    return issues


def _policy_doctor(audit_file, policy_file):
    # Read recent deny entries from the audit log and propose the precise grant
    # for each distinct (action, target) so the user can self-service. Also
    # validate policy capability groups before reading runtime evidence, so a
    # stale allowlist is visible even when no denied request has reached Chrome.
    configuration_issues = _policy_configuration_issues(policy_file)
    denials = []
    try:
        with open(audit_file) as f:
            lines = f.readlines()
    except FileNotFoundError:
        print(json.dumps({
            "policyFile": policy_file,
            "auditLogFile": audit_file,
            "configurationIssues": configuration_issues,
            "denials": [],
            "note": "No audit log yet; policy configuration was still validated.",
        }, indent=2))
        return 0
    seen = set()
    for line in reversed(lines[-500:]):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("decision") != "deny":
            continue
        reason = ev.get("reason") or ""
        action = ev.get("action") or ""
        targets = ev.get("targets") or []
        # A denied batch step is audited as "batch step N: <inner reason>" with
        # the outer action "batch"; strip the wrapper so the inner reason gets the
        # same fix hint, and surface the step index. Mirrors host policy_denial.
        batch_step = None
        bm = re.match(r"^batch step (\d+): (.*)$", reason)
        if bm:
            batch_step = int(bm.group(1))
            reason = bm.group(2)
        key = (action, reason, tuple(targets), batch_step)
        if key in seen:
            continue
        seen.add(key)
        # Deny-lists win over allow-lists in the host, so the fix differs by the
        # gate that fired: "not allowed" means the item is missing from an allow
        # list (grant it); "denied" means a deny-list pattern matched (the user
        # must remove/narrow it -- a grant would not help).
        suggestion = None
        am = re.match(r"^action (\S+) (?:not allowed|denied)$", reason)
        if am and reason.endswith("not allowed"):
            suggestion = {"cli": f"policy allow-action {am.group(1)}"}
        elif am and reason.endswith("denied"):
            suggestion = {"manual": f"Remove or narrow the deniedActions pattern matching '{am.group(1)}' in {policy_file}"}
        elif reason == "target not allowed" and targets:
            suggestion = {"cli": f"policy allow-origin '{targets[0]}'"}
        elif reason == "target denied" and targets:
            suggestion = {"manual": f"Remove or narrow the deniedOrigins pattern matching '{targets[0]}' in {policy_file}"}
        elif reason == "egress not allowed" and targets:
            suggestion = {"cli": f"policy allow-egress '{targets[0]}'"}
        denials.append({"action": action, "reason": reason, "targets": targets,
                        "batchStep": batch_step, "suggestion": suggestion})
    print(json.dumps({"policyFile": policy_file, "auditLogFile": audit_file,
                      "configurationIssues": configuration_issues,
                      "denials": denials}, indent=2))
    return 0

# --- Scheduled workflows (local metadata only, no daemon) -------------------
#
# `schedule` registers a validated pointer to a workflow file plus a trigger. It
# starts nothing: this CLI has no daemon, no timer thread, and no wake-up path.
# Something external -- cron, launchd, systemd, a CI job, or a human -- must run
# `chrome-bridge workflow replay <path>` at the registered time, and the host
# policy in force at that moment is what actually authorizes each step.
SCHEDULE_FILE = os.environ.get(
    "BRIDGE_SCHEDULE_FILE", os.path.join(SCRIPT_DIR, "bridge_schedules.json"))
SCHEDULE_VERSION = 1


def _load_schedules():
    try:
        with open(SCHEDULE_FILE) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"version": SCHEDULE_VERSION, "schedules": []}
    except Exception as exc:
        print(f"Error: schedule file at {SCHEDULE_FILE} is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(data, dict) or not isinstance(data.get("schedules"), list):
        print(f"Error: schedule file at {SCHEDULE_FILE} is not a schedule registry", file=sys.stderr)
        sys.exit(1)
    data.setdefault("version", SCHEDULE_VERSION)
    return data


def _write_schedules(data):
    # Mode 600 like the policy file: the registry names local workflow paths and
    # the origins they are allowed to touch.
    encoded = json.dumps(data, indent=2) + "\n"
    fd = os.open(SCHEDULE_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        if hasattr(os, "fchmod"):
            try:
                os.fchmod(fd, 0o600)
            except OSError:
                pass
        os.write(fd, encoded.encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(SCHEDULE_FILE, 0o600)
    except OSError:
        pass


def _validate_workflow_file(path):
    # The ST3 workflow file contract:
    #   {version, name, steps: [{action, payload?, wait?}], policy: {requiredOrigins?}}
    # Returns (name, steps, requiredOrigins). Step payloads are validated for
    # shape and then never printed: a recorded step can carry typed text.
    try:
        with open(path) as f:
            workflow = json.load(f)
    except FileNotFoundError:
        print(f"Workflow file not found: {path}", file=sys.stderr)
        sys.exit(2)
    except Exception as exc:
        print(f"Error: workflow file at {path} is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(workflow, dict):
        print(f"Error: workflow file at {path} must be a JSON object", file=sys.stderr)
        sys.exit(2)
    if not isinstance(workflow.get("version"), int):
        print(f"Error: workflow file at {path} needs an integer 'version'", file=sys.stderr)
        sys.exit(2)
    name = workflow.get("name")
    if not isinstance(name, str) or not name.strip():
        print(f"Error: workflow file at {path} needs a non-empty 'name'", file=sys.stderr)
        sys.exit(2)
    steps = workflow.get("steps")
    if not isinstance(steps, list) or not steps:
        print(f"Error: workflow file at {path} needs a non-empty 'steps' array", file=sys.stderr)
        sys.exit(2)
    for index, step in enumerate(steps):
        if not isinstance(step, dict) or not isinstance(step.get("action"), str) or not step["action"]:
            print(f"Error: workflow step {index} needs a string 'action'", file=sys.stderr)
            sys.exit(2)
        if "payload" in step and not isinstance(step["payload"], dict):
            print(f"Error: workflow step {index} 'payload' must be an object", file=sys.stderr)
            sys.exit(2)
        if "wait" in step and not isinstance(step["wait"], (int, float)):
            print(f"Error: workflow step {index} 'wait' must be a number of milliseconds", file=sys.stderr)
            sys.exit(2)
    policy = workflow.get("policy")
    required = []
    if policy is not None:
        if not isinstance(policy, dict):
            print(f"Error: workflow file at {path} 'policy' must be an object", file=sys.stderr)
            sys.exit(2)
        raw = policy.get("requiredOrigins")
        if raw is not None:
            if not isinstance(raw, list) or not all(isinstance(o, str) and o for o in raw):
                print(f"Error: workflow 'policy.requiredOrigins' must be a list of origin strings",
                      file=sys.stderr)
                sys.exit(2)
            required = list(raw)
    return name.strip(), steps, required


def _parse_iso8601(value):
    # Accept a trailing "Z" on every supported Python version.
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        print(f"Invalid ISO 8601 timestamp: {value}", file=sys.stderr)
        sys.exit(2)


def cmd_schedule(args):
    sub = args[2] if len(args) > 2 else ""
    if sub == "list":
        data = _load_schedules()
        print(json.dumps({
            "scheduleFile": SCHEDULE_FILE,
            "runsUnattended": False,
            "note": "Metadata only. Nothing here runs until an OS scheduler or a human invokes runCommand.",
            "schedules": data.get("schedules", []),
        }, indent=2))
        return 0
    if sub == "remove":
        require_args(args, 4, "Usage: python3 test_client.py schedule remove <name>")
        name = args[3]
        data = _load_schedules()
        kept = [s for s in data["schedules"] if s.get("name") != name]
        removed = len(kept) != len(data["schedules"])
        if removed:
            data["schedules"] = kept
            _write_schedules(data)
        print(json.dumps({"success": True, "removed": removed, "name": name,
                          "scheduleFile": SCHEDULE_FILE}, indent=2))
        return 0
    if sub == "workflow":
        require_args(args, 4, "Usage: python3 test_client.py schedule workflow <workflowPath> "
                              "--at <ISO8601>|--interval <seconds> [--name <name>]")
        workflow_path = os.path.abspath(os.path.expanduser(args[3]))
        at = None
        interval = None
        name = None
        rest = args[4:]
        index = 0
        while index < len(rest):
            flag = rest[index]
            if flag not in {"--at", "--interval", "--name"}:
                print(f"Unknown schedule option: {flag}", file=sys.stderr)
                return 2
            if index + 1 >= len(rest):
                print(f"Missing value for {flag}", file=sys.stderr)
                return 2
            index += 1
            if flag == "--at":
                at = rest[index]
            elif flag == "--interval":
                interval = parse_int(rest[index], "interval")
            else:
                name = rest[index]
            index += 1
        if (at is None) == (interval is None):
            print("Give exactly one of --at <ISO8601> or --interval <seconds>", file=sys.stderr)
            return 2
        workflow_name, steps, required_origins = _validate_workflow_file(workflow_path)
        name = name or workflow_name
        if at is not None:
            trigger = {"kind": "at", "at": _parse_iso8601(at).isoformat()}
        else:
            if interval < 60:
                print("Interval must be at least 60 seconds", file=sys.stderr)
                return 2
            trigger = {"kind": "interval", "seconds": interval}
        data = _load_schedules()
        entry = {
            "name": name,
            "workflow": workflow_path,
            "trigger": trigger,
            "steps": len(steps),
            "requiredOrigins": required_origins,
            "registeredAt": datetime.now().astimezone().isoformat(),
            "runCommand": f"chrome-bridge workflow replay '{workflow_path}'",
        }
        data["schedules"] = [s for s in data["schedules"] if s.get("name") != name] + [entry]
        _write_schedules(data)
        print(json.dumps({
            "success": True,
            "scheduleFile": SCHEDULE_FILE,
            "runsUnattended": False,
            "note": "Registered metadata only. Chrome Bridge starts no daemon and no timer: "
                    "invoke runCommand from cron, launchd, systemd, or by hand. Every step is "
                    "still evaluated by host policy at run time, so grant the origins and set "
                    "siteModes before the first unattended run.",
            "schedule": entry,
        }, indent=2))
        return 0
    print("Usage: python3 test_client.py schedule <workflow|list|remove> ...", file=sys.stderr)
    return 64


def _resolve_audit_log_path():
    # Same resolution order as ``policy doctor``: the running host is the only
    # component that knows BRIDGE_AUDIT_LOG_FILE as it was actually configured.
    # When the host is unreachable, fall back to the repo-local default so the
    # log stays readable offline; callers report that fallback.
    exit_code, response, _stderr = send_command_data("policyInfo")
    if exit_code == 0 and response:
        info = result_payload(response)
        if isinstance(info, dict) and info.get("auditLogFile"):
            return info["auditLogFile"], False
    return os.path.join(SCRIPT_DIR, "bridge_audit.jsonl"), True


def _read_audit_entries(path):
    # Return (entries, malformed, error, missing). Malformed lines are counted
    # but never echoed: a truncated or corrupt line can hold arbitrary bytes.
    try:
        with open(path) as f:
            lines = f.readlines()
    except FileNotFoundError:
        return None, 0, f"No audit log at {path} yet; nothing to show.", True
    except OSError as exc:
        return None, 0, f"Error: could not read audit log at {path}: {exc}", False
    entries = []
    malformed = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            malformed += 1
            continue
        if not isinstance(event, dict):
            malformed += 1
            continue
        entries.append(event)
    return entries, malformed, None, False


def _load_audit_log():
    # Shared front door for the audit subcommands: resolve, read, and report
    # both the fallback path and a missing/unreadable log exactly once.
    path, fell_back = _resolve_audit_log_path()
    if fell_back:
        print(f"Note: host unreachable; falling back to local audit log {path}", file=sys.stderr)
    entries, malformed, error, missing = _read_audit_entries(path)
    if entries is None:
        if missing:
            print(error)
            return path, None, 0, 0
        print(error, file=sys.stderr)
        return path, None, 0, 1
    return path, entries, malformed, 0


def _audit_event_ms(event):
    ts = event.get("ts")
    if not isinstance(ts, (int, float)) or isinstance(ts, bool):
        return None
    return int(ts)


def _audit_local_time(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ms / 1000.0))


def _audit_timestamp(event):
    ms = _audit_event_ms(event)
    return "-" if ms is None else _audit_local_time(ms)


def _parse_since(value):
    # Accept a relative window (30m / 12h / 7d) or an ISO 8601 stamp. Naive ISO
    # stamps are read as local time, matching how timestamps are rendered.
    text = (value or "").strip()
    m = re.match(r"^(\d+)([mhd])$", text)
    if m:
        units = {"m": 60, "h": 3600, "d": 86400}
        return int((time.time() - int(m.group(1)) * units[m.group(2)]) * 1000)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        print(f"Error: --since expects ISO 8601 or a relative window like 7d/12h/30m, got: {value}",
              file=sys.stderr)
        sys.exit(2)
    return int(parsed.timestamp() * 1000)


def _audit_decision_bucket(decision):
    # The host writes a richer decision vocabulary than allow/deny/confirm
    # (lease_allow, extension_success, confirmation_required, ...). Fold it into
    # the three outcomes an operator cares about; anything unrecognized stays
    # "other" so a new host decision is never miscounted as an allow.
    text = str(decision or "").lower()
    if "deny" in text or "denied" in text:
        return "deny"
    if "confirmation_required" in text:
        return "confirm"
    if any(token in text for token in ("allow", "success", "accepted", "resume", "persisted")):
        return "allow"
    return "other"


def _print_audit_table(header, rows):
    widths = [max(len(row[i]) for row in [header] + rows) for i in range(len(header))]
    for row in [header] + rows:
        print("  ".join(value.ljust(widths[i]) for i, value in enumerate(row)).rstrip())


def _audit_tail(count):
    path, entries, malformed, exit_code = _load_audit_log()
    if entries is None:
        return exit_code
    if not entries:
        print(f"Audit log {path} has no entries yet.")
        if malformed:
            print(f"Skipped {malformed} malformed line(s).")
        return 0
    # Metadata columns only. The audit log never stores payload or response
    # bodies, and nothing here reconstructs them.
    rows = [(
        _audit_timestamp(event),
        str(event.get("client") or "-"),
        str(event.get("action") or "-"),
        str(event.get("decision") or "-"),
        str(event.get("reason") or ""),
        str(event.get("requestId") or "-"),
    ) for event in entries[-count:]]
    _print_audit_table(("TIMESTAMP", "CLIENT", "ACTION", "DECISION", "REASON", "REQUEST-ID"), rows)
    if malformed:
        print(f"Skipped {malformed} malformed line(s).")
    return 0


def _audit_summary(since_ms):
    path, entries, malformed, exit_code = _load_audit_log()
    if entries is None:
        return exit_code
    undated = 0
    if since_ms is not None:
        kept = []
        for event in entries:
            ms = _audit_event_ms(event)
            if ms is None:
                undated += 1
                continue
            if ms >= since_ms:
                kept.append(event)
        entries = kept
    if not entries:
        print(f"Audit log {path} has no entries in range.")
        if malformed:
            print(f"Skipped {malformed} malformed line(s).")
        return 0
    clients = Counter()
    actions = Counter()
    buckets = Counter()
    deny_reasons = Counter()
    stamps = []
    for event in entries:
        clients[str(event.get("client") or "-")] += 1
        actions[str(event.get("action") or "-")] += 1
        bucket = _audit_decision_bucket(event.get("decision"))
        buckets[bucket] += 1
        if bucket == "deny":
            deny_reasons[str(event.get("reason") or "(no reason recorded)")] += 1
        ms = _audit_event_ms(event)
        if ms is not None:
            stamps.append(ms)
    print(f"Audit log: {path}")
    if stamps:
        print(f"Range:     {_audit_local_time(min(stamps))} .. {_audit_local_time(max(stamps))}")
    else:
        print("Range:     (no timestamped entries)")
    print(f"Entries:   {len(entries)}")
    print("")
    print("Decisions:")
    _print_audit_table(("OUTCOME", "COUNT"),
                       [(name, str(buckets.get(name, 0))) for name in ("allow", "deny", "confirm", "other")])
    print("")
    print("Clients:")
    _print_audit_table(("CLIENT", "COUNT"), [(name, str(n)) for name, n in clients.most_common()])
    print("")
    print("Actions:")
    _print_audit_table(("ACTION", "COUNT"), [(name, str(n)) for name, n in actions.most_common()])
    if deny_reasons:
        print("")
        print("Top deny reasons:")
        _print_audit_table(("REASON", "COUNT"), [(name, str(n)) for name, n in deny_reasons.most_common(5)])
    if undated:
        print("")
        print(f"Excluded {undated} entry/entries without a usable timestamp from the --since window.")
    if malformed:
        print(f"Skipped {malformed} malformed line(s).")
    return 0


# --- One-shot audit export (chrome-bridge audit export) --------------------
#
# Backfill, or a way to prove a destination works before enabling ``auditExport``
# in policy. Independent of policy: it re-encodes lines the LOCAL audit log
# already holds, using the host's own encoders so a CLI line and a live
# forwarded line are the same bytes. Prints metadata only, never an exported
# line: the audit log holds no payloads, and nothing here reconstructs one.

AUDIT_EXPORT_USAGE = (
    "Usage: chrome-bridge audit export --format <jsonl|syslog|cef> "
    "--destination <path|udp://host:port|tcp://host:port|unix-socket-path> "
    "[--since <ISO8601|7d|12h>] [--limit N] [--dry-run]")


def _import_bridge():
    # The host owns the export encoders. The CLI must not carry a second copy
    # that could drift from what a SIEM actually receives.
    if SCRIPT_DIR not in sys.path:
        sys.path.insert(0, SCRIPT_DIR)
    import bridge
    return bridge


def _parse_audit_export_args(rest):
    # Returns (format, destination, since_ms, limit) or None on a usage error.
    fmt = destination = None
    since_ms = limit = None
    index = 0
    while index < len(rest):
        flag = rest[index]
        value = rest[index + 1] if index + 1 < len(rest) else None
        if flag not in ("--format", "--destination", "--since", "--limit"):
            print(f"Unknown option for audit export: {flag}", file=sys.stderr)
            return None
        if value is None:
            print(f"Error: {flag} expects a value", file=sys.stderr)
            return None
        if flag == "--format":
            fmt = value
        elif flag == "--destination":
            destination = value
        elif flag == "--since":
            since_ms = _parse_since(value)
        else:
            limit = parse_int(value, "limit")
            if limit <= 0:
                print("Error: --limit must be a positive integer", file=sys.stderr)
                return None
        index += 2
    return fmt, destination, since_ms, limit


def _audit_export(fmt, destination, since_ms, limit, dry_run):
    bridge = _import_bridge()
    if fmt not in bridge.AUDIT_EXPORT_FORMATS:
        print(f"Error: --format must be one of {', '.join(bridge.AUDIT_EXPORT_FORMATS)}",
              file=sys.stderr)
        return 64
    if not dry_run and not destination:
        print("Error: --destination is required unless --dry-run is set", file=sys.stderr)
        return 64
    path, entries, malformed, exit_code = _load_audit_log()
    if entries is None:
        return exit_code
    selected = []
    undated = 0
    for event in entries:
        if since_ms is not None:
            ms = _audit_event_ms(event)
            if ms is None:
                undated += 1
                continue
            if ms < since_ms:
                continue
        selected.append(event)
    if limit is not None and limit < len(selected):
        selected = selected[-limit:]
    lines = []
    unformattable = 0
    for event in selected:
        try:
            lines.append(bridge.format_audit_export_line(fmt, event))
        except Exception:
            unformattable += 1
    total_bytes = sum(len(line.encode("utf-8")) + 1 for line in lines)
    if not dry_run:
        # No rotation or retention on a backfill: the operator named this exact
        # destination, and silently renaming their file would be a surprise.
        config = {"format": fmt, "destination": destination,
                  "rotateBytes": None, "retainDays": None}
        try:
            for line in lines:
                bridge.audit_export_emit(config, line)
        except Exception as exc:
            print(f"Error: could not export to {destination}: {exc}", file=sys.stderr)
            return 1
    print(json.dumps({
        "auditLog": path,
        "format": fmt,
        "destination": destination or "-",
        "dryRun": dry_run,
        "eventsRead": len(entries),
        "eventsSelected": len(selected),
        "eventsExported": 0 if dry_run else len(lines),
        "bytes": total_bytes,
        "skippedMalformed": malformed,
        "skippedUnformattable": unformattable,
        "skippedUndated": undated,
    }, indent=2))
    return 0


def cmd_audit(args):
    sub = args[2] if len(args) > 2 else ""
    if sub == "tail":
        count = parse_int(args[3], "count") if len(args) > 3 else 20
        if count <= 0:
            print("Error: count must be a positive integer", file=sys.stderr)
            return 2
        return _audit_tail(count)
    if sub == "summary":
        since_ms = None
        if len(args) > 3:
            if args[3] != "--since" or len(args) < 5:
                print("Usage: python3 test_client.py audit summary [--since <ISO8601|7d|12h|30m>]",
                      file=sys.stderr)
                return 64
            since_ms = _parse_since(args[4])
        return _audit_summary(since_ms)
    if sub == "export":
        parsed = _parse_audit_export_args(args[3:])
        if parsed is None:
            print(AUDIT_EXPORT_USAGE, file=sys.stderr)
            return 64
        fmt, destination, since_ms, limit = parsed
        # --dry-run is the process-wide flag, already stripped from argv.
        if fmt is None:
            print(AUDIT_EXPORT_USAGE, file=sys.stderr)
            return 64
        return _audit_export(fmt, destination, since_ms, limit, DRY_RUN)
    print("Usage: python3 test_client.py audit <tail [count] "
          "| summary [--since <ISO8601|7d|12h|30m>] "
          "| export --format <jsonl|syslog|cef> --destination <dest>>",
          file=sys.stderr)
    return 64


# --- Session trace artifacts (host policy ``traceDir``) --------------------
#
# The host writes one JSONL event per trace-eligible request to
# <traceDir>/<traceId>.jsonl. Like the audit viewer, these readers print
# metadata columns and counts only: the artifacts hold no payload or response
# bodies, and nothing here reconstructs them.

DEFAULT_TRACE_DIRNAME = "bridge_traces"


def _resolve_trace_dir(explicit):
    # Same resolution order as the audit viewer: an explicit --trace-dir wins,
    # then the running host's configured traceDir, then the repo-local default
    # so an artifact stays readable when the host is down.
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit)), False
    exit_code, response, _stderr = send_command_data("policyInfo")
    if exit_code == 0 and response:
        info = result_payload(response)
        if isinstance(info, dict) and info.get("traceDir"):
            return info["traceDir"], False
    return os.path.join(SCRIPT_DIR, DEFAULT_TRACE_DIRNAME), True


def _sanitize_trace_id(trace_id):
    # Mirrors the host: file names keep only [A-Za-z0-9._-], capped at 80.
    safe = "".join(
        ch if (ch.isascii() and (ch.isalnum() or ch in "._-")) else "_"
        for ch in str(trace_id))
    return safe[:80] or "_"


def _load_trace(trace_id, trace_dir):
    # Return (path, events, malformed, exit_code). Malformed lines are counted,
    # never echoed.
    path = os.path.join(trace_dir, _sanitize_trace_id(trace_id) + ".jsonl")
    try:
        with open(path) as f:
            lines = f.readlines()
    except FileNotFoundError:
        print(f"No trace at {path} yet; nothing to show.")
        return path, None, 0, 0
    except OSError as exc:
        print(f"Error: could not read trace at {path}: {exc}", file=sys.stderr)
        return path, None, 0, 1
    events = []
    malformed = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            malformed += 1
            continue
        if not isinstance(event, dict):
            malformed += 1
            continue
        events.append(event)
    return path, events, malformed, 0


def _trace_tail(trace_id, count, trace_dir_arg):
    trace_dir, fell_back = _resolve_trace_dir(trace_dir_arg)
    if fell_back:
        print(f"Note: host unreachable; falling back to local trace directory {trace_dir}",
              file=sys.stderr)
    path, events, malformed, exit_code = _load_trace(trace_id, trace_dir)
    if events is None:
        return exit_code
    if not events:
        print(f"Trace {path} has no entries yet.")
        return 0
    rows = [(
        _audit_timestamp(event),
        str(event.get("action") or "-"),
        str(event.get("decision") or "-"),
        "yes" if event.get("success") else "no",
        str(event.get("durationMs") if event.get("durationMs") is not None else "-"),
        ",".join(str(t) for t in (event.get("targets") or [])) or "-",
        str(event.get("snapshotHash") or "-")[:12],
        str(event.get("responseHash") or "-")[:12],
    ) for event in events[-count:]]
    _print_audit_table(
        ("TIMESTAMP", "ACTION", "DECISION", "OK", "MS", "TABS", "SNAPSHOT", "RESPONSE"), rows)
    if malformed:
        print(f"Skipped {malformed} malformed line(s).")
    return 0


def _trace_summary(trace_id, trace_dir_arg):
    trace_dir, fell_back = _resolve_trace_dir(trace_dir_arg)
    if fell_back:
        print(f"Note: host unreachable; falling back to local trace directory {trace_dir}",
              file=sys.stderr)
    path, events, malformed, exit_code = _load_trace(trace_id, trace_dir)
    if events is None:
        return exit_code
    if not events:
        print(f"Trace {path} has no entries yet.")
        return 0
    actions = Counter()
    decisions = Counter()
    stamps = []
    durations = []
    successes = 0
    for event in events:
        actions[str(event.get("action") or "-")] += 1
        decisions[str(event.get("decision") or "-")] += 1
        if event.get("success"):
            successes += 1
        ms = _audit_event_ms(event)
        if ms is not None:
            stamps.append(ms)
        duration = event.get("durationMs")
        if isinstance(duration, (int, float)) and not isinstance(duration, bool):
            durations.append(int(duration))
    print(f"Trace:     {path}")
    print(f"Trace id:  {trace_id}")
    if stamps:
        print(f"Range:     {_audit_local_time(min(stamps))} .. {_audit_local_time(max(stamps))}")
    else:
        print("Range:     (no timestamped entries)")
    print(f"Events:    {len(events)} ({successes} succeeded)")
    if durations:
        print(f"Duration:  total {sum(durations)} ms, max {max(durations)} ms, "
              f"mean {sum(durations) // len(durations)} ms")
    print("")
    print("Actions:")
    _print_audit_table(("ACTION", "COUNT"), [(name, str(n)) for name, n in actions.most_common()])
    print("")
    print("Decisions:")
    _print_audit_table(("DECISION", "COUNT"), [(name, str(n)) for name, n in decisions.most_common()])
    if malformed:
        print(f"Skipped {malformed} malformed line(s).")
    return 0


def _trace_dir_flag(args):
    # Pull an optional trailing --trace-dir <path> out of the argument list.
    if "--trace-dir" not in args:
        return args, None
    index = args.index("--trace-dir")
    if index + 1 >= len(args):
        print("Error: --trace-dir expects a directory", file=sys.stderr)
        sys.exit(2)
    return args[:index] + args[index + 2:], args[index + 1]


TRACE_USAGE = ("Usage: python3 test_client.py trace "
               "<summary <traceId> | tail <traceId> [count]> [--trace-dir <dir>]")


def cmd_trace(args):
    args, trace_dir_arg = _trace_dir_flag(args)
    sub = args[2] if len(args) > 2 else ""
    trace_id = args[3] if len(args) > 3 else ""
    if sub not in ("summary", "tail") or not trace_id:
        print(TRACE_USAGE, file=sys.stderr)
        return 64
    if sub == "summary":
        return _trace_summary(trace_id, trace_dir_arg)
    count = parse_int(args[4], "count") if len(args) > 4 else 20
    if count <= 0:
        print("Error: count must be a positive integer", file=sys.stderr)
        return 2
    return _trace_tail(trace_id, count, trace_dir_arg)


# --- ST3/ST4: recorded workflows and the file-backed selector cache --------
#
# Both artifacts are local, git-ignored, and mode 600. Raw workflow JSON and
# resolved selector paths are written to files; stdout carries counts, paths,
# and byte totals only, matching the screenshot/PDF/storage-state pattern.

ACTION_CACHE_FILE = os.path.join(SCRIPT_DIR, "bridge_action_cache.json")
WORKFLOW_STASH_FILE = os.path.join(SCRIPT_DIR, "bridge_workflow_last.json")

WORKFLOW_USAGE = (
    "Usage: chrome-bridge workflow record start [--tab <tabId>] [--name <name>] [--record-sensitive]\n"
    "       chrome-bridge workflow record stop [--id <recordingId>] [--out <path>]\n"
    "       chrome-bridge workflow record save <path>\n"
    "       chrome-bridge workflow replay <path> [--tab <tabId>] [--binding key=value] [--continue-on-error]"
)

CACHE_USAGE = (
    "Usage: chrome-bridge cache selectors list [--sync]\n"
    "       chrome-bridge cache selectors clear [--local-only]\n"
    "       chrome-bridge cache selectors export <path>\n"
    "       chrome-bridge cache selectors import <path>"
)


def _read_json_file(path, default=None):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as exc:
        print(f"Error: could not read {path}: {exc}", file=sys.stderr)
        sys.exit(1)


def _write_json_file(path, data):
    # Mode 600: a workflow reproduces mutating actions and a selector cache maps
    # a site's DOM, so neither belongs in a world-readable file.
    encoded = json.dumps(data, indent=2) + "\n"
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(encoded)
        os.chmod(path, 0o600)
    except OSError as exc:
        print(f"Error: could not write {path}: {exc}", file=sys.stderr)
        sys.exit(1)
    return len(encoded.encode("utf-8"))


def _cache_entries():
    stored = _read_json_file(ACTION_CACHE_FILE, {"version": 1, "entries": []}) or {}
    entries = stored.get("entries")
    return entries if isinstance(entries, list) else []


# Mirrors the extension: only semantic selectors are cacheable, so a hand-edited
# cache file can never make a CSS selector resolve to a different element.
SEMANTIC_SELECTOR_PREFIXES = ("text=", "label=", "role=", "aria=")


def _valid_cache_entry(entry):
    return (
        isinstance(entry, dict)
        and isinstance(entry.get("urlPattern"), str) and entry["urlPattern"]
        and isinstance(entry.get("selector"), str) and entry["selector"]
        and entry["selector"].strip().startswith(SEMANTIC_SELECTOR_PREFIXES)
        and isinstance(entry.get("resolvedSelector"), str) and entry["resolvedSelector"]
    )


def _merge_cache_entries(existing, incoming):
    # Last write wins per (urlPattern, selector); order is preserved so the file
    # stays diffable across runs.
    merged = {}
    for entry in list(existing) + list(incoming):
        if not _valid_cache_entry(entry):
            continue
        merged[(entry["urlPattern"], entry["selector"])] = {
            "urlPattern": entry["urlPattern"],
            "selector": entry["selector"],
            "resolvedSelector": entry["resolvedSelector"],
            "lastSuccess": entry.get("lastSuccess") or 0,
        }
    return sorted(merged.values(), key=lambda item: (item["urlPattern"], item["selector"]))


def _save_cache_entries(entries):
    return _write_json_file(ACTION_CACHE_FILE, {"version": 1, "entries": entries})


def _parse_binding(argument):
    key, separator, value = argument.partition("=")
    if not separator or not key.strip():
        print(f"Error: --binding expects key=value, got {argument!r}", file=sys.stderr)
        sys.exit(2)
    return key.strip(), value


def _workflow_record_start(rest):
    payload = {}
    index = 0
    while index < len(rest):
        flag = rest[index]
        if flag == "--tab":
            index += 1
            if index >= len(rest):
                print("Missing value for --tab", file=sys.stderr)
                sys.exit(2)
            payload["tabId"] = parse_int(rest[index], "tabId")
        elif flag == "--name":
            index += 1
            if index >= len(rest):
                print("Missing value for --name", file=sys.stderr)
                sys.exit(2)
            payload["name"] = rest[index]
        elif flag == "--record-sensitive":
            payload["recordSensitive"] = True
        else:
            print(f"Unknown workflow record start option: {flag}", file=sys.stderr)
            sys.exit(2)
        index += 1
    return send_command("startWorkflowRecording", payload)


def _workflow_record_stop(rest):
    payload = {}
    out_path = None
    index = 0
    while index < len(rest):
        flag = rest[index]
        if flag in ("--id", "--out"):
            index += 1
            if index >= len(rest):
                print(f"Missing value for {flag}", file=sys.stderr)
                sys.exit(2)
            if flag == "--id":
                payload["recordingId"] = rest[index]
            else:
                out_path = expand_output_path(rest[index])
        else:
            print(f"Unknown workflow record stop option: {flag}", file=sys.stderr)
            sys.exit(2)
        index += 1
    exit_code, response, stderr = send_command_data("stopWorkflowRecording", payload)
    if stderr:
        print(stderr, file=sys.stderr)
    result = result_payload(response) or {}
    workflow = result.get("workflow") if isinstance(result, dict) else None
    if exit_code != 0 or not isinstance(workflow, dict):
        if response is not None:
            print(json.dumps(response, indent=2))
        return exit_code or 1
    stash_bytes = _write_json_file(WORKFLOW_STASH_FILE, workflow)
    summary = {
        "success": True,
        "recordingId": result.get("recordingId"),
        "name": result.get("name"),
        "tabId": result.get("tabId"),
        "stepCount": result.get("stepCount"),
        "redactedSteps": result.get("redactedSteps"),
        "requiresBindings": result.get("requiresBindings", []),
        "requiredOrigins": result.get("requiredOrigins", []),
        "durationMs": result.get("durationMs"),
        "truncated": result.get("truncated"),
        "stash": WORKFLOW_STASH_FILE,
        "stashBytes": stash_bytes,
    }
    if out_path:
        summary["path"] = out_path
        summary["bytes"] = _write_json_file(out_path, workflow)
    print(json.dumps(summary, indent=2))
    return 0


def _workflow_record_save(rest):
    if not rest:
        print(WORKFLOW_USAGE, file=sys.stderr)
        return 64
    workflow = _read_json_file(WORKFLOW_STASH_FILE)
    if not isinstance(workflow, dict):
        print(f"Error: no stopped recording stashed at {WORKFLOW_STASH_FILE}; run 'workflow record stop' first", file=sys.stderr)
        return 1
    out_path = expand_output_path(rest[0])
    written = _write_json_file(out_path, workflow)
    steps = workflow.get("steps") if isinstance(workflow.get("steps"), list) else []
    print(json.dumps({
        "success": True,
        "path": out_path,
        "bytes": written,
        "name": workflow.get("name"),
        "version": workflow.get("version"),
        "stepCount": len(steps),
        "redactedSteps": sum(1 for step in steps if isinstance(step, dict) and step.get("requiresValue")),
        "requiredOrigins": (workflow.get("policy") or {}).get("requiredOrigins", []),
    }, indent=2))
    return 0


def _workflow_replay(rest):
    if not rest:
        print(WORKFLOW_USAGE, file=sys.stderr)
        return 64
    workflow = _read_json_file(expand_output_path(rest[0]))
    if not isinstance(workflow, dict):
        print(f"Error: {rest[0]} is not a workflow object", file=sys.stderr)
        return 1
    payload = {"workflow": workflow, "cache": _cache_entries()}
    bindings = {}
    index = 1
    while index < len(rest):
        flag = rest[index]
        if flag == "--binding":
            index += 1
            if index >= len(rest):
                print("Missing value for --binding", file=sys.stderr)
                sys.exit(2)
            key, value = _parse_binding(rest[index])
            bindings[key] = value
        elif flag == "--tab":
            index += 1
            if index >= len(rest):
                print("Missing value for --tab", file=sys.stderr)
                sys.exit(2)
            payload["tabId"] = parse_int(rest[index], "tabId")
        elif flag == "--continue-on-error":
            payload["stopOnError"] = False
        else:
            print(f"Unknown workflow replay option: {flag}", file=sys.stderr)
            sys.exit(2)
        index += 1
    if bindings:
        payload["bindings"] = bindings
    exit_code, response, stderr = send_command_data("replayWorkflow", payload)
    if stderr:
        print(stderr, file=sys.stderr)
    result = result_payload(response)
    if isinstance(result, dict) and isinstance(result.get("cache"), list):
        # Resolved selector paths belong in the local cache file, not in stdout.
        entries = _merge_cache_entries(_cache_entries(), result.pop("cache"))
        _save_cache_entries(entries)
        result["cacheFile"] = ACTION_CACHE_FILE
        result["cacheEntries"] = len(entries)
    # T4-4 evidence: each step in the printed result carries `attempts`,
    # `retried`, and - when the step authored an `expect` clause - `expectPassed`
    # plus an `expect` block naming the mode and the failure reason. The
    # `retriedSteps` and `expectFailedSteps` totals summarize the same facts. All
    # of it is assertion metadata; no matched page content is ever included.
    if response is not None:
        print(json.dumps(response, indent=2))
    return exit_code


# --- T4-4: deterministic postconditions -------------------------------------
#
# The host answers one closed question and returns only mode, passed, attempts,
# elapsedMs, and a short reason, so nothing printed here can carry page text,
# matched content, or extracted values. The exit code is the point: 0 when the
# condition held, 1 when it did not, so a shell script or CI job can gate on a
# real browser postcondition with no model in the loop.
EXPECT_MODES = ("selector", "text", "url", "schema")


def cmd_expect(args):
    tab_id = parse_int(args[2], "tabId")
    mode = args[3]
    if mode not in EXPECT_MODES:
        print(f"Error: expect mode must be one of {', '.join(EXPECT_MODES)}", file=sys.stderr)
        return 2
    value = args[4]
    payload = {"tabId": tab_id, "mode": mode}
    if mode == "selector":
        payload["selector"] = value
    elif mode == "text":
        payload["text"] = value
    elif mode == "url":
        payload["urlSubstring"] = value
    else:
        schema = _read_json_file(expand_output_path(value))
        if not isinstance(schema, dict):
            print(f"Error: {value} is not a JSON Schema object", file=sys.stderr)
            return 2
        payload["schema"] = schema
    index = 5
    while index < len(args):
        flag = args[index]
        if flag == "--negate":
            payload["negate"] = True
        elif flag == "--timeout":
            index += 1
            if index >= len(args):
                print("Missing value for --timeout", file=sys.stderr)
                return 2
            payload["timeoutMs"] = parse_int(args[index], "timeoutMs")
        else:
            print(f"Unknown expect option: {flag}", file=sys.stderr)
            return 2
        index += 1
    exit_code, response, stderr = send_command_data("expect", payload)
    if stderr:
        print(stderr, file=sys.stderr)
    if response is not None:
        print(json.dumps(response, indent=2))
    if exit_code != 0:
        return exit_code
    # A well-formed assertion that did not hold is still a failing check.
    return 0 if (result_payload(response) or {}).get("passed") is True else 1


def cmd_workflow(args):
    sub = args[2] if len(args) > 2 else ""
    if sub == "record":
        operation = args[3] if len(args) > 3 else ""
        rest = list(args[4:])
        if operation == "start":
            return _workflow_record_start(rest)
        if operation == "stop":
            return _workflow_record_stop(rest)
        if operation == "save":
            return _workflow_record_save(rest)
        print(WORKFLOW_USAGE, file=sys.stderr)
        return 64
    if sub == "replay":
        return _workflow_replay(list(args[3:]))
    print(WORKFLOW_USAGE, file=sys.stderr)
    return 64


def _cache_selectors_list(rest):
    synced = 0
    if "--sync" in rest:
        exit_code, response, stderr = send_command_data("cacheSelectors", {"op": "list"})
        if exit_code != 0:
            if stderr:
                print(stderr, file=sys.stderr)
            print(f"Error: could not read the extension cache (exit {exit_code})", file=sys.stderr)
            return exit_code
        live = (result_payload(response) or {}).get("entries") or []
        entries = _merge_cache_entries(_cache_entries(), live)
        _save_cache_entries(entries)
        synced = len(live)
    else:
        entries = _cache_entries()
    by_pattern = {}
    for entry in entries:
        by_pattern[entry["urlPattern"]] = by_pattern.get(entry["urlPattern"], 0) + 1
    print(json.dumps({
        "success": True,
        "cacheFile": ACTION_CACHE_FILE,
        "entries": len(entries),
        "synced": synced,
        "urlPatterns": by_pattern,
        # Intent selectors and their age only; the resolved CSS paths stay in
        # the file and are readable through `cache selectors export`.
        "selectors": [
            {"urlPattern": entry["urlPattern"], "selector": entry["selector"], "lastSuccess": entry.get("lastSuccess") or 0}
            for entry in entries
        ],
    }, indent=2))
    return 0


def _cache_selectors_clear(rest):
    local_only = "--local-only" in rest
    cleared = len(_cache_entries())
    _save_cache_entries([])
    extension_cleared = None
    if not local_only:
        exit_code, response, _stderr = send_command_data("cacheSelectors", {"op": "clear"})
        extension_cleared = (result_payload(response) or {}).get("cleared") if exit_code == 0 else None
    print(json.dumps({
        "success": True,
        "cacheFile": ACTION_CACHE_FILE,
        "cleared": cleared,
        "extensionCleared": extension_cleared,
        "localOnly": local_only,
    }, indent=2))
    return 0


def _cache_selectors_export(rest):
    if not rest:
        print(CACHE_USAGE, file=sys.stderr)
        return 64
    entries = _cache_entries()
    out_path = expand_output_path(rest[0])
    written = _write_json_file(out_path, {"version": 1, "entries": entries})
    print(json.dumps({"success": True, "path": out_path, "bytes": written, "entries": len(entries)}, indent=2))
    return 0


def _cache_selectors_import(rest):
    if not rest:
        print(CACHE_USAGE, file=sys.stderr)
        return 64
    loaded = _read_json_file(expand_output_path(rest[0]))
    incoming = loaded.get("entries") if isinstance(loaded, dict) else loaded
    if not isinstance(incoming, list):
        print(f"Error: {rest[0]} has no entries array", file=sys.stderr)
        return 1
    accepted = [entry for entry in incoming if _valid_cache_entry(entry)]
    entries = _merge_cache_entries(_cache_entries(), accepted)
    _save_cache_entries(entries)
    exit_code, response, _stderr = send_command_data("cacheSelectors", {"op": "import", "entries": accepted})
    pushed = (result_payload(response) or {}).get("merged") if exit_code == 0 else None
    print(json.dumps({
        "success": True,
        "cacheFile": ACTION_CACHE_FILE,
        "read": len(incoming),
        "accepted": len(accepted),
        "rejected": len(incoming) - len(accepted),
        "entries": len(entries),
        "pushedToExtension": pushed,
    }, indent=2))
    return 0


def cmd_cache(args):
    if len(args) < 4 or args[2] != "selectors":
        print(CACHE_USAGE, file=sys.stderr)
        return 64
    operation = args[3]
    rest = list(args[4:])
    if operation == "list":
        return _cache_selectors_list(rest)
    if operation == "clear":
        return _cache_selectors_clear(rest)
    if operation == "export":
        return _cache_selectors_export(rest)
    if operation == "import":
        return _cache_selectors_import(rest)
    print(CACHE_USAGE, file=sys.stderr)
    return 64

def cmd_doctor():
    script = os.path.join(SCRIPT_DIR, "scripts", "diagnose_install.py")
    return subprocess.run([sys.executable, script], check=False).returncode


def bridge_readiness(timeout_ms=5000, poll_interval_ms=250):
    timeout_ms = max(0, min(30000, int(timeout_ms)))
    poll_interval_ms = max(50, min(1000, int(poll_interval_ms)))
    started = time.monotonic()
    deadline = started + timeout_ms / 1000.0
    attempts = 0
    endpoint_status = "refused"
    extension_status = "unavailable"
    reason = "browser unavailable"
    ready = False

    while True:
        attempts += 1
        remaining = max(0.1, deadline - time.monotonic())
        exit_code, response, stderr = send_command_data(
            "ping",
            connect_timeout_seconds=min(0.25, remaining),
            response_timeout_seconds_override=remaining,
        )
        if response is not None:
            endpoint_status = "reachable"
            if response.get("success") is True and response.get("result") == "pong":
                extension_status = "connected"
                reason = None
                ready = True
                break
            reason = response.get("error") or stderr or "bridge reported failure"
            if response.get("error") == "unauthorized":
                break
            if response.get("status") == "browser_unavailable":
                extension_status = "unavailable"
            else:
                extension_status = "stalled"
                break
        elif exit_code == 124:
            endpoint_status = "reachable"
            extension_status = "stalled"
            reason = stderr or "bridge response timed out"
            break
        else:
            endpoint_status = "refused"
            extension_status = "unavailable"
            reason = stderr or "browser unavailable"
        if time.monotonic() >= deadline:
            break
        time.sleep(min(poll_interval_ms / 1000.0, max(0.0, deadline - time.monotonic())))

    if ready:
        backend = "reachable"
    elif endpoint_status == "reachable" and extension_status == "unavailable":
        backend = "unavailable"
    else:
        backend = "unknown"
    return {
        "ready": ready,
        "endpoint": f"127.0.0.1:{int(os.environ.get('BRIDGE_PORT', 9223))}",
        "endpointStatus": endpoint_status,
        "backend": backend,
        "extension": extension_status,
        "attempts": attempts,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "reason": reason,
    }


def cmd_ready(args):
    timeout_ms = parse_int(args[2], "timeoutMs") if len(args) > 2 else 5000
    poll_interval_ms = parse_int(args[3], "pollIntervalMs") if len(args) > 3 else 250
    result = bridge_readiness(timeout_ms, poll_interval_ms)
    print(json.dumps(result, indent=2))
    return 0 if result["ready"] else 1


def cmd_navigate_and_snapshot(args):
    require_args(args, 3, "Usage: chrome-bridge navigateAndSnapshot <url> [options]")
    payload = {"url": args[2], "waitMode": "load", "compact": True, "limit": 50}
    rest = args[3:]
    index = 0
    while index < len(rest):
        flag = rest[index]
        if flag in {"--foreground", "--new", "--full", "--diff"}:
            if flag == "--foreground":
                payload["active"] = True
            elif flag == "--new":
                payload["reuse"] = False
            elif flag == "--full":
                payload["compact"] = False
            else:
                payload["diff"] = True
            index += 1
            continue
        if flag not in {
                "--session", "--wait", "--selector", "--url-substring",
                "--timeout", "--limit", "--role", "--name"}:
            print(f"Unknown navigateAndSnapshot option: {flag}", file=sys.stderr)
            return 2
        if index + 1 >= len(rest):
            print(f"Missing value for {flag}", file=sys.stderr)
            return 2
        value = rest[index + 1]
        if flag == "--session":
            payload["sessionId"] = value
        elif flag == "--wait":
            if value not in {"load", "url", "selector"}:
                print("--wait must be load, url, or selector", file=sys.stderr)
                return 2
            payload["waitMode"] = value
        elif flag == "--selector":
            payload["selector"] = value
        elif flag == "--url-substring":
            payload["urlSubstring"] = value
        elif flag == "--timeout":
            payload["timeoutMs"] = parse_int(value, "timeoutMs")
        elif flag == "--limit":
            payload["limit"] = parse_int(value, "limit")
        elif flag == "--role":
            payload["roles"] = [part.strip() for part in value.split(",") if part.strip()]
        else:
            payload["name"] = value
        index += 2
    if payload["waitMode"] == "selector" and not payload.get("selector"):
        print("--selector is required with --wait selector", file=sys.stderr)
        return 2
    if payload["waitMode"] == "url" and not payload.get("urlSubstring"):
        print("--url-substring is required with --wait url", file=sys.stderr)
        return 2
    return send_command("navigateAndSnapshot", payload, payload.get("timeoutMs"))


def cmd_insert_rich_text(args):
    require_args(
        args,
        5,
        "Usage: chrome-bridge insertRichText <tabId> <selector> <nodesJsonPath> [--append]",
    )
    with open(args[4], "r", encoding="utf-8") as handle:
        nodes = json.load(handle)
    if not isinstance(nodes, list) or not nodes:
        print("nodesJsonPath must contain a non-empty JSON array", file=sys.stderr)
        return 2
    unknown = [arg for arg in args[5:] if arg != "--append"]
    if unknown:
        print(f"Unknown insertRichText option: {unknown[0]}", file=sys.stderr)
        return 2
    return send_command("insertRichText", {
        "tabId": parse_int(args[2], "tabId"),
        "selector": args[3],
        "nodes": nodes,
        "clear": "--append" not in args[5:],
    })


def print_usage():
    print("Usage:")
    print("  chrome-bridge <command> [arguments]")
    print("  chrome-bridge help <command>")
    print("  chrome-bridge <command> --help")
    print("")
    print("Common commands:")
    print("  ping                              Check bridge health")
    print("  ready [timeoutMs] [pollMs]        Wait once for endpoint, backend, and extension readiness")
    print("  doctor                            Diagnose install drift and live bridge state")
    print("  getTabs                           List open tabs")
    print("  navigate <url> [--foreground]     Open a tab in the background by default")
    print("  navigateAndSnapshot <url> [...]   Navigate, wait, and return one accessibility snapshot")
    print("  observe <tabId> [filters]         Concise accessibility view with ref=eN ids; --full, --diff")
    print("  click <tabId> <selector>          Click by ref, CSS, text, ARIA name, label, or role")
    print("  fill <tabId> <selector> <text>    Clear and fill a form field")
    print("  insertRichText <tabId> <selector> <nodesJsonPath> [--append]")
    print("  screenshot <tabId> <path>         Save a background-safe screenshot")
    print("  github-attach-pr-body <tabId> <files...>")
    print("                                    Edit a GitHub PR body, attach files, and save")
    print("  confirm <token>                   Resume a confirmation-gated action")
    print("  taskSession <operation> ...       Manage task-owned background tabs")
    print("  policy <operation> ...            Inspect or update local policy")
    print("  workflow record|replay ...        Record dispatched bridge actions and replay them without a model")
    print("  cache selectors <operation> ...   Inspect the file-backed semantic-selector resolution cache")
    print("  schedule <operation> ...          Register local metadata for a workflow file (never runs it)")
    print("  audit <tail|summary> ...          Read the local audit log written by the host")
    print("  trace <summary|tail> <traceId>    Read a local session trace artifact written by the host")
    print("  searchTabs <query> [--regex]      Search visible text across all http/https tabs")
    print("")
    print("Global flags:")
    print("  --dry-run                         Report the host verdict without touching Chrome")
    print("  --traceparent <value>             W3C trace context this run continues (opt-in host spans)")
    print("")
    print("    selectors: CSS, ref=e<N> (from observe), css=<selector>, label=<text>, text=<text>,")
    print("               role=<role>[name=<text>], aria=<accessible-name>,")
    print("               <host> >>> <shadow-selector>, frame=<iframe-selector> >> <target-selector>")
    print("               refs are invalidated by navigation or an extension restart; stale refs fail with error staleRef")


COMMAND_HELP = {
    "doctor": (
        "chrome-bridge doctor",
        "Check the registered manifest, durable launcher and runtime, deployed extension, "
        "last successful response, and broker/native-backend connection state without exposing secrets.",
    ),
    "ready": (
        "chrome-bridge ready [timeoutMs] [pollIntervalMs]",
        "Wait once for the bridge endpoint, native backend, and extension, then print one bounded status object.",
    ),
    "navigateAndSnapshot": (
        "chrome-bridge navigateAndSnapshot <url> [--session <id>] [--wait load|url|selector] "
        "[--selector <selector>] [--url-substring <text>] [--timeout <ms>] [--foreground] "
        "[--new] [--full] [--diff] [--limit <count>] [--role <roles>] [--name <text>]",
        "Navigate or reuse a task-session tab, wait deterministically, and return a compact accessibility snapshot in one request.",
    ),
    "insertRichText": (
        "chrome-bridge insertRichText <tabId> <selector> <nodesJsonPath> [--append]",
        "Insert a constrained JSON rich-text node tree into a contenteditable editor without arbitrary page script execution.",
    ),
    "observe": (
        "chrome-bridge observe <tabId> [--compact|--full] [--diff] [--role <role[,role...]>] [--name <text>] [--limit <count>]",
        "Print a compact accessibility view by default. Filters are applied before the limit. "
        "Every node carries a stable ref such as e12; pass that ref to any selector argument as ref=e12. "
        "Refs are invalidated by navigation and by an extension service-worker restart, and a stale ref fails with error staleRef. "
        "--diff returns added/removed/changed against the previous snapshot for this tab, with baseEpoch and epoch; "
        "the first --diff call after a navigation returns the full snapshot with diffBase true.",
    ),
    "click": (
        "chrome-bridge click <tabId> <selector>",
        "Click using CSS or a semantic selector such as ref=e12, text=Save, aria=More options, label=Email, or role=button[name=Save].",
    ),
    "executeScript": (
        "chrome-bridge executeScript <tabId> <code>",
        "Run page JavaScript. If policy requires confirmation, resume with: chrome-bridge confirm <token>",
    ),
    "executeScriptCDP": (
        "chrome-bridge executeScriptCDP <tabId> <code>",
        "Run JavaScript through Chrome DevTools. If policy requires confirmation, resume with: chrome-bridge confirm <token>",
    ),
    "confirm": (
        "chrome-bridge confirm <confirmationToken>",
        "Resume the exact action and payload stored by the host. Tokens are one-use and expire after 60 seconds by default.",
    ),
    "github-attach-pr-body": (
        "chrome-bridge github-attach-pr-body <tabId> <file...> [--timeout <milliseconds>]",
        "On a GitHub pull-request page, open the body editor, attach the files, wait for GitHub CDN links, and save without replacing existing text.",
    ),
    "credentialHandoff": (
        "chrome-bridge credentialHandoff <tabId> <selector> [message] [--mode filled|submitted] [--timeout <milliseconds>]",
        "Hand one field to the human so a password, passphrase, or one-time code is typed straight into the page. The bridge focuses the field and waits; it never reads or returns the value, and the host blacks out every observation action for the tab until the window closes.",
    ),
    "taskSession": (
        "chrome-bridge taskSession create|navigate|show|state|close ...",
        "Create and manage tabs owned by one task. Set state to working, needs_user, or completed.",
    ),
    "policy": (
        "chrome-bridge policy info|show|doctor|bundle|allow-action|allow-origin|allow-egress|clear-egress|site-mode|clear-site-mode|dlp ...",
        "Inspect the active local policy, explain recent denials, verify or lock a content-addressed org policy bundle, add a narrow action/origin grant, bound where automation may send traffic (egressAllowlist), set an origin's permission mode (manual gates every mutation, skip pre-approves confirmations that are not on the non-skippable list), or set a DLP channel mode (dlp <clipboard|upload|download|screenShare> allow|audit|block).",
    ),
    "schedule": (
        "chrome-bridge schedule workflow <workflowPath> --at <ISO8601>|--interval <seconds> [--name <name>] | schedule list | schedule remove <name>",
        "Register local metadata for a replayable workflow file. This starts nothing: Chrome Bridge runs no daemon and no timer, so an OS scheduler (cron, launchd, systemd) or a human must invoke the printed runCommand, and host policy still authorizes every step at run time.",
    ),
    "audit": (
        "chrome-bridge audit tail [count] | audit summary [--since <ISO8601|7d|12h|30m>] | "
        "audit export --format <jsonl|syslog|cef> --destination <dest> "
        "[--since <ISO8601|7d|12h>] [--limit N] [--dry-run]",
        "Read the local audit log: recent decisions as columns, or aggregate counts. Metadata only, never payloads. "
        "export re-encodes the existing local log to a file or syslog collector for backfill, or to prove a "
        "destination before enabling the auditExport policy key; --dry-run formats and counts without writing.",
    ),
    "trace": (
        "chrome-bridge trace summary <traceId> | trace tail <traceId> [count] [--trace-dir <dir>]",
        "Read a session trace artifact the host wrote under policy traceDir: per-action decisions, timings, "
        "tab ids, and response/snapshot hashes. Metadata only, never payloads or page content.",
    ),
    "setCookie": (
        "chrome-bridge setCookie <url> <name> <value> [--domain <domain>] [--path <path>] [--secure] [--http-only] [--same-site <policy>] [--expires <epochSeconds>]",
        "Write one cookie into the real profile. The response reports the cookie name and domain only, never the value. Confirmation-gated in the example policy.",
    ),
    "clearStorage": (
        "chrome-bridge clearStorage <tabId> local|session|both",
        "Clear web storage for the tab origin. The response reports removed key counts only, never keys or values. Confirmation-gated in the example policy.",
    ),
    "searchTabs": (
        "chrome-bridge searchTabs <query> [--regex] [--max-per-tab <count>] [--case-sensitive]",
        "Search visible text across all http/https tabs. Reports tab id, domain, and bounded snippets; snippets contain page content, so treat output as sensitive.",
    ),
    "startScreencast": (
        "chrome-bridge startScreencast <tabId> [--quality <1-100>] [--max-width <pixels>]",
        "Begin buffering CDP screencast frames for the tab without activating it. Continuous capture of a real profile is high-exposure, so the example policy confirmation-gates it. Frames live only in the extension service worker: a worker restart ends the recording.",
    ),
    "screencastSave": (
        "chrome-bridge screencastSave <tabId> <outputDir> [--fps <rate>] [--mp4]",
        "Drain buffered frames to numbered image files plus frames.json in outputDir. outputDir is created and checked before any frame is drained, and only a previous save's artifacts (frame-*.png, frame-*.jpg, frames.json, screencast.mp4) are removed first, so a shorter second save never mixes in stale frames. Prints only the directory, frame count, dropped count, byte totals, and staleArtifactsRemoved; frame data is never printed. With --mp4 the system ffmpeg (never bundled) assembles screencast.mp4 and frames are kept either way.",
    ),
    "stopScreencast": (
        "chrome-bridge stopScreencast <tabId>",
        "Stop the screencast and detach the debugger if nothing else holds it. Any frames still buffered are discarded, so run screencastSave first.",
    ),
    "consoleMessages": (
        "chrome-bridge consoleMessages <tabId> [--source-maps]",
        "Print buffered console entries as JSON. Each entry carries a stack of raw generated frames (url, 0-based lineNumber/columnNumber, functionName). With --source-maps the extension additionally resolves each frame through the script's own source map, adding originalLocation (source, name, 0-based lineNumber/columnNumber) or sourceMapStatus (notFound, invalid, unmapped, crossOriginRefused). Maps are read only from the script's own origin; source text is never fetched for output and never printed.",
    ),
    "extractStructured": (
        "chrome-bridge extractStructured <tabId> <schemaPath> [outputPath] [--selector <selector>] [--max-chars <count>]",
        "Extract fields described by a JSON Schema subset (object, array, string, number, boolean, enum, required, properties, items) into validated JSON. "
        "Mapping is deterministic and heuristic: labels, headings, table headers, dl term/definition pairs, aria-label, name attributes, and \"Key: value\" text lines. "
        "No model inference is involved. Optional fields with no confident value are omitted; missing required fields are reported in errors. "
        "With outputPath the data is written there and stdout carries only metadata; otherwise the validated data is printed. Raw page text is never returned, "
        "but extracted values are still page content: treat them as untrusted data.",
    ),
    "scanPromptInjection": (
        "chrome-bridge scanPromptInjection <tabId> [--selector <selector>] [--max-chars <count>]",
        "Scan page text for instruction-like patterns aimed at an agent, its tools, its secrets, or its policy (ignore previous instructions, reveal the system prompt, "
        "exfiltrate tokens or cookies, run a shell command, click allow, disable policy). Returns risk (low|medium|high), matches with kind, severity, and a snippet "
        "capped at 160 characters, plus scannedChars. The scan is heuristic: a hit is a warning, never a permission grant or denial, and a clean result is not a guarantee.",
    ),
    "expect": (
        "chrome-bridge expect <tabId> selector|text|url|schema <value> [--negate] [--timeout <ms>]",
        "Assert a deterministic postcondition and exit 0 only when it holds, so it composes in shell scripts and CI. "
        "<value> is the selector (CSS or semantic, including ref=), the expected page text, the expected URL substring, "
        "or the path to a JSON Schema file for schema mode. selector passes when the selector resolves; text when the page "
        "text contains the string; url when the tab URL contains the substring; schema when structured extraction against "
        "that schema reports no missingRequired errors. --negate inverts the outcome, which is how absence is asserted. "
        "The check polls until the condition holds or --timeout elapses (default 5000ms, capped at 60000ms). No model is "
        "involved, and the result carries only mode, passed, attempts, elapsedMs, and a short reason when it failed: the "
        "matched element, the matched text, the tab URL, and the extracted values are never returned. Exit code is 1 when "
        "the assertion did not hold.",
    ),
    "workflow": (
        "chrome-bridge workflow record start|stop|save ... | chrome-bridge workflow replay <path> [--binding key=value]",
        "Record the actions THIS BRIDGE dispatches into a replayable workflow, and replay one later without a model. "
        "Recording never observes human clicks or keystrokes; only successful mutating bridge actions are appended. "
        "Typed and stored values (type/fill text, cookie and storage values, any credential-shaped key) are recorded as <redacted> "
        "unless the recording was started with --record-sensitive, and replay refuses the whole workflow until every redacted field "
        "is supplied with --binding step<N>.<field>=<value>. A replayed workflow reproduces real mutating actions: review the file first. "
        "stop stashes the workflow locally and prints metadata only; save writes it to a caller path.",
    ),
    "cache": (
        "chrome-bridge cache selectors list [--sync] | clear [--local-only] | export <path> | import <path>",
        "Manage the file-backed semantic-selector resolution cache (bridge_action_cache.json, mode 600). Each entry maps "
        "(urlPattern, semantic selector) to the CSS path that last resolved to that element. On a hit, replay resolves both the "
        "cached path and the original text=/label=/role=/aria= selector and reuses the cached path only when both land on the same "
        "live DOM node; a path that still resolves but now points at a replacement element is discarded and the semantic selector "
        "is re-resolved (selfHealed). CSS selectors are never cached or "
        "retargeted. list prints intent selectors and counts; export writes the resolved paths to a caller path.",
    ),
}

# Exact one-line usage for the rest of the public CLI. The longer explanations
# above cover commands with non-obvious safety or selector behavior; every
# command still gets a useful ``<command> --help`` response.
COMMAND_USAGES = {
    "ping": "chrome-bridge ping",
    "navigate": "chrome-bridge navigate <url> [--foreground]",
    "getTabs": "chrome-bridge getTabs",
    "getCookies": "chrome-bridge getCookies <domain>",
    "type": "chrome-bridge type <tabId> <selector> <text>",
    "fill": "chrome-bridge fill <tabId> <selector> <text>",
    "hover": "chrome-bridge hover <tabId> <selector>",
    "scroll": "chrome-bridge scroll <tabId> <deltaX> <deltaY> [selector]",
    "press": "chrome-bridge press <tabId> <keySpec>",
    "drag": "chrome-bridge drag <tabId> <fromSelector> <toSelector>",
    "select": "chrome-bridge select <tabId> <selector> <value>",
    "uploadFile": "chrome-bridge uploadFile <tabId> <selector> <path...>",
    "githubAttachUploadedFiles": "chrome-bridge githubAttachUploadedFiles <tabId> <inputSelector> [formSelector] [timeoutMs]",
    "githubSubmitComment": "chrome-bridge githubSubmitComment <tabId> [formSelector] [timeoutMs]",
    "githubAttachPrBody": "chrome-bridge github-attach-pr-body <tabId> <file...> [--timeout <milliseconds>]",
    "activateTab": "chrome-bridge activateTab <tabId>",
    "closeTab": "chrome-bridge closeTab <tabId>",
    "reload": "chrome-bridge reload <tabId>",
    "goBack": "chrome-bridge goBack <tabId>",
    "goForward": "chrome-bridge goForward <tabId>",
    "waitForLoad": "chrome-bridge waitForLoad <tabId> [timeoutMs]",
    "waitForSelector": "chrome-bridge waitForSelector <tabId> <selector> [timeoutMs]",
    "waitForText": "chrome-bridge waitForText <tabId> <text> [timeoutMs]",
    "waitForUrl": "chrome-bridge waitForUrl <tabId> <substring> [timeoutMs]",
    "expect": "chrome-bridge expect <tabId> selector|text|url|schema <value> [--negate] [--timeout <ms>]",
    "getCurrentState": "chrome-bridge getCurrentState <tabId>",
    "screenshot": "chrome-bridge screenshot <tabId> <outputPath> [--visible]",
    "extractText": "chrome-bridge extractText <tabId> [maxChars]",
    "getHTML": "chrome-bridge getHTML <tabId> <outputPath>",
    "setViewport": "chrome-bridge setViewport <tabId> <width> <height> [deviceScaleFactor]",
    "setCpuThrottling": "chrome-bridge setCpuThrottling <tabId> <rate>",
    "setNetworkConditions": "chrome-bridge setNetworkConditions <tabId> <offline:0|1> [latencyMs] [downBps] [upBps]",
    "clearNetworkConditions": "chrome-bridge clearNetworkConditions <tabId>",
    "setColorScheme": "chrome-bridge setColorScheme <tabId> light|dark|no-preference",
    "setUserAgent": "chrome-bridge setUserAgent <tabId> <userAgent...>",
    "startMonitoring": "chrome-bridge startMonitoring <tabId>",
    "stopMonitoring": "chrome-bridge stopMonitoring <tabId>",
    "startScreencast": "chrome-bridge startScreencast <tabId> [--quality <1-100>] [--max-width <pixels>]",
    "screencastSave": "chrome-bridge screencastSave <tabId> <outputDir> [--fps <rate>] [--mp4]",
    "stopScreencast": "chrome-bridge stopScreencast <tabId>",
    "consoleMessages": "chrome-bridge consoleMessages <tabId> [--source-maps]",
    "networkRequests": "chrome-bridge networkRequests <tabId>",
    "handleDialog": "chrome-bridge handleDialog <tabId> accept|dismiss [promptText]",
    "downloadUrl": "chrome-bridge downloadUrl <url> [filename]",
    "storageState": "chrome-bridge storageState <tabId> <outputPath>",
    "setCookie": "chrome-bridge setCookie <url> <name> <value> [--domain <domain>] [--path <path>] [--secure] [--http-only] [--same-site no_restriction|lax|strict] [--expires <epochSeconds>]",
    "deleteCookie": "chrome-bridge deleteCookie <url> <name>",
    "setStorageItem": "chrome-bridge setStorageItem <tabId> local|session <key> <value>",
    "removeStorageItem": "chrome-bridge removeStorageItem <tabId> local|session <key>",
    "clearStorage": "chrome-bridge clearStorage <tabId> local|session|both",
    "searchHistory": "chrome-bridge searchHistory <query> [maxResults] [--since <epochMillis>]",
    "searchBookmarks": "chrome-bridge searchBookmarks <query>",
    "searchTabs": "chrome-bridge searchTabs <query> [--regex] [--max-per-tab <count>] [--case-sensitive]",
    "setGeolocation": "chrome-bridge setGeolocation <tabId> <latitude> <longitude> [accuracy]",
    "clearGeolocation": "chrome-bridge clearGeolocation <tabId>",
    "startInterception": "chrome-bridge startInterception <tabId> <urlPattern> continue|abort|fulfill [status] [body]",
    "stopInterception": "chrome-bridge stopInterception <tabId>",
    "interceptedRequests": "chrome-bridge interceptedRequests <tabId>",
    "performanceMetrics": "chrome-bridge performanceMetrics <tabId>",
    "sessionStatus": "chrome-bridge sessionStatus <domain> [domain...]",
    "waitForHandoff": "chrome-bridge waitForHandoff <message> [mode] [target] [timeoutMs] [tabId]",
    "credentialHandoff": "chrome-bridge credentialHandoff <tabId> <selector> [message] [--mode filled|submitted] [--timeout <milliseconds>]",
    "policyCheck": "chrome-bridge policyCheck <action> [payloadJson] | chrome-bridge policyCheck --plan '<jsonArray>'",
    "batch": "chrome-bridge batch <stepsJson> [tabId] [--continue-on-error]",
    "printToPDF": "chrome-bridge printToPDF <tabId> <outputPath> [--landscape] [--scale <factor>]",
    "clickAt": "chrome-bridge clickAt <tabId> <x> <y>",
    "windowControl": "chrome-bridge windowControl list|create|focus|setState|close [args...]",
}


def print_command_help(command):
    entry = COMMAND_HELP.get(command)
    if entry is not None:
        usage, description = entry
        print(f"Usage: {usage}")
        print(description)
        return 0
    usage = COMMAND_USAGES.get(command)
    if usage is None:
        print(f"No help is available for unknown command: {command}", file=sys.stderr)
        return 64
    print(f"Usage: {usage}")
    print("See docs/commands.md for behavior, selector forms, and safety notes.")
    return 0

def main():
    global DRY_RUN, TRACEPARENT
    if "--dry-run" in sys.argv[1:]:
        DRY_RUN = True
        sys.argv = [sys.argv[0]] + [a for a in sys.argv[1:] if a != "--dry-run"]

    if "--traceparent" in sys.argv[1:]:
        index = sys.argv.index("--traceparent")
        if index + 1 >= len(sys.argv):
            print("Usage: --traceparent <value>", file=sys.stderr)
            sys.exit(64)
        TRACEPARENT = sys.argv[index + 1]
        sys.argv = sys.argv[:index] + sys.argv[index + 2:]

    if len(sys.argv) < 2:
        print_usage()
        sys.exit(0)

    action = sys.argv[1]
    args = sys.argv

    if action in {"-h", "--help"}:
        print_usage()
        sys.exit(0)
    if action == "help":
        if len(args) == 2:
            print_usage()
            sys.exit(0)
        sys.exit(print_command_help(args[2]))
    if len(args) > 2 and args[2] in {"-h", "--help"}:
        sys.exit(print_command_help(action))

    if action == "doctor":
        sys.exit(cmd_doctor())
    if action == "ping":
        sys.exit(send_command("ping"))
    elif action == "ready":
        sys.exit(cmd_ready(args))
    elif action == "navigate":
        require_args(args, 3, "Missing URL.")
        foreground = len(args) > 3 and args[3] == "--foreground"
        payload = {"url": args[2], "active": foreground}
        sys.exit(send_command("navigate", payload))
    elif action == "navigateAndSnapshot":
        sys.exit(cmd_navigate_and_snapshot(args))
    elif action == "getTabs":
        sys.exit(send_command("getTabs"))
    elif action == "taskSession":
        require_args(args, 3, "Usage: python3 test_client.py taskSession create|navigate|show|state|close ...")
        op = args[2]
        if op == "create":
            require_args(args, 4, "Usage: python3 test_client.py taskSession create <name>")
            sys.exit(send_command("createTaskSession", {"name": args[3]}))
        if op == "navigate":
            require_args(args, 5, "Usage: python3 test_client.py taskSession navigate <sessionId> <url> [--foreground] [--new]")
            flags = set(args[5:])
            sys.exit(send_command("navigateTaskSession", {
                "sessionId": args[3],
                "url": args[4],
                "active": "--foreground" in flags,
                "reuse": "--new" not in flags,
            }))
        if op == "show":
            payload = {"sessionId": args[3]} if len(args) > 3 else {}
            sys.exit(send_command("getTaskSessions", payload))
        if op == "state":
            require_args(args, 5, "Usage: python3 test_client.py taskSession state <sessionId> <working|needs_user|completed>")
            state = args[4]
            if state not in {"working", "needs_user", "completed"}:
                print("state must be working, needs_user, or completed", file=sys.stderr)
                sys.exit(64)
            sys.exit(send_command("updateTaskSessionState", {"sessionId": args[3], "state": state}))
        if op == "close":
            require_args(args, 4, "Usage: python3 test_client.py taskSession close <sessionId>")
            sys.exit(send_command("closeTaskSession", {"sessionId": args[3]}))
        print(f"Unknown taskSession operation: {op}", file=sys.stderr)
        sys.exit(64)
    elif action == "getCookies":
        require_args(args, 3, "Missing domain.")
        sys.exit(send_command("getCookies", {"domain": args[2]}))
    elif action == "executeScript":
        require_args(args, 4, "Usage: python3 test_client.py executeScript <tabId> <code>")
        sys.exit(send_command("executeScript", {"tabId": parse_int(args[2], "tabId"), "code": args[3]}))
    elif action == "executeScriptCDP":
        require_args(args, 4, "Usage: python3 test_client.py executeScriptCDP <tabId> <code>")
        sys.exit(send_command("executeScriptCDP", {"tabId": parse_int(args[2], "tabId"), "code": args[3]}))
    elif action == "click":
        require_args(args, 4, "Usage: python3 test_client.py click <tabId> <selector>")
        sys.exit(send_command("click", {"tabId": parse_int(args[2], "tabId"), "selector": args[3]}))
    elif action == "clickAt":
        require_args(args, 5, "Usage: chrome-bridge clickAt <tabId> <x> <y>")
        sys.exit(send_command("clickAt", {
            "tabId": parse_int(args[2], "tabId"),
            "x": parse_float(args[3], "x"),
            "y": parse_float(args[4], "y"),
        }))
    elif action == "type":
        require_args(args, 5, "Usage: python3 test_client.py type <tabId> <selector> <text>")
        sys.exit(send_command("type", {"tabId": parse_int(args[2], "tabId"), "selector": args[3], "text": args[4]}))
    elif action == "observe":
        require_args(args, 3, "Usage: python3 test_client.py observe <tabId>")
        sys.exit(send_command("observe", parse_observe_args(args)))
    elif action in {"activateTab", "closeTab", "reload", "goBack", "goForward", "getCurrentState", "startMonitoring", "stopMonitoring", "networkRequests"}:
        require_args(args, 3, f"Usage: python3 test_client.py {action} <tabId>")
        sys.exit(send_command(action, {"tabId": parse_int(args[2], "tabId")}))
    elif action == "consoleMessages":
        require_args(args, 3, "Usage: chrome-bridge consoleMessages <tabId> [--source-maps]")
        resolve_source_maps = False
        for flag in args[3:]:
            if flag != "--source-maps":
                print(f"Unknown option for consoleMessages: {flag}", file=sys.stderr)
                sys.exit(2)
            resolve_source_maps = True
        payload = {"tabId": parse_int(args[2], "tabId")}
        if resolve_source_maps:
            payload["resolveSourceMaps"] = True
        exit_code, response, stderr = send_command_data("consoleMessages", payload)
        if response is not None:
            print(json.dumps(redact_source_text(response) if resolve_source_maps else response, indent=2))
        if stderr:
            print(stderr, file=sys.stderr)
        sys.exit(exit_code)
    elif action == "waitForLoad":
        require_args(args, 3, "Usage: python3 test_client.py waitForLoad <tabId> [timeoutMs]")
        sys.exit(send_command("waitForLoad", {"tabId": parse_int(args[2], "tabId"), "timeoutMs": parse_timeout(args, 3)}))
    elif action == "waitForSelector":
        require_args(args, 4, "Usage: python3 test_client.py waitForSelector <tabId> <selector> [timeoutMs]")
        sys.exit(send_command("waitForSelector", {"tabId": parse_int(args[2], "tabId"), "selector": args[3], "timeoutMs": parse_timeout(args, 4)}))
    elif action == "waitForText":
        require_args(args, 4, "Usage: python3 test_client.py waitForText <tabId> <text> [timeoutMs]")
        sys.exit(send_command("waitForText", {"tabId": parse_int(args[2], "tabId"), "text": args[3], "timeoutMs": parse_timeout(args, 4)}))
    elif action == "waitForUrl":
        require_args(args, 4, "Usage: python3 test_client.py waitForUrl <tabId> <substring> [timeoutMs]")
        sys.exit(send_command("waitForUrl", {"tabId": parse_int(args[2], "tabId"), "substring": args[3], "timeoutMs": parse_timeout(args, 4)}))
    elif action == "expect":
        require_args(args, 5, "Usage: python3 test_client.py expect <tabId> selector|text|url|schema <value> "
                              "[--negate] [--timeout <ms>]")
        sys.exit(cmd_expect(args))
    elif action == "screenshot":
        require_args(args, 4, "Usage: python3 test_client.py screenshot <tabId> <outputPath> [--visible]")
        visible = len(args) > 4 and args[4] == "--visible"
        sys.exit(save_screenshot(parse_int(args[2], "tabId"), args[3], quiet=not visible))
    elif action == "extractText":
        require_args(args, 3, "Usage: python3 test_client.py extractText <tabId> [maxChars]")
        max_chars = parse_int(args[3], "maxChars") if len(args) > 3 else 20000
        sys.exit(send_command("extractText", {"tabId": parse_int(args[2], "tabId"), "maxChars": max_chars}))
    elif action == "extractStructured":
        require_args(args, 4, "Usage: chrome-bridge extractStructured <tabId> <schemaPath> [outputPath] [--selector <selector>] [--max-chars <count>]")
        rest = args[4:]
        output_path = None
        selector = None
        max_chars = None
        index = 0
        while index < len(rest):
            item = rest[index]
            if item == "--selector":
                if index + 1 >= len(rest):
                    print("Error: --selector requires a value", file=sys.stderr)
                    sys.exit(2)
                selector = rest[index + 1]
                index += 2
                continue
            if item == "--max-chars":
                if index + 1 >= len(rest):
                    print("Error: --max-chars requires a value", file=sys.stderr)
                    sys.exit(2)
                max_chars = parse_int(rest[index + 1], "maxChars")
                index += 2
                continue
            if item.startswith("--"):
                print(f"Unknown option for extractStructured: {item}", file=sys.stderr)
                sys.exit(2)
            if output_path is not None:
                print(f"Unexpected argument for extractStructured: {item}", file=sys.stderr)
                sys.exit(2)
            output_path = item
            index += 1
        sys.exit(extract_structured(
            parse_int(args[2], "tabId"),
            load_schema_file(args[3]),
            output_path,
            selector,
            max_chars,
        ))
    elif action == "scanPromptInjection":
        require_args(args, 3, "Usage: chrome-bridge scanPromptInjection <tabId> [--selector <selector>] [--max-chars <count>]")
        rest = args[3:]
        payload = {"tabId": parse_int(args[2], "tabId")}
        index = 0
        while index < len(rest):
            item = rest[index]
            if item in {"--selector", "--max-chars"}:
                if index + 1 >= len(rest):
                    print(f"Error: {item} requires a value", file=sys.stderr)
                    sys.exit(2)
                if item == "--selector":
                    payload["selector"] = rest[index + 1]
                else:
                    payload["maxChars"] = parse_int(rest[index + 1], "maxChars")
                index += 2
                continue
            print(f"Unknown option for scanPromptInjection: {item}", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("scanPromptInjection", payload))
    elif action == "getHTML":
        require_args(args, 4, "Usage: python3 test_client.py getHTML <tabId> <outputPath>")
        sys.exit(save_html(parse_int(args[2], "tabId"), args[3]))
    elif action == "hover":
        require_args(args, 4, "Usage: python3 test_client.py hover <tabId> <selector>")
        sys.exit(send_command("hover", {"tabId": parse_int(args[2], "tabId"), "selector": args[3]}))
    elif action == "scroll":
        require_args(args, 5, "Usage: python3 test_client.py scroll <tabId> <deltaX> <deltaY> [selector]")
        sys.exit(send_command("scroll", {
            "tabId": parse_int(args[2], "tabId"),
            "deltaX": parse_float(args[3], "deltaX"),
            "deltaY": parse_float(args[4], "deltaY"),
            "selector": args[5] if len(args) > 5 else None,
        }))
    elif action == "press":
        require_args(args, 4, "Usage: python3 test_client.py press <tabId> <keySpec>")
        sys.exit(send_command("press", {"tabId": parse_int(args[2], "tabId"), "key": args[3]}))
    elif action == "drag":
        require_args(args, 5, "Usage: python3 test_client.py drag <tabId> <fromSelector> <toSelector>")
        sys.exit(send_command("drag", {"tabId": parse_int(args[2], "tabId"), "fromSelector": args[3], "toSelector": args[4]}))
    elif action == "fill":
        require_args(args, 5, "Usage: python3 test_client.py fill <tabId> <selector> <text>")
        sys.exit(send_command("fill", {"tabId": parse_int(args[2], "tabId"), "selector": args[3], "text": args[4]}))
    elif action == "insertRichText":
        sys.exit(cmd_insert_rich_text(args))
    elif action == "select":
        require_args(args, 5, "Usage: python3 test_client.py select <tabId> <selector> <value>")
        sys.exit(send_command("select", {"tabId": parse_int(args[2], "tabId"), "selector": args[3], "value": args[4]}))
    elif action == "uploadFile":
        require_args(args, 5, "Usage: python3 test_client.py uploadFile <tabId> <selector> <path...>")
        sys.exit(send_command("uploadFile", {"tabId": parse_int(args[2], "tabId"), "selector": args[3], "files": expand_existing_files(args[4:])}))
    elif action == "githubAttachUploadedFiles":
        require_args(args, 4, "Usage: python3 test_client.py githubAttachUploadedFiles <tabId> <inputSelector> [formSelector] [timeoutMs]")
        payload = {"tabId": parse_int(args[2], "tabId"), "inputSelector": args[3]}
        if len(args) > 4:
            payload["formSelector"] = args[4]
        if len(args) > 5:
            payload["timeoutMs"] = parse_int(args[5], "timeoutMs")
        sys.exit(send_command("githubAttachUploadedFiles", payload))
    elif action == "githubSubmitComment":
        require_args(args, 3, "Usage: python3 test_client.py githubSubmitComment <tabId> [formSelector] [timeoutMs]")
        payload = {"tabId": parse_int(args[2], "tabId")}
        if len(args) > 3:
            payload["formSelector"] = args[3]
        if len(args) > 4:
            payload["timeoutMs"] = parse_int(args[4], "timeoutMs")
        sys.exit(send_command("githubSubmitComment", payload))
    elif action in {"github-attach-pr-body", "githubAttachPrBody"}:
        require_args(args, 4, "Usage: chrome-bridge github-attach-pr-body <tabId> <file...> [--timeout <milliseconds>]")
        paths = []
        timeout_ms = 30000
        index = 3
        while index < len(args):
            if args[index] == "--timeout":
                if index + 1 >= len(args):
                    print("Missing value for --timeout", file=sys.stderr)
                    sys.exit(2)
                timeout_ms = parse_int(args[index + 1], "timeoutMs")
                index += 2
                continue
            paths.append(args[index])
            index += 1
        if not paths:
            print("At least one attachment file is required", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("githubAttachPrBody", {
            "tabId": parse_int(args[2], "tabId"),
            "files": expand_existing_files(paths),
            "timeoutMs": timeout_ms,
        }))
    elif action == "setViewport":
        require_args(args, 5, "Usage: python3 test_client.py setViewport <tabId> <width> <height> [deviceScaleFactor]")
        scale = parse_float(args[5], "deviceScaleFactor") if len(args) > 5 else 1
        sys.exit(send_command("setViewport", {
            "tabId": parse_int(args[2], "tabId"),
            "width": parse_int(args[3], "width"),
            "height": parse_int(args[4], "height"),
            "deviceScaleFactor": scale,
        }))
    elif action == "handleDialog":
        require_args(args, 4, "Usage: python3 test_client.py handleDialog <tabId> accept|dismiss [promptText]")
        if args[3] not in {"accept", "dismiss"}:
            print("Dialog action must be accept or dismiss", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("handleDialog", {
            "tabId": parse_int(args[2], "tabId"),
            "accept": args[3] == "accept",
            "promptText": " ".join(args[4:]) if len(args) > 4 else None,
        }))
    elif action == "downloadUrl":
        require_args(args, 3, "Usage: python3 test_client.py downloadUrl <url> [filename]")
        payload = {"url": args[2]}
        if len(args) > 3:
            payload["filename"] = args[3]
        sys.exit(send_command("downloadUrl", payload))
    elif action == "storageState":
        require_args(args, 4, "Usage: python3 test_client.py storageState <tabId> <outputPath>")
        sys.exit(save_storage_state(parse_int(args[2], "tabId"), args[3]))
    elif action == "setGeolocation":
        require_args(args, 5, "Usage: python3 test_client.py setGeolocation <tabId> <latitude> <longitude> [accuracy]")
        accuracy = parse_float(args[5], "accuracy") if len(args) > 5 else None
        sys.exit(send_command("setGeolocation", {
            "tabId": parse_int(args[2], "tabId"),
            "latitude": parse_float(args[3], "latitude"),
            "longitude": parse_float(args[4], "longitude"),
            "accuracy": accuracy
        }))
    elif action == "clearGeolocation":
        require_args(args, 3, "Usage: python3 test_client.py clearGeolocation <tabId>")
        sys.exit(send_command("clearGeolocation", {"tabId": parse_int(args[2], "tabId")}))
    elif action == "startInterception":
        require_args(args, 5, "Usage: python3 test_client.py startInterception <tabId> <urlPattern> continue|abort|fulfill [status] [body]")
        tab_id = parse_int(args[2], "tabId")
        url_pattern = args[3]
        mode = args[4]
        if mode not in {"continue", "abort", "fulfill"}:
            print("Interception mode must be continue, abort, or fulfill", file=sys.stderr)
            sys.exit(2)
        status = None
        body = None
        if len(args) > 5:
            status = parse_int(args[5], "status")
        if len(args) > 6:
            body = " ".join(args[6:])
        sys.exit(send_command("startInterception", {
            "tabId": tab_id,
            "urlPattern": url_pattern,
            "mode": mode,
            "status": status,
            "body": body
        }))
    elif action in {"stopInterception", "interceptedRequests", "performanceMetrics"}:
        require_args(args, 3, f"Usage: python3 test_client.py {action} <tabId>")
        sys.exit(send_command(action, {"tabId": parse_int(args[2], "tabId")}))
    elif action == "batch":
        require_args(args, 3, "Usage: chrome-bridge batch <stepsJson> [tabId] [--continue-on-error]")
        rest = list(args[3:])
        stop_on_error = "--continue-on-error" not in rest
        rest = [arg for arg in rest if arg != "--continue-on-error"]
        try:
            steps = json.loads(args[2])
        except Exception as exc:
            print(f"Invalid steps JSON: {exc}", file=sys.stderr)
            sys.exit(2)
        payload = {"steps": steps, "stopOnError": stop_on_error}
        if rest:
            payload["tabId"] = parse_int(rest[0], "tabId")
        sys.exit(send_command("batch", payload))
    elif action == "startScreencast":
        require_args(args, 3, "Usage: chrome-bridge startScreencast <tabId> [--quality <1-100>] [--max-width <pixels>]")
        payload = {"tabId": parse_int(args[2], "tabId")}
        index = 3
        while index < len(args):
            flag = args[index]
            if flag in {"--quality", "--max-width"}:
                if index + 1 >= len(args):
                    print(f"Missing value for {flag}", file=sys.stderr)
                    sys.exit(2)
                key = "quality" if flag == "--quality" else "maxWidth"
                payload[key] = parse_int(args[index + 1], key)
                index += 2
                continue
            print(f"Unknown startScreencast option: {flag}", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("startScreencast", payload))
    elif action == "screencastSave":
        require_args(args, 4, "Usage: chrome-bridge screencastSave <tabId> <outputDir> [--fps <rate>] [--mp4]")
        fps = 8
        make_mp4 = False
        index = 4
        while index < len(args):
            flag = args[index]
            if flag == "--mp4":
                make_mp4 = True
                index += 1
                continue
            if flag == "--fps":
                if index + 1 >= len(args):
                    print("Missing value for --fps", file=sys.stderr)
                    sys.exit(2)
                fps = parse_int(args[index + 1], "fps")
                index += 2
                continue
            print(f"Unknown screencastSave option: {flag}", file=sys.stderr)
            sys.exit(2)
        if fps < 1:
            print("Invalid fps: must be >= 1", file=sys.stderr)
            sys.exit(2)
        sys.exit(save_screencast(parse_int(args[2], "tabId"), args[3], fps, make_mp4))
    elif action == "stopScreencast":
        require_args(args, 3, "Usage: chrome-bridge stopScreencast <tabId>")
        sys.exit(send_command("stopScreencast", {"tabId": parse_int(args[2], "tabId")}))
    elif action == "printToPDF":
        require_args(args, 4, "Usage: chrome-bridge printToPDF <tabId> <outputPath> [--landscape] [--scale <factor>]")
        # printBackground defaults on so an exported page matches what the tab renders.
        options = {"printBackground": True}
        index = 4
        while index < len(args):
            if args[index] == "--landscape":
                options["landscape"] = True
                index += 1
                continue
            if args[index] == "--scale":
                if index + 1 >= len(args):
                    print("Missing value for --scale", file=sys.stderr)
                    sys.exit(2)
                options["scale"] = parse_float(args[index + 1], "scale")
                index += 2
                continue
            print(f"Unknown printToPDF option: {args[index]}", file=sys.stderr)
            sys.exit(2)
        sys.exit(save_pdf(parse_int(args[2], "tabId"), args[3], options))
    elif action == "windowControl":
        require_args(args, 3, "Usage: chrome-bridge windowControl list|create|focus|setState|close [args...]")
        op = args[2]
        payload = {"op": op}
        if op == "list":
            pass
        elif op == "create":
            rest = list(args[3:])
            if "--foreground" in rest:
                payload["focused"] = True
                rest = [arg for arg in rest if arg != "--foreground"]
            if rest:
                payload["url"] = rest[0]
            if len(rest) > 1:
                if rest[1] not in WINDOW_STATES:
                    print(f"Window state must be one of: {', '.join(WINDOW_STATES)}", file=sys.stderr)
                    sys.exit(2)
                payload["state"] = rest[1]
        elif op in {"focus", "close"}:
            require_args(args, 4, f"Usage: chrome-bridge windowControl {op} <windowId>")
            payload["windowId"] = parse_int(args[3], "windowId")
        elif op == "setState":
            require_args(args, 5, "Usage: chrome-bridge windowControl setState <windowId> normal|minimized|maximized")
            if args[4] not in WINDOW_STATES:
                print(f"Window state must be one of: {', '.join(WINDOW_STATES)}", file=sys.stderr)
                sys.exit(2)
            payload["windowId"] = parse_int(args[3], "windowId")
            payload["state"] = args[4]
        else:
            print("windowControl op must be list, create, focus, setState, or close", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("windowControl", payload))
    elif action == "confirm":
        require_args(args, 3, "Usage: chrome-bridge confirm <confirmationToken>")
        if len(args) == 3:
            sys.exit(send_command("confirm", {"confirmationToken": args[2]}))
        # Backward compatibility for the old, hard-to-use form. New callers
        # should use the token-only host resume path above.
        require_args(args, 5, "Usage: chrome-bridge confirm <confirmationToken> OR confirm <action> <confirmationToken> <payloadJson>")
        try:
            payload = json.loads(args[4])
        except Exception as exc:
            print(f"Invalid payload JSON: {exc}", file=sys.stderr)
            sys.exit(2)
        if not isinstance(payload, dict):
            print("payloadJson must be a JSON object", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command(args[2], payload, confirmation_token=args[3]))
    elif action == "policyCheck":
        require_args(args, 3, "Usage: python3 test_client.py policyCheck <action> [payloadJson] | policyCheck --plan '<jsonArray>'")
        if args[2] == "--plan":
            require_args(args, 4, "Usage: python3 test_client.py policyCheck --plan '<jsonArray>'")
            try:
                plan = json.loads(args[3])
            except Exception as exc:
                print(f"Invalid plan JSON: {exc}", file=sys.stderr)
                sys.exit(2)
            if not isinstance(plan, list):
                print("Plan must be a JSON array of {action, origin?, payload?} steps.", file=sys.stderr)
                sys.exit(2)
            sys.exit(send_command("policyCheck", {"plan": plan}))
        target_payload = {}
        if len(args) > 3:
            try:
                target_payload = json.loads(args[3])
            except Exception as exc:
                print(f"Invalid payload JSON: {exc}", file=sys.stderr)
                sys.exit(2)
        sys.exit(send_command("policyCheck", {"action": args[2], "payload": target_payload}))
    elif action == "sessionStatus":
        require_args(args, 3, "Usage: python3 test_client.py sessionStatus <domain> [<domain> ...]")
        sys.exit(send_command("sessionStatus", {"domains": list(args[2:])}))
    elif action == "waitForHandoff":
        require_args(args, 3, "Usage: python3 test_client.py waitForHandoff <message> [mode] [selectorOrUrlOrText] [timeoutMs] [tabId]")
        message = args[2]
        mode = args[3] if len(args) > 3 else "manual"
        target = args[4] if len(args) > 4 else None
        timeoutMs = parse_int(args[5], "timeoutMs") if len(args) > 5 else 120000
        until = {"mode": mode}
        if mode == "selector" and target is not None:
            until["selector"] = target
        elif mode == "url" and target is not None:
            until["urlSubstring"] = target
        elif mode == "text" and target is not None:
            until["text"] = target
        payload = {"message": message, "until": until, "timeoutMs": timeoutMs}
        if len(args) > 6:
            payload["tabId"] = parse_int(args[6], "tabId")
        sys.exit(send_command("waitForHandoff", payload, read_timeout_ms=timeoutMs))
    elif action == "credentialHandoff":
        require_args(args, 4, "Usage: python3 test_client.py credentialHandoff <tabId> <selector> [message] [--mode filled|submitted] [--timeout <milliseconds>]")
        mode = "filled"
        timeout_ms = 120000
        positional = []
        index = 4
        while index < len(args):
            if args[index] == "--mode":
                if index + 1 >= len(args):
                    print("Missing value for --mode", file=sys.stderr)
                    sys.exit(2)
                mode = args[index + 1]
                if mode not in ("filled", "submitted"):
                    print("--mode must be filled or submitted", file=sys.stderr)
                    sys.exit(2)
                index += 2
                continue
            if args[index] == "--timeout":
                if index + 1 >= len(args):
                    print("Missing value for --timeout", file=sys.stderr)
                    sys.exit(2)
                timeout_ms = parse_int(args[index + 1], "timeoutMs")
                index += 2
                continue
            positional.append(args[index])
            index += 1
        payload = {
            "tabId": parse_int(args[2], "tabId"),
            "selector": args[3],
            "mode": mode,
            "timeoutMs": timeout_ms,
        }
        if positional:
            payload["message"] = positional[0]
        # The human types the secret during this window, so the socket read must
        # outlast it exactly as the waitForHandoff path does.
        sys.exit(send_command("credentialHandoff", payload, read_timeout_ms=timeout_ms))
    elif action == "setCpuThrottling":
        require_args(args, 4, "Usage: python3 test_client.py setCpuThrottling <tabId> <rate>")
        sys.exit(send_command("setCpuThrottling", {
            "tabId": parse_int(args[2], "tabId"),
            "rate": parse_float(args[3], "rate"),
        }))
    elif action == "setNetworkConditions":
        require_args(args, 4, "Usage: python3 test_client.py setNetworkConditions <tabId> <offline:0|1> [latencyMs] [downBps] [upBps]")
        offline = args[3] in {"1", "true", "True"}
        latency = parse_float(args[4], "latency") if len(args) > 4 else 0
        down = parse_int(args[5], "downloadThroughput") if len(args) > 5 else -1
        up = parse_int(args[6], "uploadThroughput") if len(args) > 6 else -1
        sys.exit(send_command("setNetworkConditions", {
            "tabId": parse_int(args[2], "tabId"),
            "offline": offline,
            "latency": latency,
            "downloadThroughput": down,
            "uploadThroughput": up,
        }))
    elif action == "clearNetworkConditions":
        require_args(args, 3, "Usage: python3 test_client.py clearNetworkConditions <tabId>")
        sys.exit(send_command("clearNetworkConditions", {"tabId": parse_int(args[2], "tabId")}))
    elif action == "setColorScheme":
        require_args(args, 4, "Usage: python3 test_client.py setColorScheme <tabId> light|dark|no-preference")
        if args[3] not in {"light", "dark", "no-preference"}:
            print("Color scheme must be light, dark, or no-preference", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("setColorScheme", {
            "tabId": parse_int(args[2], "tabId"),
            "scheme": args[3],
        }))
    elif action == "setUserAgent":
        require_args(args, 4, "Usage: python3 test_client.py setUserAgent <tabId> <userAgent...>")
        ua = " ".join(args[3:])
        sys.exit(send_command("setUserAgent", {
            "tabId": parse_int(args[2], "tabId"),
            "userAgent": ua,
        }))
    elif action == "audit":
        sys.exit(cmd_audit(args))
    elif action == "trace":
        sys.exit(cmd_trace(args))
    elif action == "setCookie":
        require_args(args, 5, "Usage: python3 test_client.py setCookie <url> <name> <value> [--domain <domain>] [--path <path>] [--secure] [--http-only] [--same-site <policy>] [--expires <epochSeconds>]")
        payload = {"url": args[2], "name": args[3], "value": args[4]}
        rest = args[5:]
        index = 0
        while index < len(rest):
            flag = rest[index]
            if flag == "--secure":
                payload["secure"] = True
            elif flag == "--http-only":
                payload["httpOnly"] = True
            elif flag in {"--domain", "--path", "--same-site", "--expires"}:
                if index + 1 >= len(rest):
                    print(f"Missing value for {flag}", file=sys.stderr)
                    sys.exit(2)
                index += 1
                value = rest[index]
                if flag == "--domain":
                    payload["domain"] = value
                elif flag == "--path":
                    payload["path"] = value
                elif flag == "--same-site":
                    payload["sameSite"] = value
                else:
                    payload["expirationDate"] = parse_float(value, "expires")
            else:
                print(f"Unknown setCookie option: {flag}", file=sys.stderr)
                sys.exit(2)
            index += 1
        sys.exit(send_command("setCookie", payload))
    elif action == "deleteCookie":
        require_args(args, 4, "Usage: python3 test_client.py deleteCookie <url> <name>")
        sys.exit(send_command("deleteCookie", {"url": args[2], "name": args[3]}))
    elif action == "setStorageItem":
        require_args(args, 6, "Usage: python3 test_client.py setStorageItem <tabId> local|session <key> <value>")
        if args[3] not in {"local", "session"}:
            print("Storage scope must be local or session", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("setStorageItem", {
            "tabId": parse_int(args[2], "tabId"),
            "scope": args[3],
            "key": args[4],
            "value": args[5],
        }))
    elif action == "removeStorageItem":
        require_args(args, 5, "Usage: python3 test_client.py removeStorageItem <tabId> local|session <key>")
        if args[3] not in {"local", "session"}:
            print("Storage scope must be local or session", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("removeStorageItem", {
            "tabId": parse_int(args[2], "tabId"),
            "scope": args[3],
            "key": args[4],
        }))
    elif action == "clearStorage":
        require_args(args, 4, "Usage: python3 test_client.py clearStorage <tabId> local|session|both")
        if args[3] not in {"local", "session", "both"}:
            print("Storage scope must be local, session, or both", file=sys.stderr)
            sys.exit(2)
        sys.exit(send_command("clearStorage", {
            "tabId": parse_int(args[2], "tabId"),
            "scope": args[3],
        }))
    elif action == "searchHistory":
        require_args(args, 3, "Usage: python3 test_client.py searchHistory <query> [maxResults] [--since <epochMillis>]")
        payload = {"query": args[2]}
        rest = list(args[3:])
        if rest and not rest[0].startswith("--"):
            payload["maxResults"] = parse_int(rest.pop(0), "maxResults")
        index = 0
        while index < len(rest):
            if rest[index] == "--since":
                if index + 1 >= len(rest):
                    print("Missing value for --since", file=sys.stderr)
                    sys.exit(2)
                index += 1
                payload["startTime"] = parse_float(rest[index], "since")
            else:
                print(f"Unknown searchHistory option: {rest[index]}", file=sys.stderr)
                sys.exit(2)
            index += 1
        sys.exit(send_command("searchHistory", payload))
    elif action == "searchBookmarks":
        require_args(args, 3, "Usage: python3 test_client.py searchBookmarks <query>")
        sys.exit(send_command("searchBookmarks", {"query": args[2]}))
    elif action == "searchTabs":
        require_args(args, 3, "Usage: python3 test_client.py searchTabs <query> [--regex] [--max-per-tab <count>] [--case-sensitive]")
        payload = {"query": args[2]}
        rest = args[3:]
        index = 0
        while index < len(rest):
            flag = rest[index]
            if flag == "--regex":
                payload["isRegex"] = True
            elif flag == "--case-sensitive":
                payload["caseSensitive"] = True
            elif flag == "--max-per-tab":
                if index + 1 >= len(rest):
                    print("Missing value for --max-per-tab", file=sys.stderr)
                    sys.exit(2)
                index += 1
                payload["maxMatchesPerTab"] = parse_int(rest[index], "maxMatchesPerTab")
            else:
                print(f"Unknown searchTabs option: {flag}", file=sys.stderr)
                sys.exit(2)
            index += 1
        sys.exit(send_command("searchTabs", payload))
    elif action == "policy":
        sys.exit(cmd_policy(args))
    elif action == "schedule":
        sys.exit(cmd_schedule(args))
    elif action == "workflow":
        sys.exit(cmd_workflow(args))
    elif action == "cache":
        sys.exit(cmd_cache(args))
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(64)


if __name__ == '__main__':
    main()
