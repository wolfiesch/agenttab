#!/usr/bin/env bash
# Register the native-messaging host with Microsoft Edge (Chromium) on macOS or
# Linux. Edge speaks the same chrome-extension:// origin scheme and the same MV3
# service-worker model as Chrome, so the canonical extension is loaded unchanged.
#
# This script does not create tokens, policies, or extension keys. Run ./setup.sh
# (or ./setup-rs.sh) first; this only adds an Edge registration for the host and
# extension ID that setup already produced. Safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR=""
EXTENSION_ID=""
HOST_PATH=""
CHROME_MANIFEST="$SCRIPT_DIR/com.automation.bridge.json"
EXTENSION_ID_FILE="$SCRIPT_DIR/extension_id.txt"
OUT_DIR="$SCRIPT_DIR/dist/browsers"
PRINT_JSON=0

usage() {
  echo "Usage: ./setup-edge.sh [--extension-id <id>] [--host-path <path>] [--state-dir <path>] [--out-dir <path>] [--print-json]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      if [[ $# -lt 2 ]]; then echo "ERROR: --extension-id requires an id" >&2; exit 2; fi
      EXTENSION_ID="$2"; shift 2 ;;
    --host-path)
      if [[ $# -lt 2 ]]; then echo "ERROR: --host-path requires a path" >&2; exit 2; fi
      HOST_PATH="$2"; shift 2 ;;
    --state-dir)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == --* ]]; then echo "ERROR: --state-dir requires a path" >&2; exit 2; fi
      STATE_DIR="$2"; shift 2 ;;
    --out-dir)
      if [[ $# -lt 2 ]]; then echo "ERROR: --out-dir requires a path" >&2; exit 2; fi
      OUT_DIR="$2"; shift 2 ;;
    --print-json)
      PRINT_JSON=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -n "$STATE_DIR" ]]; then
  STATE_DIR="$(cd "$STATE_DIR" && pwd)"
  CHROME_MANIFEST="$STATE_DIR/com.automation.bridge.json"
  EXTENSION_ID_FILE="$STATE_DIR/extension_id.txt"
fi

if [[ -z "$EXTENSION_ID" ]]; then
  if [[ ! -f "$EXTENSION_ID_FILE" ]]; then
    echo "ERROR: no extension ID. Run ./setup.sh first, or pass --extension-id <id>." >&2
    exit 1
  fi
  EXTENSION_ID="$(tr -d '[:space:]' < "$EXTENSION_ID_FILE")"
fi

if [[ -z "$HOST_PATH" ]]; then
  if [[ -f "$CHROME_MANIFEST" ]]; then
    HOST_PATH="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["path"])' "$CHROME_MANIFEST")"
  else
    HOST_PATH="$SCRIPT_DIR/bridge.py"
  fi
fi

if [[ ! -x "$HOST_PATH" ]]; then
  echo "ERROR: native host is not executable: $HOST_PATH" >&2
  exit 1
fi

python3 "$SCRIPT_DIR/scripts/generate_browser_manifests.py" \
  --browser edge \
  --host-path "$HOST_PATH" \
  --extension-id "$EXTENSION_ID" \
  --out-dir "$OUT_DIR" >/dev/null

EDGE_MANIFEST="$OUT_DIR/edge/com.automation.bridge.json"
echo "Generated Edge host manifest $EDGE_MANIFEST"

case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support"
    HOST_DIRS=(
      "$BASE/Microsoft Edge/NativeMessagingHosts"
      "$BASE/Microsoft Edge Beta/NativeMessagingHosts"
      "$BASE/Microsoft Edge Dev/NativeMessagingHosts"
      "$BASE/Microsoft Edge Canary/NativeMessagingHosts"
    ) ;;
  Linux)
    CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    HOST_DIRS=(
      "$CONFIG_HOME/microsoft-edge/NativeMessagingHosts"
      "$CONFIG_HOME/microsoft-edge-beta/NativeMessagingHosts"
      "$CONFIG_HOME/microsoft-edge-dev/NativeMessagingHosts"
    ) ;;
  *)
    echo "Unsupported OS for Edge auto-registration."
    echo "On Windows, run: powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -Browser Edge"
    echo "Elsewhere, register $EDGE_MANIFEST with Edge's native-messaging host directory manually."
    exit 0 ;;
esac

REGISTERED=0
for HOST_DIR in "${HOST_DIRS[@]}"; do
  mkdir -p "$HOST_DIR"
  ln -sf "$EDGE_MANIFEST" "$HOST_DIR/com.automation.bridge.json"
  echo "Registered Edge native host at $HOST_DIR/com.automation.bridge.json"
  REGISTERED=$((REGISTERED + 1))
done

echo "Registered with $REGISTERED Edge channel(s)."
echo "Load the extension in Edge:"
echo "  1. Open edge://extensions/ and enable Developer mode."
echo "  2. Load unpacked: the same extension directory ./setup.sh printed."
echo "  3. Confirm the loaded ID matches $EXTENSION_ID; a different ID needs a new registration."
echo "  4. Enable only one bridge extension across all browsers; they race for the same host port."
echo "Then run: python3 test_client.py ping"

if [[ "$PRINT_JSON" -eq 1 ]]; then
  python3 - "$EDGE_MANIFEST" "$EXTENSION_ID" "$HOST_PATH" "$REGISTERED" <<'PY'
import json, sys
keys = ("edgeHostManifest", "extensionId", "hostPath", "registeredChannels")
print(json.dumps(dict(zip(keys, sys.argv[1:])), separators=(",", ":")))
PY
fi
