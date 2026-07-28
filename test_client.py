#!/usr/bin/env python3
import base64
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


def send_command_data(action, payload=None, read_timeout_ms=None, confirmation_token=None, dry_run=False):
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
    retry_seconds = float(os.environ.get('BRIDGE_CONNECT_TIMEOUT_SECONDS', 45))
    deadline = time.monotonic() + retry_seconds
    sock = None

    try:
        while True:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(15)
                sock.connect(('127.0.0.1', port))
                # Connect uses a short timeout; the post-connect read can be much
                # longer (e.g. human-handoff waits), with headroom over the
                # extension-side deadline so the wire never times out first.
                if read_timeout_ms is not None:
                    sock.settimeout(max(15, read_timeout_ms / 1000 + 10))
                break
            except ConnectionRefusedError:
                try:
                    sock.close()
                except Exception:
                    pass
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.5)

        cmd = {
            "action": action,
            "payload": payload,
            "token": token
        }
        if DRY_RUN or dry_run:
            cmd["dryRun"] = True
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
            "Error: timed out waiting for the extension to respond. "
            "Is the extension's service worker active? Open chrome://extensions, "
            f"click 'service worker' to wake it, then check {os.path.join(SCRIPT_DIR, 'bridge_debug.log')}."
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


def save_screencast(tab_id, output_dir, fps=8, make_mp4=False):
    """Drain the extension's buffered screencast frames to local image files.

    Frame bytes are written to disk and never printed: stdout carries only the
    directory, counts, and byte totals so a recording of the real profile cannot
    leak into a transcript.
    """
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
    directory = expand_output_path(output_dir)
    os.makedirs(directory, exist_ok=True)
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
    with open(manifest_path, "w") as f:
        json.dump({"count": written, "dropped": dropped, "timestamps": timestamps}, f)
    summary = {
        "success": True,
        "dir": directory,
        "frames": written,
        "dropped": dropped,
        "bytes": total_bytes,
        "manifest": manifest_path,
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


def cmd_policy(args):
    sub = args[2] if len(args) > 2 else ""
    if sub == "info":
        return send_command("policyInfo")
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
    print("Usage: python3 test_client.py policy <info|show|doctor|allow-action|allow-origin> ...", file=sys.stderr)
    return 64


def _policy_doctor(audit_file, policy_file):
    # Read recent deny entries from the audit log and propose the precise grant
    # for each distinct (action, target) so the user can self-service. Reads only
    # paths/metadata the host already disclosed; never forwards anything.
    denials = []
    try:
        with open(audit_file) as f:
            lines = f.readlines()
    except FileNotFoundError:
        print(json.dumps({"policyFile": policy_file, "denials": [],
                          "note": "No audit log yet; nothing to diagnose."}, indent=2))
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
        denials.append({"action": action, "reason": reason, "targets": targets,
                        "batchStep": batch_step, "suggestion": suggestion})
    print(json.dumps({"policyFile": policy_file, "auditLogFile": audit_file,
                      "denials": denials}, indent=2))
    return 0


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
    print("Usage: python3 test_client.py audit <tail [count] | summary [--since <ISO8601|7d|12h|30m>]>",
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


def print_usage():
    print("Usage:")
    print("  chrome-bridge <command> [arguments]")
    print("  chrome-bridge help <command>")
    print("  chrome-bridge <command> --help")
    print("")
    print("Common commands:")
    print("  ping                              Check bridge health")
    print("  getTabs                           List open tabs")
    print("  navigate <url> [--foreground]     Open a tab in the background by default")
    print("  observe <tabId> [filters]         Concise accessibility view with ref=eN ids; --full, --diff")
    print("  click <tabId> <selector>          Click by ref, CSS, text, ARIA name, label, or role")
    print("  fill <tabId> <selector> <text>    Clear and fill a form field")
    print("  screenshot <tabId> <path>         Save a background-safe screenshot")
    print("  github-attach-pr-body <tabId> <files...>")
    print("                                    Edit a GitHub PR body, attach files, and save")
    print("  confirm <token>                   Resume a confirmation-gated action")
    print("  taskSession <operation> ...       Manage task-owned background tabs")
    print("  policy <operation> ...            Inspect or update local policy")
    print("  audit <tail|summary> ...          Read the local audit log written by the host")
    print("  trace <summary|tail> <traceId>    Read a local session trace artifact written by the host")
    print("  searchTabs <query> [--regex]      Search visible text across all http/https tabs")
    print("")
    print("Global flags:")
    print("  --dry-run                         Report the host verdict without touching Chrome")
    print("")
    print("    selectors: CSS, ref=e<N> (from observe), css=<selector>, label=<text>, text=<text>,")
    print("               role=<role>[name=<text>], aria=<accessible-name>,")
    print("               <host> >>> <shadow-selector>, frame=<iframe-selector> >> <target-selector>")
    print("               refs are invalidated by navigation or an extension restart; stale refs fail with error staleRef")


COMMAND_HELP = {
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
    "taskSession": (
        "chrome-bridge taskSession create|navigate|show|state|close ...",
        "Create and manage tabs owned by one task. Set state to working, needs_user, or completed.",
    ),
    "policy": (
        "chrome-bridge policy info|show|doctor|allow-action|allow-origin ...",
        "Inspect the active local policy, explain recent denials, or add a narrow action/origin grant.",
    ),
    "audit": (
        "chrome-bridge audit tail [count] | audit summary [--since <ISO8601|7d|12h|30m>]",
        "Read the local audit log: recent decisions as columns, or aggregate counts. Metadata only, never payloads.",
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
        "Drain buffered frames to numbered image files plus frames.json in outputDir. Prints only the directory, frame count, dropped count, and byte totals; frame data is never printed. With --mp4 the system ffmpeg (never bundled) assembles screencast.mp4 and frames are kept either way.",
    ),
    "stopScreencast": (
        "chrome-bridge stopScreencast <tabId>",
        "Stop the screencast and detach the debugger if nothing else holds it. Any frames still buffered are discarded, so run screencastSave first.",
    ),
    "consoleMessages": (
        "chrome-bridge consoleMessages <tabId> [--source-maps]",
        "Print buffered console entries as JSON. Each entry carries a stack of raw generated frames (url, 0-based lineNumber/columnNumber, functionName). With --source-maps the extension additionally resolves each frame through the script's own source map, adding originalLocation (source, name, 0-based lineNumber/columnNumber) or sourceMapStatus (notFound, invalid, unmapped, crossOriginRefused). Maps are read only from the script's own origin; source text is never fetched for output and never printed.",
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
    global DRY_RUN
    if "--dry-run" in sys.argv[1:]:
        DRY_RUN = True
        sys.argv = [sys.argv[0]] + [a for a in sys.argv[1:] if a != "--dry-run"]

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

    if action == "ping":
        sys.exit(send_command("ping"))
    elif action == "navigate":
        require_args(args, 3, "Missing URL.")
        foreground = len(args) > 3 and args[3] == "--foreground"
        payload = {"url": args[2], "active": foreground}
        sys.exit(send_command("navigate", payload))
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
    elif action == "screenshot":
        require_args(args, 4, "Usage: python3 test_client.py screenshot <tabId> <outputPath> [--visible]")
        visible = len(args) > 4 and args[4] == "--visible"
        sys.exit(save_screenshot(parse_int(args[2], "tabId"), args[3], quiet=not visible))
    elif action == "extractText":
        require_args(args, 3, "Usage: python3 test_client.py extractText <tabId> [maxChars]")
        max_chars = parse_int(args[3], "maxChars") if len(args) > 3 else 20000
        sys.exit(send_command("extractText", {"tabId": parse_int(args[2], "tabId"), "maxChars": max_chars}))
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
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(64)


if __name__ == '__main__':
    main()
