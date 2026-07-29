#!/usr/bin/env bash
# Generate per-user secrets, deploy a deterministic local extension, and
# register the Rust native-messaging host. Safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR=""
PRINT_JSON=0
KEY_FILE_PROVIDED=0
TOKEN_FILE="$SCRIPT_DIR/bridge_token.txt"
TOKENS_FILE="$SCRIPT_DIR/bridge_tokens.txt"
POLICY_FILE="$SCRIPT_DIR/bridge_policy.json"
HOST_MANIFEST="$SCRIPT_DIR/com.automation.bridge.rust.json"
TEMPLATE="$SCRIPT_DIR/com.automation.bridge.json.template"
RUST_BIN="$SCRIPT_DIR/host-rs/target/release/bridge-host"
KEY_FILE="$SCRIPT_DIR/extension_key.pem"
LAUNCHER="$SCRIPT_DIR/bridge-host-launch.sh"
HOST_RUNTIME=""
EXTENSION_ID=""
EXTENSION_ID_FILE="$SCRIPT_DIR/extension_id.txt"
HOST_PORT=9223

if command -v cargo >/dev/null 2>&1; then
  TARGET_DIR="$(cargo metadata --format-version 1 --no-deps \
    --manifest-path "$SCRIPT_DIR/host-rs/Cargo.toml" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["target_directory"])' 2>/dev/null || true)"
  if [[ -n "${TARGET_DIR:-}" ]]; then
    RUST_BIN="$TARGET_DIR/release/bridge-host"
  fi
fi

case "$(uname -s)" in
  Darwin) EXT_DIR="$HOME/Library/Application Support/chrome-native-bridge/extension" ;;
  Linux) EXT_DIR="$HOME/.local/share/chrome-native-bridge/extension" ;;
  *) EXT_DIR="$SCRIPT_DIR/extension" ;;
esac

usage() {
  echo "Usage: ./setup-rs.sh [--ext <extension-dir>] [--extension-id <id>] [--key-file <path>] [--state-dir <path>] [--host-port <port>] [--print-json]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ext)
      if [[ $# -lt 2 ]]; then echo "ERROR: --ext requires a path" >&2; exit 2; fi
      EXT_DIR="$2"; shift 2 ;;
    --extension-id)
      if [[ $# -lt 2 ]]; then echo "ERROR: --extension-id requires an id" >&2; exit 2; fi
      EXTENSION_ID="$2"; shift 2 ;;
    --key-file)
      if [[ $# -lt 2 ]]; then echo "ERROR: --key-file requires a path" >&2; exit 2; fi
      KEY_FILE="$2"; KEY_FILE_PROVIDED=1; shift 2 ;;
    --state-dir)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == --* ]]; then echo "ERROR: --state-dir requires a path" >&2; exit 2; fi
      STATE_DIR="$2"; shift 2 ;;
    --host-port)
      if [[ $# -lt 2 ]]; then echo "ERROR: --host-port requires a port" >&2; exit 2; fi
      HOST_PORT="$2"; shift 2 ;;
    --print-json)
      PRINT_JSON=1; shift ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -n "$STATE_DIR" ]]; then
  mkdir -p "$STATE_DIR"
  STATE_DIR="$(cd "$STATE_DIR" && pwd)"
  TOKEN_FILE="$STATE_DIR/bridge_token.txt"
  TOKENS_FILE="$STATE_DIR/bridge_tokens.txt"
  POLICY_FILE="$STATE_DIR/bridge_policy.json"
  HOST_MANIFEST="$STATE_DIR/com.automation.bridge.rust.json"
  LAUNCHER="$STATE_DIR/bridge-host-launch.sh"
  if [[ "$KEY_FILE_PROVIDED" -eq 0 ]]; then
    KEY_FILE="$STATE_DIR/extension_key.pem"
  fi
  EXTENSION_ID_FILE="$STATE_DIR/extension_id.txt"
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  python3 -c "import secrets; print(secrets.token_hex(32))" > "$TOKEN_FILE"
  echo "Generated new bridge token at $TOKEN_FILE"
else
  echo "Existing bridge token kept at $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

if [[ ! -f "$TOKENS_FILE" ]]; then
  : > "$TOKENS_FILE"
  echo "Created empty bridge tokens registry at $TOKENS_FILE"
else
  echo "Existing bridge_tokens.txt kept at $TOKENS_FILE"
fi
chmod 600 "$TOKENS_FILE"

if [[ ! -f "$POLICY_FILE" ]]; then
  cp "$SCRIPT_DIR/bridge_policy.example.json" "$POLICY_FILE"
  echo "Installed default bridge policy at $POLICY_FILE"
else
  echo "Existing bridge_policy.json kept at $POLICY_FILE"
fi
chmod 600 "$POLICY_FILE"

DEPLOYED_EXTENSION=0
if [[ -z "$EXTENSION_ID" ]]; then
  "$SCRIPT_DIR/deploy.sh" --ext "$EXT_DIR" --with-local-key --key-file "$KEY_FILE"
  EXTENSION_ID="$(python3 "$SCRIPT_DIR/extension_identity.py" id --key "$KEY_FILE")"
  DEPLOYED_EXTENSION=1
else
  echo "Using provided extension ID: $EXTENSION_ID"
fi
printf '%s\n' "$EXTENSION_ID" > "$EXTENSION_ID_FILE"
chmod 0644 "$EXTENSION_ID_FILE"
echo "Wrote extension ID $EXTENSION_ID_FILE"

