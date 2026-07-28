#!/usr/bin/env python3
import sys
import os
import struct
import json
import logging
import socket
import threading
import uuid
import queue
import time
import re
import fnmatch
import hashlib
import copy
import shlex
import subprocess
from urllib.parse import urlparse

# Resolve paths relative to this script so the install is location-independent.
SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))

# Configure local logging
logging.basicConfig(
    filename=os.environ.get('BRIDGE_LOG_FILE', os.path.join(SCRIPT_DIR, 'bridge_debug.log')),
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# Maps in-flight request id -> queue.Queue the handler thread blocks on for
# the extension's response. The reader thread (main) routes responses here.
pending_requests = {}
requests_lock = threading.Lock()
stdout_lock = threading.Lock()

# Shared-secret auth: every TCP request must include this token. The file is
# created with 0600 perms next to this script; override path via BRIDGE_TOKEN_FILE.
TOKEN_FILE = os.environ.get(
    'BRIDGE_TOKEN_FILE', os.path.join(SCRIPT_DIR, 'bridge_token.txt'))
TOKENS_FILE = os.environ.get(
    'BRIDGE_TOKENS_FILE', os.path.join(SCRIPT_DIR, 'bridge_tokens.txt'))

def load_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except Exception as e:
        logging.error(f"Could not read token file {TOKEN_FILE}: {e}")
        return None

def _file_mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None

# Per-client token registry. The legacy single token (bridge_token.txt) is the
# `default` client; an optional name:token file adds named clients on top.
def load_token_registry():
    registry = {}
    legacy = load_token()
    if legacy:
        registry[legacy] = 'default'
    if os.path.exists(TOKENS_FILE):
        try:
            with open(TOKENS_FILE) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    name, sep, token = line.partition(':')
                    if not sep:
                        continue
                    name, token = name.strip(), token.strip()
                    if name and token:
                        registry[token] = name
        except Exception as e:
            logging.error(f"Could not read tokens file {TOKENS_FILE}: {e}")
    # Record the mtimes observed for both token-file paths (missing -> None).
    mtimes = {TOKEN_FILE: _file_mtime(TOKEN_FILE),
              TOKENS_FILE: _file_mtime(TOKENS_FILE)}
    return registry, mtimes

# Guards both the registry dict and the recorded mtimes; reloads happen under it.
_registry_lock = threading.Lock()
TOKEN_REGISTRY, _registry_mtimes = load_token_registry()

def resolve_client(token):
    # Resolve a token to its client name. On a miss, reload the registry only if
    # a token file's mtime changed (including absent->present) since last load.
    global TOKEN_REGISTRY, _registry_mtimes
    with _registry_lock:
        name = TOKEN_REGISTRY.get(token)
        if name is not None:
            return name
        changed = any(_file_mtime(path) != recorded
                      for path, recorded in _registry_mtimes.items())
        if changed:
            TOKEN_REGISTRY, _registry_mtimes = load_token_registry()
            name = TOKEN_REGISTRY.get(token)
        return name

# Cooperative leasing: at most one client holds an exclusive lease at a time.
# A live lease blocks other clients' non-lease actions with "leased by <owner>".
lease_lock = threading.Lock()
lease_state = {'owner': None, 'expires_at': None}

def now_ms():
    return int(time.time() * 1000)

# Keep-alive: a single TCP connection may carry many newline-delimited
# requests. Idle connections are closed after this many seconds so a
# persistent client can reconnect transparently.
SOCKET_IDLE_TIMEOUT = float(os.environ.get('BRIDGE_SOCKET_IDLE_TIMEOUT', 300))
CONFIRMATION_TTL_MS = int(os.environ.get('BRIDGE_CONFIRMATION_TTL_MS', '60000'))
POLICY_APPROVAL_MODE = os.environ.get(
    'BRIDGE_POLICY_APPROVAL_MODE',
    'gui' if sys.platform == 'darwin' else 'off')
POLICY_APPROVAL_COMMAND = os.environ.get('BRIDGE_POLICY_APPROVAL_COMMAND')
POLICY_APPROVAL_TIMEOUT = float(os.environ.get('BRIDGE_POLICY_APPROVAL_TIMEOUT', '60'))
_confirmation_lock = threading.Lock()
_pending_confirmations = {}
_one_shot_origin_approvals = {}


def confirmation_fingerprint(name, action, payload, targets):
    data = {
        "client": name,
        "action": action,
        "payload": payload,
        "targets": list(targets),
    }
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _prune_confirmations_locked(now=None):
    now = now_ms() if now is None else now
    expired = [tok for tok, entry in _pending_confirmations.items()
               if entry["expires_at"] <= now]
    for tok in expired:
        _pending_confirmations.pop(tok, None)


def issue_confirmation(name, action, payload, targets):
    expires_at = now_ms() + CONFIRMATION_TTL_MS
    token = uuid.uuid4().hex
    fingerprint = confirmation_fingerprint(name, action, payload, targets)
    with _confirmation_lock:
        _prune_confirmations_locked()
        _pending_confirmations[token] = {
            "fingerprint": fingerprint,
            "expires_at": expires_at,
            "client": name,
            "action": action,
            "payload": copy.deepcopy(payload),
            "targets": list(targets),
        }
    return token, expires_at


def resume_confirmation(token):
    """Return the pending action for a token without consuming it.

    The token carries the authority to resume across authenticated local bridge
    identities (for example MCP -> CLI). The original identity is restored, the
    normal policy/origin/lease path runs again, and the fingerprint-bound
    consume step removes the token only immediately before forwarding.
    """
    if not isinstance(token, str) or not token:
        return None
    with _confirmation_lock:
        _prune_confirmations_locked()
        entry = _pending_confirmations.get(token)
        if not entry:
            return None
        return {
            "client": entry.get("client"),
            "action": entry.get("action"),
            "payload": copy.deepcopy(entry.get("payload") or {}),
        }


def consume_confirmation(token, name, action, payload, targets):
    if not isinstance(token, str) or not token:
        return False
    fingerprint = confirmation_fingerprint(name, action, payload, targets)
    with _confirmation_lock:
        _prune_confirmations_locked()
        entry = _pending_confirmations.get(token)
        if not entry or entry["fingerprint"] != fingerprint:
            return False
        _pending_confirmations.pop(token, None)
        return True


def _issue_one_shot_origin_approval(name, action, payload, targets):
    token = uuid.uuid4().hex
    expires_at = now_ms() + CONFIRMATION_TTL_MS
    fingerprint = confirmation_fingerprint(name, action, payload, targets)
    with _confirmation_lock:
        _prune_confirmations_locked()
        _one_shot_origin_approvals[token] = {
            "fingerprint": fingerprint,
            "expires_at": expires_at,
        }
    return token


def _consume_one_shot_origin_approval(token, name, action, payload, targets):
    fingerprint = confirmation_fingerprint(name, action, payload, targets)
    with _confirmation_lock:
        now = now_ms()
        expired = [tok for tok, entry in _one_shot_origin_approvals.items()
                   if entry["expires_at"] <= now]
        for tok in expired:
            _one_shot_origin_approvals.pop(tok, None)
        entry = _one_shot_origin_approvals.get(token)
        if not entry or entry["fingerprint"] != fingerprint:
            return False
        _one_shot_origin_approvals.pop(token, None)
        return True


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        logging.info("Extension disconnected (empty read).")
        sys.exit(0)
    message_length = struct.unpack('@I', raw_length)[0]
    message_data = sys.stdin.buffer.read(message_length).decode('utf-8')
    # Do not log payload bodies: responses can contain cookies/DOM secrets.
    logging.info(f"Read message from extension ({message_length} bytes)")
    return json.loads(message_data)

def write_message(message):
    encoded_message = json.dumps(message).encode('utf-8')
    logging.info(
        f"Forwarding to extension: id={message.get('id')} "
        f"action={message.get('action')} ({len(encoded_message)} bytes)")
    with stdout_lock:
        sys.stdout.buffer.write(struct.pack('@I', len(encoded_message)))
        sys.stdout.buffer.write(encoded_message)
        sys.stdout.buffer.flush()

def _lease_status_locked():
    # Caller holds lease_lock. Returns the live lease snapshot, clearing it if expired.
    owner = lease_state['owner']
    expires_at = lease_state['expires_at']
    if owner is not None and expires_at is not None and now_ms() >= expires_at:
        lease_state['owner'] = None
        lease_state['expires_at'] = None
        owner = None
        expires_at = None
    return owner, expires_at

def handle_lease_action(action, payload, name):
    # Compute the host-side response for lease/release/leaseStatus. Returns a
    # dict to send straight back to the client (never forwarded to the extension).
    with lease_lock:
        owner, expires_at = _lease_status_locked()
        if action == 'lease':
            if owner is not None and owner != name:
                return {"success": False, "error": f"leased by {owner}"}
            try:
                ttl_ms = int(payload.get('ttlMs', 300000))
            except (TypeError, ValueError):
                ttl_ms = 300000
            expires = now_ms() + ttl_ms
            lease_state['owner'] = name
            lease_state['expires_at'] = expires
            return {"success": True, "result": {"owner": name, "expiresAt": expires, "ttlMs": ttl_ms}}
        if action == 'release':
            if owner is not None and owner != name:
                return {"success": False, "error": "not lease owner"}
            if owner is None:
                return {"success": True, "result": {"released": False}}
            lease_state['owner'] = None
            lease_state['expires_at'] = None
            return {"success": True, "result": {"released": True}}
        # leaseStatus: non-mutating snapshot (expired leases already cleared).
        return {"success": True, "result": {"owner": owner, "expiresAt": expires_at, "now": now_ms()}}

# --- Handoff telemetry blackout ---------------------------------------------
# While a waitForHandoff request is in flight through this host, the human is
# typing credentials/2FA codes into the real tab. Any observation action would
# capture that, so the host denies observation for the duration of the handoff
# -- for every client, including the one that started the handoff.
#
# Scope: a handoff whose payload carries a numeric tabId blacks out that tab
# only; a handoff with no tabId is resolved to the active tab by the extension,
# which the host cannot see, so it blacks out ALL tabs (GLOBAL). Symmetrically,
# an observation request with no tabId could land on the blacked-out tab, so it
# is denied by any live handoff. Fail-safe in both directions.
HANDOFF_BLACKOUT_ACTIONS = {
    'screenshot', 'extractText', 'getHTML', 'storageState', 'printToPDF',
    'searchTabs', 'getCurrentState', 'screencastFrames',
    'extractStructured', 'scanPromptInjection', 'consoleMessages',
}
HANDOFF_BLACKOUT_ERROR = 'handoff in progress'

_handoff_lock = threading.Lock()
_handoff_seq = 0
# handle -> {'tabId': int|None (None = GLOBAL), 'startedAt': ms, 'client': name}
_handoff_active = {}


def handoff_tab_id(payload):
    # The numeric tabId a request targets, or None for "the active tab", which
    # only the extension can resolve.
    tab_id = payload.get('tabId') if isinstance(payload, dict) else None
    if isinstance(tab_id, bool) or not isinstance(tab_id, int):
        return None
    return tab_id


def register_handoff(tab_id, client):
    # Called immediately before a waitForHandoff forward; the returned handle
    # must be released in a finally so no exit path leaves a stale blackout.
    global _handoff_seq
    with _handoff_lock:
        _handoff_seq += 1
        handle = _handoff_seq
        _handoff_active[handle] = {
            'tabId': tab_id, 'startedAt': now_ms(), 'client': client}
    return handle


def clear_handoff(handle):
    if handle is None:
        return
    with _handoff_lock:
        _handoff_active.pop(handle, None)


def handoff_blackout(action, payload):
    # True when an in-flight handoff must suppress this observation request.
    if action not in HANDOFF_BLACKOUT_ACTIONS:
        return False
    tab_id = handoff_tab_id(payload)
    with _handoff_lock:
        for record in _handoff_active.values():
            if record['tabId'] is None or tab_id is None or record['tabId'] == tab_id:
                return True
    return False

# --- Host-enforced guardrails: policy, audit, redaction ---------------------
# Policy is enforced in the host request path so every local client (Python or
# Rust host, raw TCP/CLI, MCP) is governed by the same rules before any action
# is forwarded to the extension.

POLICY_FILE = os.environ.get('BRIDGE_POLICY_FILE', os.path.join(SCRIPT_DIR, 'bridge_policy.json'))
AUDIT_LOG_FILE = os.environ.get('BRIDGE_AUDIT_LOG_FILE', os.path.join(SCRIPT_DIR, 'bridge_audit.jsonl'))

# Action classifications. These are advisory tags for policy authors and for
# the default redaction set; deny/allow/confirmation are driven by the policy
# file, not these sets.
SENSITIVE_ACTIONS = {
    'getCookies', 'storageState', 'executeScript', 'executeScriptCDP',
    'startInterception', 'downloadUrl', 'screencastFrames',
}
MUTATING_ACTIONS = {
    'navigate', 'click', 'clickAt', 'type', 'fill', 'hover', 'scroll', 'press', 'drag',
    'select', 'uploadFile', 'activateTab', 'closeTab', 'reload', 'goBack',
    'goForward', 'windowControl', 'setViewport', 'setGeolocation', 'clearGeolocation',
    'setCpuThrottling', 'setNetworkConditions', 'clearNetworkConditions',
    'setColorScheme', 'setUserAgent',
    'setCookie', 'deleteCookie', 'setStorageItem', 'removeStorageItem', 'clearStorage',
    'githubAttachUploadedFiles', 'githubSubmitComment', 'githubAttachPrBody',
    'startInterception', 'stopInterception', 'startMonitoring', 'stopMonitoring',
    'startScreencast', 'stopScreencast',
    'handleDialog', 'downloadUrl', 'batch',
    'createTaskSession', 'navigateTaskSession', 'updateTaskSessionState', 'closeTaskSession',
}
DESTRUCTIVE_ACTIONS = {
    'executeScript', 'executeScriptCDP', 'startInterception', 'downloadUrl',
    'getCookies', 'storageState',
}

# --- Per-site permission modes (policy key ``siteModes``) -------------------
# A site mode is attached to an origin pattern, not to an action:
#   manual - every mutating or high-risk action on a matching origin requires a
#            confirmation token, even when the action is not in
#            ``requireConfirmation``.
#   auto   - no change; ``requireConfirmation`` alone decides.
#   skip   - pre-approve the confirmation gate for a matching origin, so an
#            action listed in ``requireConfirmation`` runs without a token.
# Modes never widen the action or origin gates: a denied action or a denied
# origin still loses, and ``skip`` only relaxes confirmation for actions the
# policy already allows.
SITE_MODES = ('manual', 'auto', 'skip')

# Confirmation gates that ``skip`` may never waive. These read or rewrite real
# profile state (script execution, cookies, web storage, continuous capture) or
# act without an auditable element identity, so an unattended origin-level
# pre-approval must not be able to authorize them.
NON_SKIPPABLE_CONFIRMATIONS = {
    'executeScript', 'executeScriptCDP', 'getCookies', 'storageState',
    'setCookie', 'deleteCookie', 'setStorageItem', 'removeStorageItem',
    'clearStorage', 'startScreencast', 'clickAt',
}


def is_mutating_action(action):
    # What ``manual`` gates: anything that changes browser/page/profile state
    # plus the high-risk reads in the non-skippable set. Fail-safe by policy of
    # the surrounding sets, not by guessing about unknown action names.
    return (action in MUTATING_ACTIONS
            or action in DESTRUCTIVE_ACTIONS
            or action in NON_SKIPPABLE_CONFIRMATIONS)


# Origin-exempt actions: their policy target is NOT the live tab origin, so the
# host must not do a tab-origin lookup for them. navigate/downloadUrl/getCookies
# carry their own target in the payload; the rest are tab-independent or
# host-side. EVERY other forwarded action is treated as tab-scoped and is
# origin-checked against the live tab (fail-safe: a new tab action is protected
# by default rather than silently exempt).
ORIGIN_EXEMPT_ACTIONS = {
    'ping', 'getTabs', 'navigate', 'downloadUrl', 'getCookies', 'sessionStatus',
    'createTaskSession', 'getTaskSessions', 'updateTaskSessionState', 'closeTaskSession',
    'navigateTaskSession', 'batch', 'lease', 'release', 'leaseStatus', 'policyCheck', 'policyInfo',
}

# Actions a socket client may never invoke directly: they are reserved for
# host-internal use (e.g. the tab-origin policy lookup) and are rejected with
# "unknown action" so the reserved surface is not externally reachable.
RESERVED_ACTIONS = {'__tabOrigin'}

TARGET_REQUIRED_ACTIONS = {'navigate', 'navigateTaskSession', 'downloadUrl', 'getCookies'}

# Built-in fail-closed default. A policy file must explicitly opt into browser
# automation beyond host-side liveness/policy/lease operations.
DEFAULT_POLICY = {
    "default": {
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
        "requireConfirmation": [],
        "siteModes": {},
        "redactPatterns": [],
        "secretMaskFile": None,
        "traceDir": None,
        "redact": True,
        "audit": True,
    },
    "clients": {},
}

_policy_lock = threading.Lock()
_policy_cache = DEFAULT_POLICY
_policy_mtime = object()


def load_policy():
    # fail-closed default and logs parse/load errors.
    try:
        with open(POLICY_FILE) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("policy root must be an object")
        return data
    except FileNotFoundError as e:
        logging.error(f"Could not load policy file {POLICY_FILE}: {e}")
        return DEFAULT_POLICY
    except Exception as e:
        logging.error(f"Could not load policy file {POLICY_FILE}: {e}")
        return DEFAULT_POLICY


def current_policy():
    # Cached-with-mtime, matching token reload behavior: reload when the policy
    # file's mtime changes (including absent -> present) so changes take effect
    # without a host restart.
    global _policy_cache, _policy_mtime
    reloaded = False
    with _policy_lock:
        mtime = _file_mtime(POLICY_FILE)
        if mtime != _policy_mtime:
            _policy_cache = load_policy()
            _policy_mtime = mtime
            reloaded = True
        policy = _policy_cache
    if reloaded:
        # Load every configured secretMaskFile at policy load time so masking
        # (including audit masking) is armed before the first response arrives.
        for layer_name in ("default", *(policy.get("clients") or {})):
            load_secret_masks(policy_for_client(policy, layer_name).get('secretMaskFile'))
    return policy


_POLICY_LIST_KEYS = (
    'allowedActions', 'deniedActions', 'allowedOrigins', 'deniedOrigins',
    'requireConfirmation', 'redactPatterns',
)
_POLICY_BOOL_KEYS = ('redact', 'audit')
# String-valued policy keys merged like bools: a later layer replaces the value.
_POLICY_STR_KEYS = ('secretMaskFile', 'traceDir')
# Map-valued policy keys merged PER KEY: a later layer overrides only the origin
# patterns it names and inherits the rest, so a client layer can set one site's
# mode without restating (or silently dropping) the default layer's site modes.
_POLICY_MAP_KEYS = ('siteModes',)


def policy_for_client(policy, name):
    # Merge: built-in default -> policy["default"] -> policy["clients"][name].
    # List overrides replace the inherited list; bool/string overrides replace
    # the inherited value; map overrides merge per key; unknown keys are ignored.
    merged = dict(DEFAULT_POLICY["default"])
    for layer in (policy.get("default"), (policy.get("clients") or {}).get(name)):
        if not isinstance(layer, dict):
            continue
        for key in _POLICY_LIST_KEYS:
            if isinstance(layer.get(key), list):
                merged[key] = list(layer[key])
        for key in _POLICY_BOOL_KEYS:
            if isinstance(layer.get(key), bool):
                merged[key] = layer[key]
        for key in _POLICY_STR_KEYS:
            if isinstance(layer.get(key), str):
                merged[key] = layer[key]
        for key in _POLICY_MAP_KEYS:
            if isinstance(layer.get(key), dict):
                merged[key] = {**(merged.get(key) or {}), **layer[key]}
    return merged


def normalize_url_targets(raw_url):
    # Lowercase scheme/host, preserve explicit port, strip path/query/fragment.
    # Returns [scheme://host[:port], *://host[:port]] or [] for invalid URLs.
    try:
        parsed = urlparse(raw_url)
        scheme = (parsed.scheme or "").lower()
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except Exception:
        return []
    if not scheme or not host:
        return []
    host_part = f"[{host}]" if ":" in host and not host.startswith("[") else host
    if port is not None:
        netloc = f"{host_part}:{port}"
    else:
        netloc = host_part
    return [f"{scheme}://{netloc}", f"*://{netloc}"]


def targets_from_payload(action, payload):
    # Ordered list of normalized policy targets derived from a request payload.
    if not isinstance(payload, dict):
        return []
    if action in ('navigate', 'navigateTaskSession', 'downloadUrl'):
        url = payload.get('url')
        return normalize_url_targets(url) if isinstance(url, str) else []
    if action == 'getCookies':
        domain = payload.get('domain')
        if not isinstance(domain, str):
            return []
        domain = domain.strip()
        while domain.startswith('.'):
            domain = domain[1:].strip()
        domain = domain.lower()
        if not domain or any(ch.isspace() for ch in domain) or any(ch in domain for ch in '/\\:'):
            return []
        parsed = urlparse(f"https://{domain}")
        if (parsed.hostname or "").lower() != domain:
            return []
        return [f"*://{domain}"]
    if action == 'batch':
        targets = []
        steps = payload.get('steps')
        if isinstance(steps, list):
            for step in steps:
                if isinstance(step, dict):
                    targets.extend(targets_from_payload(
                        step.get('action'), step.get('payload') or {}))
        return targets
    return []


def action_matches(patterns, action):
    if not isinstance(patterns, list):
        return False
    return any(fnmatch.fnmatchcase(action, p) for p in patterns if isinstance(p, str))


def target_matches(patterns, targets):
    if not isinstance(patterns, list):
        return False
    for target in targets:
        for p in patterns:
            if isinstance(p, str) and fnmatch.fnmatchcase(target, p):
                return True
    return False


def resolve_site_mode(cp, targets):
    # The site mode governing ``targets``, or None when no configured pattern
    # matches (which is identical in effect to "auto").
    #
    # Specificity, so overlapping patterns are deterministic in both hosts:
    # among all matching patterns pick the LONGEST pattern string, breaking a
    # length tie by the lexicographically smallest pattern. That makes an exact
    # origin ("https://github.com") win over a wildcard ("*://*"). Values
    # outside SITE_MODES are ignored, so a typo cannot silently pre-approve.
    site_modes = cp.get('siteModes')
    if not isinstance(site_modes, dict) or not targets:
        return None
    best = None
    for pattern, mode in site_modes.items():
        if not isinstance(pattern, str) or mode not in SITE_MODES:
            continue
        if not target_matches([pattern], targets):
            continue
        if best is None or (-len(pattern), pattern) < (-len(best[0]), best[0]):
            best = (pattern, mode)
    return best[1] if best else None


def apply_site_mode(site_mode, action, confirm):
    # Fold the site mode into the confirmation requirement. ``manual`` adds a
    # gate, ``skip`` removes one, ``auto``/None leave requireConfirmation alone.
    # Neither mode touches the action or origin gates, and ``skip`` can never
    # waive a non-skippable action, so an unattended pre-approval stays bounded.
    if site_mode == 'manual' and is_mutating_action(action):
        return True
    if site_mode == 'skip' and confirm and action not in NON_SKIPPABLE_CONFIRMATIONS:
        return False
    return confirm


def origin_targets(origin):
    # Convert a tab origin ("https://host[:port]") into policy target strings
    # [scheme://host[:port], *://host[:port]] using the same normalizer as URLs.
    if not isinstance(origin, str) or not origin:
        return []
    return normalize_url_targets(origin)


def policy_constrains_origins(policy, name):
    # True when the client's site policy is non-trivial, i.e. it could allow or
    # deny based on a tab's origin. Lets the host skip the tab-origin lookup
    # round-trip when policy is origin-permissive (deniedOrigins empty and
    # allowedOrigins is exactly ["*"]).
    cp = policy_for_client(policy, name)
    denied = cp.get('deniedOrigins') or []
    allowed = cp.get('allowedOrigins')
    if denied:
        return True
    if allowed != ["*"]:
        return True
    # Site modes are origin-keyed, so a configured siteModes map makes the live
    # tab origin decision-relevant even under an otherwise permissive policy.
    if cp.get('siteModes'):
        return True
    return False


def _step_payloads(payload):
    # Yield (action, payload) for a batch's steps, applying the extension's
    # runBatch defaulting: a top-level batch tabId fills in steps that omit one,
    # so origin policy cannot be bypassed by hoisting tabId to the batch payload.
    default_tab = (payload or {}).get('tabId')
    steps = (payload or {}).get('steps')
    if not isinstance(steps, list):
        return
    for step in steps:
        step = step if isinstance(step, dict) else {}
        s_payload = dict(step.get('payload') or {})
        if s_payload.get('tabId') is None and default_tab is not None:
            s_payload['tabId'] = default_tab
        yield (step.get('action') or ''), s_payload


def tab_ids_needed(action, payload):
    # The set of tabId keys (int or None for the active tab) whose live origin
    # the host must resolve to apply site policy to a tab-scoped request. Returns
    # an empty set for origin-exempt actions. ``None`` means "resolve the active
    # tab". Recurses into batch steps with runBatch tabId defaulting.
    payload = payload if isinstance(payload, dict) else {}
    if action == 'batch':
        needed = set()
        for s_action, s_payload in _step_payloads(payload):
            needed |= tab_ids_needed(s_action, s_payload)
        return needed
    if action in ORIGIN_EXEMPT_ACTIONS:
        return set()
    return {payload.get('tabId')}


def evaluate_policy(policy, name, action, payload, origins=None):
    # Returns (allowed, reason, confirmation_required, redact_enabled,
    # audit_enabled, targets). Precedence: denied action -> allowed action ->
    # denied target -> allowed target -> confirmation requirement, with the
    # matching origin's site mode (``siteModes``) folded into that last step.
    # ``origins`` maps a tabId (int, or None for the active tab) to that tab's
    # live origin string; for tab-scoped actions the matching origin is folded
    # into the site-policy targets so policy applies even with no URL in payload.
    cp = policy_for_client(policy, name)
    redact_enabled = cp.get('redact', True)
    audit_enabled = cp.get('audit', True)
    origins = origins or {}
    targets = targets_from_payload(action, payload)
    if action not in ORIGIN_EXEMPT_ACTIONS:
        tab_origin = origins.get((payload or {}).get('tabId'))
        if tab_origin:
            targets = targets + origin_targets(tab_origin)

    # Reserved host-internal actions are never client-invokable, including as a
    # batch step (runBatch would otherwise dispatch them). Deny centrally here.
    if action in RESERVED_ACTIONS:
        return (False, f"action {action} denied", False, redact_enabled, audit_enabled, targets)
    if action in TARGET_REQUIRED_ACTIONS and not targets:
        return (False, "target unresolved", False, redact_enabled, audit_enabled, targets)


    # Apply action-level policy to the action itself first.
    if action_matches(cp.get('deniedActions'), action):
        return (False, f"action {action} denied", False, redact_enabled, audit_enabled, targets)
    allowed_actions = cp.get('allowedActions')
    if not action_matches(allowed_actions, action):
        return (False, f"action {action} not allowed", False, redact_enabled, audit_enabled, targets)
    confirm = action_matches(cp.get('requireConfirmation'), action)
    # Per-site permission mode. Applied to the confirmation requirement only,
    # and only after the action gates: every deny path below returns
    # confirm=False explicitly, so a deny still outranks any mode.
    confirm = apply_site_mode(resolve_site_mode(cp, targets), action, confirm)

    # For batch, only inspect steps once the batch action itself is allowed and
    # does not require confirmation.
    if action == 'batch':
        if confirm:
            return (True, None, True, redact_enabled, audit_enabled, targets)
        step_confirm = False
        for i, (s_action, s_payload) in enumerate(_step_payloads(payload)):
            s_allowed, s_reason, s_confirm, _, _, s_targets = evaluate_policy(
                policy, name, s_action, s_payload, origins=origins)
            if not s_allowed:
                return (False, f"batch step {i}: {s_reason}", False,
                        redact_enabled, audit_enabled, s_targets)
            step_confirm = step_confirm or s_confirm
        return (True, None, step_confirm, redact_enabled, audit_enabled, targets)

    # Target (site) policy for non-batch actions.
    denied_origins = cp.get('deniedOrigins')
    allowed_origins = cp.get('allowedOrigins')
    if targets and target_matches(denied_origins, targets):
        return (False, "target denied", False, redact_enabled, audit_enabled, targets)
    if targets and not target_matches(allowed_origins, targets):
        return (False, "target not allowed", False, redact_enabled, audit_enabled, targets)
    return (True, None, confirm, redact_enabled, audit_enabled, targets)


# Upper bound on a policyCheck plan preflight, so one request cannot make the
# host evaluate an unbounded step list.
PLAN_PREVIEW_MAX_STEPS = 50


def policy_verdict(policy, name, action, payload, origin=None):
    # The verdict object shared by policyCheck (single and plan forms) and by
    # dry-run responses. ``origin`` is an optional hypothetical tab origin: when
    # given, tab-scoped actions are evaluated against it and the verdict is no
    # longer origin-dependent, since the caller has already supplied the origin
    # the real request would carry.
    action = action if isinstance(action, str) else ""
    payload = payload if isinstance(payload, dict) else {}
    needed = tab_ids_needed(action, payload)
    origins = {t: origin for t in needed} if isinstance(origin, str) and origin else None
    allowed, reason, confirm, redact_enabled, audit_enabled, targets = evaluate_policy(
        policy, name, action, payload, origins=origins)
    verdict = {
        "allowed": allowed,
        "reason": reason,
        "confirmationRequired": confirm,
        "redact": redact_enabled,
        "audit": audit_enabled,
        "originDependent": bool(needed and policy_constrains_origins(policy, name) and not origins),
        # The origin's resolved site mode, or null when no origin is known yet
        # (no target resolved) or no configured pattern matches it.
        "siteMode": resolve_site_mode(policy_for_client(policy, name), targets),
    }
    return verdict, targets


def plan_step_verdicts(policy, name, plan):
    # Evaluate each preflight step exactly like a single policyCheck, tagged
    # with its index. Non-object steps evaluate as the empty action, which the
    # action gate denies, so a malformed plan reports per-step instead of
    # failing the whole request.
    out = []
    for i, step in enumerate(plan):
        step = step if isinstance(step, dict) else {}
        verdict, _targets = policy_verdict(
            policy, name, step.get("action"), step.get("payload"), step.get("origin"))
        entry = {"step": i, "action": step.get("action") if isinstance(step.get("action"), str) else ""}
        entry.update(verdict)
        out.append(entry)
    return out


def policy_denial(reason, action, targets, name, policy=None):
    # Build a structured, actionable companion to the opaque "policy denied:
    # <reason>" error string. The error string itself stays byte-stable for API
    # and contract compatibility; this object tells a client exactly what to
    # grant, in which list, in which section, and in which file. ``kind``
    # classifies the gate that rejected the request so a client can self-service
    # the right fix.
    batch_step = None
    m = re.match(r"^batch step (\d+): (.*)$", reason or "")
    if m:
        batch_step = int(m.group(1))
        reason = m.group(2)
    # For action-type reasons the real action is embedded in the reason text
    # ("action <X> not allowed"/"... denied"); the outer ``action`` may be
    # "batch" for a denied step, so trust the reason for the action value.
    am = re.match(r"^action (\S+) (?:not allowed|denied)$", reason or "")
    if am:
        action = am.group(1)
    def section_for(list_key):
        # policy_for_client replaces an inherited list when the client layer
        # defines its own, so a fix must edit the section that actually governs
        # this client: clients.<name>.<list> when present, else default.<list>.
        client_layer = ((policy or {}).get("clients") or {}).get(name)
        if isinstance(client_layer, dict) and isinstance(client_layer.get(list_key), list):
            return f"clients.{name}"
        return "default"
    if reason and reason.endswith("not allowed") and reason.startswith("action "):
        kind = "action"
        section = section_for("allowedActions")
        remediation = f"Add {action!r} to {section}.allowedActions in {POLICY_FILE}"
        suggested = {"op": "add", "section": section, "list": "allowedActions", "value": action}
    elif reason == "target not allowed":
        kind = "origin"
        sample = targets[0] if targets else None
        section = section_for("allowedOrigins")
        remediation = (
            f"Add an origin pattern covering {sample!r} to {section}.allowedOrigins in {POLICY_FILE}"
            if sample else
            f"Add the request origin to {section}.allowedOrigins in {POLICY_FILE}")
        suggested = {"op": "add", "section": section, "list": "allowedOrigins", "value": sample} if sample else None
    elif reason == "target denied":
        kind = "origin"
        sample = targets[0] if targets else None
        section = section_for("deniedOrigins")
        cp = policy_for_client(policy or {}, name)
        matched = [p for p in (cp.get("deniedOrigins") or [])
                   if isinstance(p, str) and target_matches([p], targets)]
        remediation = (
            f"Remove or narrow the {section}.deniedOrigins pattern(s) {matched} matching {sample!r} in {POLICY_FILE}"
            if matched else
            f"Remove or narrow the matching {section}.deniedOrigins pattern in {POLICY_FILE}")
        suggested = {"op": "removePattern", "section": section, "list": "deniedOrigins",
                     "value": sample, "patterns": matched} if matched else None
    elif reason and reason.endswith("denied") and reason.startswith("action "):
        kind = "action"
        section = section_for("deniedActions")
        cp = policy_for_client(policy or {}, name)
        matched = [p for p in (cp.get("deniedActions") or [])
                   if isinstance(p, str) and action_matches([p], action)]
        remediation = f"Remove or narrow the {section}.deniedActions pattern(s) {matched} matching {action!r} in {POLICY_FILE}"
        suggested = {"op": "removePattern", "section": section, "list": "deniedActions",
                     "value": action, "patterns": matched}
    elif reason == "target unresolved" or reason == "tab origin unresolved":
        kind = "target"
        remediation = (
            "The request carried no resolvable target origin; supply a valid "
            "url/domain/tabId so site policy can be evaluated")
        suggested = None
    else:
        kind = "other"
        remediation = f"Review default policy in {POLICY_FILE}"
        suggested = None
    return {
        "kind": kind,
        "action": action,
        "targets": list(targets or []),
        "policyFile": POLICY_FILE,
        "client": name,
        "remediation": remediation,
        "suggestedPatch": suggested,
        "batchStep": batch_step,
        "cli": "chrome-bridge policy doctor",
    }


def _origin_grant_section(policy, name):
    client_layer = ((policy or {}).get("clients") or {}).get(name)
    if isinstance(client_layer, dict) and isinstance(client_layer.get("allowedOrigins"), list):
        return ("clients", name)
    return ("default", None)


def _policy_with_origin_grant(policy, name, origin):
    cloned = json.loads(json.dumps(policy or {}))
    container_kind, client_name = _origin_grant_section(cloned, name)
    if container_kind == "clients":
        section = cloned.setdefault("clients", {}).setdefault(client_name, {})
    else:
        section = cloned.setdefault("default", {})
    origins = section.setdefault("allowedOrigins", [])
    if origin not in origins:
        origins.append(origin)
    return cloned


def _persist_origin_grant(policy, name, origin):
    updated = _policy_with_origin_grant(policy, name, origin)
    encoded = json.dumps(updated, indent=2) + "\n"
    fd = os.open(POLICY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(encoded)
            fd = None
    finally:
        if fd is not None:
            os.close(fd)
    global _policy_cache, _policy_mtime
    with _policy_lock:
        _policy_cache = updated
        _policy_mtime = _file_mtime(POLICY_FILE)
    return updated


def _approval_origin(targets):
    for target in targets or []:
        if isinstance(target, str) and target.startswith(("http://", "https://", "*://")):
            return target
    return None


def _policy_approval_enabled():
    mode = (POLICY_APPROVAL_MODE or "off").lower()
    if mode in {"", "off", "none", "false", "0"}:
        return False
    if mode == "command":
        return bool(POLICY_APPROVAL_COMMAND)
    if mode == "gui":
        return sys.platform == "darwin"
    return False


def _run_policy_approval_prompt(name, action, origin, targets):
    mode = (POLICY_APPROVAL_MODE or "off").lower()
    if mode in {"", "off", "none", "false", "0"}:
        return "deny"
    env = os.environ.copy()
    env.update({
        "CHROME_BRIDGE_APPROVAL_CLIENT": name,
        "CHROME_BRIDGE_APPROVAL_ACTION": action,
        "CHROME_BRIDGE_APPROVAL_ORIGIN": origin or "",
        "CHROME_BRIDGE_APPROVAL_TARGETS": json.dumps(list(targets or [])),
        "CHROME_BRIDGE_POLICY_FILE": POLICY_FILE,
    })
    try:
        if mode == "command":
            if not POLICY_APPROVAL_COMMAND:
                return "deny"
            proc = subprocess.run(
                shlex.split(POLICY_APPROVAL_COMMAND),
                text=True,
                capture_output=True,
                timeout=POLICY_APPROVAL_TIMEOUT,
                env=env,
            )
            if proc.returncode != 0:
                logging.warning("Policy approval command failed: %s", proc.stderr.strip())
                return "deny"
            decision = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "deny"
        elif mode == "gui" and sys.platform == "darwin":
            message = (
                f"Chrome Bridge is trying to access {origin} for action {action}. "
                "Do you want to deny, allow this time, or always allow this origin?"
            )
            script = (
                'button returned of (display dialog '
                f'{json.dumps(message)} '
                'with title "Chrome Bridge Policy Approval" '
                'buttons {"Deny", "Allow This Time", "Always Allow"} '
                'default button "Deny" cancel button "Deny")'
            )
            proc = subprocess.run(
                ["osascript", "-e", script],
                text=True,
                capture_output=True,
                timeout=POLICY_APPROVAL_TIMEOUT,
                env=env,
            )
            if proc.returncode != 0:
                return "deny"
            decision = proc.stdout.strip()
        else:
            return "deny"
    except Exception as exc:
        logging.warning("Policy approval prompt failed: %s", exc)
        return "deny"
    normalized = decision.strip().lower().replace(" ", "_").replace("-", "_")
    if normalized in {"allow_this_time", "allow_once", "once"}:
        return "allow_once"
    if normalized in {"always_allow", "allow_always", "always"}:
        return "always_allow"
    return "deny"


def maybe_apply_origin_approval(policy, name, action, payload, targets, audit_enabled):
    origin = _approval_origin(targets)
    if not origin:
        return None
    decision = _run_policy_approval_prompt(name, action, origin, targets)
    if decision == "allow_once":
        token = _issue_one_shot_origin_approval(name, action, payload, targets)
        if _consume_one_shot_origin_approval(token, name, action, payload, targets):
            _audit(audit_enabled, name, action, targets, "origin_approval_once", origin, None)
            return _policy_with_origin_grant(policy, name, origin)
    if decision == "always_allow":
        updated = _persist_origin_grant(policy, name, origin)
        _audit(audit_enabled, name, action, targets, "origin_approval_persisted", origin, None)
        return updated
    _audit(audit_enabled, name, action, targets, "origin_approval_denied", origin, None)
    return None


# --- Secret masking (policy ``secretMaskFile``) ---------------------------
#
# A local file of ``name=value`` lines (mode 600 expected) whose values are
# literally masked out of every outbound response string and every audit event,
# so a credential the agent typed into a page can never be echoed back to the
# client or persisted to the audit log.
_secret_mask_lock = threading.RLock()
_secret_mask_cache = {}    # path -> (mtime, [(name, value), ...])
_secret_mask_warned = set()  # paths already warned about (warn once)
_secret_mask_known = {}    # value -> name, union of everything ever loaded


def load_secret_masks(path):
    # Parse ``name=value`` lines from the policy's secretMaskFile. Blank lines
    # and ``#`` comments are ignored; a missing/unreadable file disables masking
    # for that path after one warning. Cached by mtime like the policy itself,
    # so edits apply without a host restart. Entries are ordered longest value
    # first so an overlapping shorter secret cannot pre-empt a longer one.
    if not isinstance(path, str) or not path:
        return []
    with _secret_mask_lock:
        mtime = _file_mtime(path)
        cached = _secret_mask_cache.get(path)
        if cached is not None and cached[0] == mtime:
            return cached[1]
        entries = []
        try:
            with open(path) as f:
                lines = f.read().splitlines()
        except Exception as e:
            if path not in _secret_mask_warned:
                _secret_mask_warned.add(path)
                logging.warning(f"Could not load secretMaskFile {path}: {e}")
                write_audit_event({
                    "ts": now_ms(),
                    "client": None,
                    "action": "secretMaskFile",
                    "targets": [path],
                    "decision": "secret_mask_unavailable",
                    "reason": str(e),
                    "requestId": None,
                })
            _secret_mask_cache[path] = (mtime, [])
            return []
        _secret_mask_warned.discard(path)
        for line in lines:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            name, _, value = line.partition('=')
            name, value = name.strip(), value.strip()
            if not name or not value:
                continue
            entries.append((name, value))
            _secret_mask_known[value] = name
        entries.sort(key=lambda e: len(e[1]), reverse=True)
        _secret_mask_cache[path] = (mtime, entries)
        return entries


def _known_secret_masks():
    # Every (name, value) pair loaded so far, longest value first. Used to keep
    # secrets out of audit events, which have no per-client policy context.
    with _secret_mask_lock:
        entries = [(n, v) for v, n in _secret_mask_known.items()]
    entries.sort(key=lambda e: len(e[1]), reverse=True)
    return entries


def mask_secret_text(text, secrets):
    for name, value in secrets:
        if value and value in text:
            text = text.replace(value, f"<masked:{name}>")
    return text


def mask_secrets_value(value, secrets):
    # Recursively replace every exact secret occurrence in string leaves.
    if not secrets:
        return value
    if isinstance(value, str):
        return mask_secret_text(value, secrets)
    if isinstance(value, dict):
        return {k: mask_secrets_value(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [mask_secrets_value(v, secrets) for v in value]
    return value


_audit_write_lock = threading.Lock()


def write_audit_event(event):
    # Append one JSON line. Never writes payload/response bodies, and never any
    # known secretMaskFile value (a denial reason can quote a target). A write
    # failure is logged but never blocks browser automation.
    try:
        event = mask_secrets_value(event, _known_secret_masks())
        line = json.dumps(event) + "\n"
        with _audit_write_lock:
            with open(AUDIT_LOG_FILE, 'a') as f:
                f.write(line)
    except Exception as e:
        logging.error(f"Could not write audit event to {AUDIT_LOG_FILE}: {e}")


def _audit(audit_enabled, client, action, targets, decision, reason, request_id):
    if not audit_enabled:
        return
    write_audit_event({
        "ts": now_ms(),
        "client": client,
        "action": action,
        "targets": targets,
        "decision": decision,
        "reason": reason,
        "requestId": request_id,
    })


# --- Session trace artifacts (policy ``traceDir``) --------------------------
#
# When a policy layer sets ``traceDir``, the host appends exactly one JSONL
# event per trace-eligible request to <traceDir>/<traceId>.jsonl, after the
# request is fully processed (success, host denial, extension error, timeout).
# The artifact is metadata only -- decision, timing, tab ids, and content
# hashes -- so a trace answers "what did this session do, and did the page
# change" without ever storing what was read, typed, or returned. No payload
# body, no response body, no tokens.

TRACE_SESSION_ACTIONS = {'createTaskSession', 'navigateTaskSession', 'closeTaskSession'}

# Trace file names are derived from caller-supplied ids, so everything outside
# this set collapses to "_" and the name is capped: a traceId can never escape
# traceDir or grow into an unbounded path component.
_TRACE_SAFE_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
_TRACE_ID_MAX = 80

# Response keys whose array values are an observe snapshot (or its diff). Their
# hash lets a reader tell "the page changed" from "the page is unchanged"
# without the snapshot itself ever being written.
_TRACE_SNAPSHOT_KEYS = ('nodes', 'snapshot', 'diff')

_trace_write_lock = threading.Lock()


def trace_id_for(action, payload, response):
    # The trace this request belongs to, or None when it is not trace-eligible.
    # Priority: explicit traceId, then the session the request names, then the
    # session a createTaskSession response just minted, then the session verb.
    payload = payload if isinstance(payload, dict) else {}
    for key in ('traceId', 'sessionId', 'taskSessionId'):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    result = response.get('result') if isinstance(response, dict) else None
    if isinstance(result, dict):
        value = result.get('sessionId')
        if isinstance(value, str) and value:
            return value
    if action in TRACE_SESSION_ACTIONS:
        return action
    return None


def sanitize_trace_id(trace_id):
    cleaned = ''.join(ch if ch in _TRACE_SAFE_CHARS else '_' for ch in str(trace_id))
    return cleaned[:_TRACE_ID_MAX] or '_'


def trace_dir_for(policy, name):
    # Resolve the client's traceDir. A relative path resolves against the host
    # install directory, matching how the policy and audit paths behave.
    value = policy_for_client(policy, name).get('traceDir')
    if not isinstance(value, str) or not value.strip():
        return None
    path = os.path.expanduser(value.strip())
    if not os.path.isabs(path):
        path = os.path.join(SCRIPT_DIR, path)
    return path


def trace_targets(action, payload, response):
    # Tab ids only: a trace records which tabs an action touched, never their
    # URLs or titles.
    out = []

    def add(value):
        if isinstance(value, bool) or not isinstance(value, int):
            return
        if value not in out:
            out.append(value)

    sources = [payload if isinstance(payload, dict) else {}]
    if action == 'batch':
        sources.extend(step_payload for _, step_payload in _step_payloads(payload))
    result = response.get('result') if isinstance(response, dict) else None
    if isinstance(result, dict):
        sources.append(result)
    for source in sources:
        if not isinstance(source, dict):
            continue
        add(source.get('tabId'))
        ids = source.get('tabIds')
        if isinstance(ids, list):
            for value in ids:
                add(value)
    return sorted(out)


def trace_hash(value):
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def trace_snapshot_subobject(response):
    if not isinstance(response, dict):
        return None
    for source in (response.get('result'), response):
        if not isinstance(source, dict):
            continue
        sub = {k: source[k] for k in _TRACE_SNAPSHOT_KEYS if isinstance(source.get(k), list)}
        if sub:
            return sub
    return None


def write_trace_event(trace_dir, trace_id, event):
    # Append one JSON line under the same write-lock discipline as the audit
    # log. A write failure is logged but never blocks browser automation.
    try:
        os.makedirs(trace_dir, exist_ok=True)
        path = os.path.join(trace_dir, sanitize_trace_id(trace_id) + '.jsonl')
        line = json.dumps(event) + "\n"
        with _trace_write_lock:
            with open(path, 'a') as f:
                f.write(line)
    except Exception as e:
        logging.error(f"Could not write trace event to {trace_dir}: {e}")


def trace_request(policy, client, action, payload, response, decision, reason,
                  request_id, started_ms):
    # Exactly one event per fully-processed, trace-eligible request. Secret
    # masking is applied before hashing and before anything is written, so a
    # known credential cannot reach the artifact even through a hash preimage.
    if policy is None or not client:
        return
    trace_dir = trace_dir_for(policy, client)
    if not trace_dir:
        return
    trace_id = trace_id_for(action, payload, response)
    if not trace_id:
        return
    secrets = _known_secret_masks()
    safe_response = mask_secrets_value(response, secrets) if isinstance(response, dict) else {}
    snapshot = trace_snapshot_subobject(safe_response)
    write_trace_event(trace_dir, trace_id, {
        "ts": now_ms(),
        "client": client,
        "action": action,
        "decision": decision,
        "reason": mask_secret_text(reason, secrets) if isinstance(reason, str) else reason,
        "requestId": request_id,
        "durationMs": max(0, now_ms() - started_ms),
        "targets": trace_targets(action, payload, response),
        "traceId": trace_id,
        "responseHash": trace_hash(safe_response),
        "snapshotHash": trace_hash(snapshot) if snapshot is not None else None,
        "success": bool(safe_response.get("success")) if isinstance(safe_response, dict) else False,
    })


_REDACT_KEY_SUBSTRINGS = ('token', 'secret', 'password', 'cookie', 'session', 'csrf', 'auth')


def _redact_storage_value(value):
    if isinstance(value, dict):
        name = value.get('name')
        if isinstance(name, str) and any(s in name.lower() for s in _REDACT_KEY_SUBSTRINGS) and 'value' in value:
            out = dict(value)
            out['value'] = "<redacted>"
            return out
        out = {}
        for k, v in value.items():
            if isinstance(k, str) and any(s in k.lower() for s in _REDACT_KEY_SUBSTRINGS):
                out[k] = "<redacted>"
            else:
                out[k] = _redact_storage_value(v)
        return out
    if isinstance(value, list):
        return [_redact_storage_value(v) for v in value]
    return value

# Response fields that carry page-derived content and so are subject to
# policy ``redactPatterns`` masking before reaching the client.
_CONTENT_REDACT_FIELDS = ('html', 'text', 'val', 'value', 'result')


def _compile_patterns(patterns):
    # Compile policy redactPatterns into regexes, skipping invalid ones (logged
    # once). Patterns are matched case-sensitively; authors use inline flags
    # (e.g. (?i)) for case-insensitivity.
    compiled = []
    if not isinstance(patterns, list):
        return compiled
    for p in patterns:
        if not isinstance(p, str) or not p:
            continue
        try:
            compiled.append(re.compile(p))
        except re.error as e:
            logging.error(f"Invalid redactPattern {p!r}: {e}")
    return compiled


def _mask_text(text, compiled):
    for rx in compiled:
        text = rx.sub("<redacted>", text)
    return text


def _redact_content_value(value, compiled):
    if isinstance(value, str):
        return _mask_text(value, compiled)
    if isinstance(value, dict):
        return {k: _redact_content_value(v, compiled) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_content_value(v, compiled) for v in value]
    return value


def redact_response(action, response, redact_enabled, patterns=None, payload=None, secrets=None):
    # Redact sensitive response values before returning them to socket clients,
    # then mask literal secretMaskFile values in every remaining string. Secret
    # masking is independent of the policy ``redact`` toggle: those values are
    # known credentials and must never leave the host, redaction on or off.
    out = _redact_response_patterns(action, response, redact_enabled, patterns, payload)
    return mask_secrets_value(out, secrets)


def _redact_response_patterns(action, response, redact_enabled, patterns=None, payload=None):
    # Operates on a returned copy; never mutates audit/queue/routing structures.
    if not redact_enabled or not isinstance(response, dict):
        return response
    if action == 'batch':
        steps = (payload or {}).get('steps') if isinstance(payload, dict) else None
        result = response.get('result')
        if not isinstance(result, list):
            return response
        fallback_patterns = _compile_patterns(patterns)
        def redact_unknown_batch_item(item):
            return _redact_content_value(item, fallback_patterns) if fallback_patterns else item
        if not isinstance(steps, list):
            out = dict(response)
            out['result'] = [redact_unknown_batch_item(item) for item in result]
            return out
        redacted = []
        for i, item in enumerate(result):
            if i >= len(steps):
                redacted.append(redact_unknown_batch_item(item))
                continue
            step = steps[i]
            step_action = step.get('action') if isinstance(step, dict) else None
            if not isinstance(step_action, str):
                redacted.append(redact_unknown_batch_item(item))
                continue
            step_payload = step.get('payload') if isinstance(step.get('payload'), dict) else {}
            wrapped = _redact_response_patterns(step_action, {"result": item}, redact_enabled, patterns, step_payload)
            redacted.append(wrapped.get("result", item) if isinstance(wrapped, dict) else item)
        out = dict(response)
        out['result'] = redacted
        return out
    if action == 'getCookies':
        result = response.get('result')
        cookies = None
        container = None
        if isinstance(result, dict) and isinstance(result.get('cookies'), list):
            cookies, container = result.get('cookies'), 'result'
        elif isinstance(result, list):
            cookies, container = result, 'result-list'
        elif isinstance(response.get('cookies'), list):
            cookies, container = response.get('cookies'), 'response'
        if cookies is None:
            return response
        redacted = []
        for c in cookies:
            if isinstance(c, dict):
                c = dict(c)
                if 'value' in c:
                    c['value'] = "<redacted>"
            redacted.append(c)
        out = dict(response)
        if container == 'result':
            new_result = dict(result)
            new_result['cookies'] = redacted
            out['result'] = new_result
        elif container == 'result-list':
            out['result'] = redacted
        else:
            out['cookies'] = redacted
        return out
    if action == 'storageState':
        out = dict(response)
        if 'result' in out:
            out['result'] = _redact_storage_value(out['result'])
        return out
    # Content-bearing actions: mask policy redactPatterns in page-derived text.
    if action in (
        'getHTML', 'extractText', 'executeScript', 'executeScriptCDP',
        'searchTabs', 'extractStructured', 'scanPromptInjection', 'consoleMessages',
    ):
        compiled = _compile_patterns(patterns)
        if not compiled:
            return response
        out = dict(response)
        for field in _CONTENT_REDACT_FIELDS:
            if field in out:
                out[field] = _redact_content_value(out[field], compiled)
        return out
    return response

def forward_to_extension(cmd, resp_timeout, on_registered=None):
    # Send one command to the extension and block until its response or timeout.
    # Returns (req_id, response_dict | None). ``on_registered(req_id)`` runs
    # after the request id is registered but before write_message, so callers
    # can emit the "allow" audit event with the generated id before the action
    # is actually forwarded. Used for normal forwards and host-internal lookups.
    req_id = str(uuid.uuid4())
    cmd["id"] = req_id
    response_queue = queue.Queue(maxsize=1)
    with requests_lock:
        pending_requests[req_id] = response_queue
    if on_registered is not None:
        on_registered(req_id)
    write_message(cmd)
    try:
        return req_id, response_queue.get(timeout=resp_timeout)
    except queue.Empty:
        with requests_lock:
            pending_requests.pop(req_id, None)
        return req_id, None


def resolve_origins(tab_ids, resp_timeout):
    # Resolve each needed tabId (int, or None for the active tab) to its live
    # origin via the reserved __tabOrigin extension action. Returns a dict
    # {tabId: origin_string_or_None}. We prefer the full tab ``url`` over the
    # extension's ``origin`` because JS URL.origin strips explicit default ports
    # (https://x:443 -> https://x); normalize_url_targets() preserves them, so a
    # port-scoped origin policy stays effective for tab-scoped actions. A
    # failed/timed-out lookup maps to None, which is fail-closed under a
    # non-trivial allowedOrigins policy.
    origins = {}
    for tab_id in tab_ids:
        payload = {} if tab_id is None else {"tabId": tab_id}
        _, resp = forward_to_extension({"action": "__tabOrigin", "payload": payload}, resp_timeout)
        origin = None
        if isinstance(resp, dict) and resp.get("success"):
            result = resp.get("result")
            if isinstance(result, dict):
                origin = result.get("url") or result.get("origin")
        origins[tab_id] = origin
    return origins

def handle_socket_client(client_socket):
    # Serve many newline-delimited requests on one connection. Each request is
    # forwarded to the extension and its response awaited via a per-request
    # queue before the next request is read, preserving request/response order.
    buffer = b""
    # Per-request trace context, refreshed for every line read on this
    # connection. ``respond`` is the single terminal exit for a request: it
    # writes at most one trace event and then sends the response line, so a
    # traced request can never produce two events or none.
    trace_ctx = {"client": None, "action": None, "payload": None, "started": now_ms()}

    def respond(resp, decision, reason=None, request_id=None):
        trace_request(current_policy(), trace_ctx["client"], trace_ctx["action"],
                      trace_ctx["payload"], resp, decision, reason, request_id,
                      trace_ctx["started"])
        client_socket.sendall((json.dumps(resp) + "\n").encode('utf-8'))

    try:
        client_socket.settimeout(SOCKET_IDLE_TIMEOUT)
        while True:
            # Read until we have at least one complete line (TCP may split/coalesce).
            while b"\n" not in buffer:
                try:
                    chunk = client_socket.recv(65536)
                except socket.timeout:
                    return  # idle too long; drop the connection
                if not chunk:
                    return  # client closed
                buffer += chunk

            line, buffer = buffer.split(b"\n", 1)
            if not line.strip():
                continue  # tolerate blank keep-alive lines
            cmd = json.loads(line.decode('utf-8'))

            # Resolve the client by its token; unknown/missing token is rejected.
            name = resolve_client(cmd.get("token"))
            if name is None:
                logging.warning("Rejected unauthenticated/invalid-token request.")
                client_socket.sendall(
                    (json.dumps({"success": False, "error": "unauthorized"}) + "\n").encode('utf-8'))
                return
            cmd.pop("token", None)  # never forward the secret to the extension
            confirmation_token = cmd.pop("confirmationToken", None)
            # Request-level dry run: never forwarded to the extension, and never
            # left in the command even when false.
            dry_run = cmd.pop("dryRun", None) is True

            action = cmd.get("action")
            trace_ctx.update({"client": name, "action": action,
                              "payload": cmd.get("payload") or {}, "started": now_ms()})

            # Dry run stops before any state change: no confirmation resume, no
            # lease acquisition, no interactive origin approval, no tab-origin
            # lookup (that is itself an extension round-trip), and no forward.
            # It reports the verdict the request would meet right now.
            if dry_run:
                if action in RESERVED_ACTIONS:
                    logging.warning(f"Rejected reserved action from client: {action}")
                    policy = current_policy()
                    audit_enabled = policy_for_client(policy, name).get('audit', True)
                    _audit(audit_enabled, name, action, [], "deny", "unknown action", None)
                    respond({"success": False, "error": f"unknown action: {action}"},
                            "deny", "unknown action")
                    continue
                policy = current_policy()
                verdict, targets = policy_verdict(policy, name, action, cmd.get("payload") or {})
                with lease_lock:
                    owner, _ = _lease_status_locked()
                lease_blocked = owner is not None and owner != name
                if lease_blocked:
                    verdict["allowed"] = False
                    verdict["reason"] = f"leased by {owner}"
                # A live handoff blackout outranks policy and lease: the request
                # would be denied before policy evaluation, so say so here.
                if handoff_blackout(action, cmd.get("payload") or {}):
                    verdict["allowed"] = False
                    verdict["reason"] = HANDOFF_BLACKOUT_ERROR
                    verdict["blackout"] = True
                # Host-answered actions resolve without Chrome, so they would
                # never forward even when fully allowed.
                host_side = action in ('lease', 'release', 'leaseStatus', 'policyCheck', 'policyInfo', 'confirm')
                would_forward = bool(
                    verdict["allowed"] and not verdict["confirmationRequired"] and not host_side)
                _audit(verdict["audit"], name, action, targets, "dry_run", verdict["reason"], None)
                respond({
                    "success": True,
                    "dryRun": True,
                    "wouldForward": would_forward,
                    "action": action,
                    "targets": targets,
                    "verdict": verdict,
                }, "dry_run", verdict["reason"])
                continue

            # Token-only confirmation resume. The host keeps the original
            # action/payload for the short token TTL, then sends it through the
            # full policy, live-origin, lease, and confirmation checks again.
            # This lets CLI/MCP users resume safely without reconstructing JSON.
            if action == 'confirm':
                resume_payload = cmd.get("payload")
                resume_token = resume_payload.get("confirmationToken") if isinstance(resume_payload, dict) else None
                resumed = resume_confirmation(resume_token)
                if resumed is None:
                    policy = current_policy()
                    audit_enabled = policy_for_client(policy, name).get('audit', True)
                    _audit(audit_enabled, name, "confirm", [], "confirmation_deny", "invalid or expired confirmation token", None)
                    respond({
                        "success": False,
                        "error": "invalid or expired confirmation token",
                    }, "confirmation_deny", "invalid or expired confirmation token")
                    continue
                confirmation_token = resume_token
                requester_name = name
                name = resumed["client"]
                action = resumed["action"]
                cmd = {"action": action, "payload": resumed["payload"]}
                # The resumed action is the one that gets traced, under the
                # client that originally asked for it.
                trace_ctx.update({"client": name, "action": action,
                                  "payload": resumed["payload"]})
                policy = current_policy()
                audit_enabled = policy_for_client(policy, requester_name).get('audit', True)
                _audit(audit_enabled, requester_name, "confirm", [], "confirmation_resume", None, None)

            # Reserved host-internal actions (e.g. __tabOrigin) are never
            # reachable from socket clients; reject them as unknown so the
            # internal surface cannot be driven or probed externally.
            if action in RESERVED_ACTIONS:
                logging.warning(f"Rejected reserved action from client: {action}")
                policy = current_policy()
                audit_enabled = policy_for_client(policy, name).get('audit', True)
                _audit(audit_enabled, name, action, [], "deny", "unknown action", None)
                respond({"success": False, "error": f"unknown action: {action}"},
                        "deny", "unknown action")
                continue

            # Lease control actions are answered host-side, never forwarded.
            if action in ('lease', 'release', 'leaseStatus'):
                resp = handle_lease_action(action, cmd.get("payload") or {}, name)
                policy = current_policy()
                audit_enabled = policy_for_client(policy, name).get('audit', True)
                decision = "lease_allow" if resp.get("success") else "lease_deny"
                _audit(audit_enabled, name, action, [], decision, resp.get("error"), None)
                respond(resp, decision, resp.get("error"))
                continue

            policy = current_policy()

            # policyCheck is host-side: report what the policy would decide for a
            # target action/payload without forwarding it to the extension.
            if action == 'policyCheck':
                pc_payload = cmd.get("payload") or {}
                # Plan preflight: one verdict per proposed step, evaluated
                # independently against the current policy. Nothing is forwarded
                # and no state changes, so an agent can price a whole plan before
                # touching the browser.
                plan = pc_payload.get("plan")
                if isinstance(plan, list):
                    audit_enabled = policy_for_client(policy, name).get('audit', True)
                    if len(plan) > PLAN_PREVIEW_MAX_STEPS:
                        _audit(audit_enabled, name, "policyCheck", [], "deny",
                               f"plan exceeds {PLAN_PREVIEW_MAX_STEPS} steps", None)
                        respond({
                            "success": False,
                            "error": f"plan exceeds {PLAN_PREVIEW_MAX_STEPS} steps",
                        }, "deny", f"plan exceeds {PLAN_PREVIEW_MAX_STEPS} steps")
                        continue
                    resp = {"success": True, "result": {"plan": plan_step_verdicts(policy, name, plan)}}
                    _audit(audit_enabled, name, "policyCheck", [], "allow", None, None)
                    respond(resp, "allow")
                    continue
                target_action = pc_payload.get("action") or ""
                target_payload = pc_payload.get("payload") or {}
                allowed, reason, confirm, redact_enabled, audit_enabled, targets = evaluate_policy(
                    policy, name, target_action, target_payload)
                # Without forwarding, the host cannot see the live tab origin, so
                # for an origin-constrained policy a tab-scoped action's verdict
                # is provisional: the real request will additionally be checked
                # against the tab origin. Report that so callers don't trust an
                # "allowed" that origin policy may still deny.
                origin_dependent = bool(
                    tab_ids_needed(target_action, target_payload)
                    and policy_constrains_origins(policy, name))
                resp = {"success": True, "result": {
                    "allowed": allowed,
                    "reason": reason,
                    "confirmationRequired": confirm,
                    "redact": redact_enabled,
                    "audit": audit_enabled,
                    "originDependent": origin_dependent,
                    "siteMode": resolve_site_mode(policy_for_client(policy, name), targets),
                }}
                _audit(audit_enabled, name, "policyCheck", targets, "allow", None, None)
                respond(resp, "allow")
                continue

            # policyInfo is host-side and always answerable (handled before the
            # action gate, like policyCheck) so a client can always discover the
            # active policy file path even when the current policy would deny
            # everything else. It deliberately returns ONLY the path and its
            # existence -- never policy contents -- so a token holder cannot use
            # it to enumerate allowed/denied origins. The CLI reads the file
            # directly (it is mode 600, owned by the same user) for details.
            if action == 'policyInfo':
                cp = policy_for_client(policy, name)
                audit_enabled = cp.get('audit', True)
                resp = {"success": True, "result": {
                    "policyFile": POLICY_FILE,
                    "policyFileExists": os.path.exists(POLICY_FILE),
                    "auditLogFile": AUDIT_LOG_FILE,
                    "traceDir": trace_dir_for(policy, name),
                    "client": name,
                }}
                _audit(audit_enabled, name, "policyInfo", [], "allow", None, None)
                respond(resp, "allow")
                continue

            payload = cmd.get("payload") or {}
            audit_enabled = policy_for_client(policy, name).get('audit', True)

            # Handoff telemetry blackout runs BEFORE policy evaluation: while a
            # human is completing a login/2FA/captcha step, no client may observe
            # the tab, no matter what policy would otherwise allow.
            if handoff_blackout(action, payload):
                _audit(audit_enabled, name, action, [], "handoff_blackout",
                       HANDOFF_BLACKOUT_ERROR, None)
                respond({
                    "success": False,
                    "error": HANDOFF_BLACKOUT_ERROR,
                    "blackout": True,
                }, "handoff_blackout", HANDOFF_BLACKOUT_ERROR)
                continue

            # Host-enforced policy, phase 1: action-level and payload-target
            # checks that need no extension round-trip. Plain policy denial still
            # wins over leases for payload-determined targets, but interactive
            # origin approval is deferred behind lease ownership so a non-owner
            # cannot pop UI or mutate policy for an action that cannot run.
            allowed, reason, confirm, redact_enabled, audit_enabled, targets = evaluate_policy(
                policy, name, action, payload)
            if not allowed and reason == "target not allowed" and _policy_approval_enabled():
                with lease_lock:
                    owner, _ = _lease_status_locked()
                if owner is not None and owner != name:
                    _audit(audit_enabled, name, action, targets, "lease_deny", f"leased by {owner}", None)
                    respond({"success": False, "error": f"leased by {owner}"},
                            "lease_deny", f"leased by {owner}")
                    continue
                approved_policy = maybe_apply_origin_approval(policy, name, action, payload, targets, audit_enabled)
                if approved_policy is not None:
                    policy = approved_policy
                    allowed, reason, confirm, redact_enabled, audit_enabled, targets = evaluate_policy(
                        policy, name, action, payload)
            if not allowed:
                _audit(audit_enabled, name, action, targets, "deny", reason, None)
                respond({"success": False, "error": f"policy denied: {reason}",
                         "policyDenial": policy_denial(reason, action, targets, name, policy)},
                        "deny", reason)
                continue

            resp_timeout = SOCKET_IDLE_TIMEOUT
            if isinstance(payload, dict):
                req_timeout_ms = payload.get("timeoutMs")
                if isinstance(req_timeout_ms, (int, float)) and req_timeout_ms > 0:
                    resp_timeout = max(SOCKET_IDLE_TIMEOUT, req_timeout_ms / 1000 + 30)

            # Phase 2: tab-origin policy for tab-scoped actions. The live origin
            # comes from a host-internal __tabOrigin lookup, so the lease gate
            # runs first (a non-owner must not trigger any extension round-trip),
            # then origin-aware re-evaluation runs before the confirmation check
            # so a denied origin wins over a confirmation requirement.
            needed = tab_ids_needed(action, payload) if policy_constrains_origins(policy, name) else set()
            if needed:
                with lease_lock:
                    owner, _ = _lease_status_locked()
                if owner is not None and owner != name:
                    _audit(audit_enabled, name, action, targets, "lease_deny", f"leased by {owner}", None)
                    respond({"success": False, "error": f"leased by {owner}"},
                            "lease_deny", f"leased by {owner}")
                    continue
                origins = resolve_origins(needed, resp_timeout)
                # Fail closed when any needed tab resolves to no usable origin
                # target: lookup failure, no such tab, or an opaque origin (the
                # string "null"/"" -> origin_targets() == []). Under an
                # origin-constraining policy such a request must not proceed,
                # since an allow-list can never match an absent target.
                if any(not origin_targets(origins.get(t)) for t in needed):
                    targets = targets + ["<unresolved-origin>"]
                    _audit(audit_enabled, name, action, targets, "deny", "tab origin unresolved", None)
                    respond({"success": False, "error": "policy denied: tab origin unresolved",
                             "policyDenial": policy_denial("tab origin unresolved", action, targets, name, policy)},
                            "deny", "tab origin unresolved")
                    continue
                allowed, reason, confirm, redact_enabled, audit_enabled, targets = evaluate_policy(
                    policy, name, action, payload, origins=origins)
                if not allowed and reason == "target not allowed" and _policy_approval_enabled():
                    approved_policy = maybe_apply_origin_approval(policy, name, action, payload, targets, audit_enabled)
                    if approved_policy is not None:
                        policy = approved_policy
                        allowed, reason, confirm, redact_enabled, audit_enabled, targets = evaluate_policy(
                            policy, name, action, payload, origins=origins)
                if not allowed:
                    _audit(audit_enabled, name, action, targets, "deny", reason, None)
                    respond({"success": False, "error": f"policy denied: {reason}",
                             "policyDenial": policy_denial(reason, action, targets, name, policy)},
                            "deny", reason)
                    continue

            # A confirmation that a ``skip`` site mode waived is still recorded:
            # under an unattended pre-approval the audit log is the only place a
            # human later sees that no confirmation was asked for.
            if not confirm and action_matches(
                    policy_for_client(policy, name).get('requireConfirmation'), action):
                site_mode = resolve_site_mode(policy_for_client(policy, name), targets)
                if site_mode == 'skip':
                    _audit(audit_enabled, name, action, targets, "confirmation_waived",
                           "siteMode skip", None)

            if confirm:
                if consume_confirmation(confirmation_token, name, action, payload, targets):
                    _audit(audit_enabled, name, action, targets, "confirmation_accepted", None, None)
                else:
                    token, expires_at = issue_confirmation(name, action, payload, targets)
                    _audit(audit_enabled, name, action, targets, "confirmation_required", None, None)
                    respond({
                        "success": False,
                        "error": "confirmation required",
                        "confirmationRequired": True,
                        "action": action,
                        "targets": targets,
                        "confirmationToken": token,
                        "expiresAt": expires_at,
                        "resumeCommand": f"chrome-bridge confirm {token}",
                    }, "confirmation_required")
                    continue

            # Enforcement gate: a live lease held by another client blocks others.
            with lease_lock:
                owner, _ = _lease_status_locked()
            if owner is not None and owner != name:
                _audit(audit_enabled, name, action, targets, "lease_deny", f"leased by {owner}", None)
                respond({"success": False, "error": f"leased by {owner}"},
                        "lease_deny", f"leased by {owner}")
                continue

            # Send to extension, then block this connection until its response.
            # Most actions resolve well within SOCKET_IDLE_TIMEOUT, but waits and
            # human-handoff carry a payload timeoutMs that can exceed it; cover
            # that window (plus headroom) so the host does not time out before
            # the extension legitimately finishes.
            # Audit "allow" with the generated id before the action is forwarded.
            # A waitForHandoff forward opens a telemetry blackout for the whole
            # time the human is interacting with the tab; the finally releases it
            # on every exit path (response, extension error, or timeout).
            handoff_handle = None
            if action == 'waitForHandoff':
                handoff_handle = register_handoff(handoff_tab_id(payload), name)
            try:
                req_id, response = forward_to_extension(
                    cmd, resp_timeout,
                    on_registered=lambda rid: _audit(audit_enabled, name, action, targets, "allow", None, rid))
            finally:
                clear_handoff(handoff_handle)
            if response is None:
                logging.error(f"Timed out waiting for extension response to {req_id}.")
                _audit(audit_enabled, name, action, targets, "extension_error", "extension response timeout", req_id)
                respond({"success": False, "error": "extension response timeout"},
                        "extension_error", "extension response timeout", req_id)
                return
            ext_decision = "extension_success" if response.get("success") else "extension_error"
            _audit(audit_enabled, name, action, targets, ext_decision, response.get("error"), req_id)
            client_policy = policy_for_client(policy, name)
            secrets = load_secret_masks(client_policy.get('secretMaskFile'))
            response = redact_response(action, response, redact_enabled,
                                       client_policy.get('redactPatterns'), payload, secrets)
            # Trace the response the client actually receives: already redacted
            # and secret-masked, so the hash covers no raw page content.
            respond(response, ext_decision, response.get("error"), req_id)
    except Exception as e:
        logging.error(f"Error handling socket client: {e}", exc_info=True)
    finally:
        try:
            client_socket.close()
        except Exception:
            pass

def socket_server_loop():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    port = int(os.environ.get('BRIDGE_PORT', 9223))
    try:
        server.bind(('127.0.0.1', port))
    except OSError as e:
        # Almost always means a second copy of this host is already running
        # (e.g. both the old /tmp extension and the new stable one are enabled,
        # racing to bind the same port). Make it loud instead of a silent death.
        logging.error(
            f"FATAL: could not bind 127.0.0.1:{port} ({e}). Another bridge host is "
            f"likely already running. Disable the duplicate Chrome extension so only "
            f"one host owns this port. This host will not accept CLI commands.")
        os._exit(1)
    server.listen(5)
    logging.info(f"TCP socket server listening on 127.0.0.1:{port}")
    while True:
        try:
            client_sock, addr = server.accept()
            logging.info(f"Accepted connection from {addr}")
            t = threading.Thread(target=handle_socket_client, args=(client_sock,), daemon=True)
            t.start()
        except Exception as e:
            logging.error(f"Error in socket server accept: {e}", exc_info=True)

def main():
    logging.info(
        "Native Messaging Host started: pid=%s port=%s parentPid=%s",
        os.getpid(),
        os.environ.get('BRIDGE_PORT', '9223'),
        os.getppid(),
    )
    # Start the local TCP listener thread
    t = threading.Thread(target=socket_server_loop, daemon=True)
    t.start()
    
    while True:
        try:
            msg = read_message()
            # If the extension sent a response to a command we initiated
            msg_id = msg.get("id")
            if msg_id:
                response_queue = None
                with requests_lock:
                    response_queue = pending_requests.pop(msg_id, None)
                if response_queue is not None:
                    response_queue.put(msg)
                    logging.info(f"Routed response for request ID {msg_id} to its socket handler.")
                else:
                    logging.info(f"Received message with ID {msg_id} but no pending request was found.")
            else:
                logging.info(f"Received message from Chrome with no ID: {msg}")
        except Exception as e:
            logging.error(f"Error in main loop: {e}", exc_info=True)
            break

if __name__ == '__main__':
    main()