if [[ ! -x "$RUST_BIN" ]]; then
  echo "Build the Rust host first: cargo build --release --manifest-path host-rs/Cargo.toml"
  exit 1
fi

HOST_RUNTIME="$RUST_BIN"
if [[ -n "$STATE_DIR" ]]; then
  HOST_RUNTIME="$STATE_DIR/bridge-host"
  HOST_RUNTIME_TMP="$HOST_RUNTIME.tmp.$$"
  install -m 0755 "$RUST_BIN" "$HOST_RUNTIME_TMP"
  mv -f "$HOST_RUNTIME_TMP" "$HOST_RUNTIME"
  echo "Installed native host runtime $HOST_RUNTIME"
fi

cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
export BRIDGE_PORT="\${BRIDGE_PORT:-$HOST_PORT}"
export BRIDGE_TOKEN_FILE="$TOKEN_FILE"
export BRIDGE_TOKENS_FILE="$TOKENS_FILE"
export BRIDGE_POLICY_FILE="$POLICY_FILE"
export BRIDGE_LOG_FILE="$(dirname "$TOKEN_FILE")/bridge_debug.log"
export BRIDGE_AUDIT_LOG_FILE="$(dirname "$TOKEN_FILE")/bridge_audit.jsonl"
exec "$HOST_RUNTIME" "\$@"
EOF
chmod 0755 "$LAUNCHER"
echo "Wrote launcher $LAUNCHER"

python3 - "$TEMPLATE" "$HOST_MANIFEST" "$LAUNCHER" "$EXTENSION_ID" <<'PY'
import sys
from pathlib import Path
template, out, bridge, ext_id = sys.argv[1:]
text = Path(template).read_text(encoding="utf-8")
text = text.replace("__BRIDGE_PY_PATH__", bridge).replace("__EXTENSION_ID__", ext_id)
Path(out).write_text(text, encoding="utf-8")
PY
echo "Wrote host manifest $HOST_MANIFEST"

case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support"
    HOST_DIRS=(
      "$BASE/Google/Chrome/NativeMessagingHosts"
      "$BASE/ChromeForTesting/NativeMessagingHosts"
      "$BASE/Google/ChromeForTesting/NativeMessagingHosts"
      "$BASE/Google/Chrome for Testing/NativeMessagingHosts"
      "$BASE/Google/Chrome Beta/NativeMessagingHosts"
      "$BASE/Google/Chrome Canary/NativeMessagingHosts"
      "$BASE/Chromium/NativeMessagingHosts"
    ) ;;
  Linux)
    CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    HOST_DIRS=(
      "$CONFIG_HOME/google-chrome/NativeMessagingHosts"
      "$CONFIG_HOME/google-chrome-beta/NativeMessagingHosts"
      "$CONFIG_HOME/chromium/NativeMessagingHosts"
    ) ;;
  *)
    echo "Unsupported OS for auto-registration. Register $HOST_MANIFEST with your browser's native-messaging host mechanism manually."
    if [[ "$DEPLOYED_EXTENSION" -eq 1 ]]; then
      echo "Load unpacked: $EXT_DIR"
    else
      echo "Install or package the extension that owns this ID: $EXTENSION_ID"
      echo "Use the packaged/store extension for this registration; no unpacked extension was deployed."
    fi
    echo "Then run: python3 test_client.py ping"
    if [[ "$PRINT_JSON" -eq 1 ]]; then
      python3 - "$EXT_DIR" "$EXTENSION_ID" "$HOST_MANIFEST" "$POLICY_FILE" "$TOKEN_FILE" "$TOKENS_FILE" "$LAUNCHER" "$HOST_RUNTIME" "$EXTENSION_ID_FILE" "$HOST_PORT" <<'PY'
import json, sys
keys = ("extensionDir", "extensionId", "hostManifest", "policyFile", "tokenFile", "tokensFile", "launcher", "nativeHost", "extensionIdFile", "hostPort")
print(json.dumps(dict(zip(keys, sys.argv[1:])), separators=(",", ":")))
PY
    fi
    exit 0 ;;
esac

REGISTERED=0
for HOST_DIR in "${HOST_DIRS[@]}"; do
  mkdir -p "$HOST_DIR"
  ln -sf "$HOST_MANIFEST" "$HOST_DIR/com.automation.bridge.json"
  echo "Registered native host at $HOST_DIR/com.automation.bridge.json"
  REGISTERED=$((REGISTERED + 1))
done

echo "Registered with $REGISTERED browser variant(s)."
if [[ "$DEPLOYED_EXTENSION" -eq 1 ]]; then
  echo "Load unpacked: $EXT_DIR"
else
  echo "Install or package the extension that owns this ID: $EXTENSION_ID"
  echo "Use the packaged/store extension for this registration; no unpacked extension was deployed."
fi
echo "Then run: python3 test_client.py ping"

if [[ "$PRINT_JSON" -eq 1 ]]; then
  python3 - "$EXT_DIR" "$EXTENSION_ID" "$HOST_MANIFEST" "$POLICY_FILE" "$TOKEN_FILE" "$TOKENS_FILE" "$LAUNCHER" "$HOST_RUNTIME" "$EXTENSION_ID_FILE" "$HOST_PORT" <<'PY'
import json, sys
keys = ("extensionDir", "extensionId", "hostManifest", "policyFile", "tokenFile", "tokensFile", "launcher", "nativeHost", "extensionIdFile", "hostPort")
print(json.dumps(dict(zip(keys, sys.argv[1:])), separators=(",", ":")))
PY
fi
