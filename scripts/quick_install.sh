#!/usr/bin/env bash
# One-line bootstrap: run ./setup.sh from the repository root, probe the bridge,
# and print the exact remaining manual steps (extension load + MCP registration).
# Everything it needs beyond bash is python3, which setup.sh already requires.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

case "$(uname -s)" in
  Darwin) PLATFORM="macOS" ;;
  Linux) PLATFORM="Linux" ;;
  *)
    echo "ERROR: quick_install.sh supports macOS and Linux only (setup.sh cannot auto-register a native host elsewhere)." >&2
    echo "Run ./setup.sh directly and register $REPO_ROOT/com.automation.bridge.json with your browser manually." >&2
    exit 1 ;;
esac

usage() {
  echo "Usage: scripts/quick_install.sh [port]" >&2
  echo "       PORT=<port> scripts/quick_install.sh" >&2
  echo "The port is passed through to ./setup.sh --host-port (default 9223)." >&2
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

# Port passthrough: a positional argument wins over the PORT environment
# variable. Both map onto setup.sh's own --host-port flag; nothing else about
# setup.sh's interface is re-implemented here.
REQUESTED_PORT="${1:-${PORT:-}}"
if [[ -n "$REQUESTED_PORT" && ! "$REQUESTED_PORT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: port must be numeric, got: $REQUESTED_PORT" >&2
  usage
  exit 2
fi

if [[ ! -x "$REPO_ROOT/setup.sh" ]]; then
  echo "ERROR: $REPO_ROOT/setup.sh is missing or not executable." >&2
  exit 1
fi

SETUP_ARGS=(--print-json)
if [[ -n "$REQUESTED_PORT" ]]; then
  SETUP_ARGS+=(--host-port "$REQUESTED_PORT")
fi

echo "Detected $PLATFORM. Running ./setup.sh ${SETUP_ARGS[*]}"
echo ""

SETUP_LOG="$(mktemp "${TMPDIR:-/tmp}/chrome-bridge-quick-install.XXXXXX")"
cleanup() { rm -f "$SETUP_LOG"; }
trap cleanup EXIT

# setup.sh does no XML/plist work (only launchd broker setup does), so it needs
# no PATH reordering here; run it exactly as a user would.
./setup.sh "${SETUP_ARGS[@]}" | tee "$SETUP_LOG"

# --print-json emits a single-line JSON summary as the final line.
SETUP_JSON="$(grep -E '^\{.*\}$' "$SETUP_LOG" | tail -n 1 || true)"
if [[ -z "$SETUP_JSON" ]]; then
  echo "" >&2
  echo "ERROR: setup.sh did not print its JSON summary; cannot report next steps reliably." >&2
  exit 1
fi

EXT_DIR="$(printf '%s' "$SETUP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("extensionDir",""))')"
EXT_ID="$(printf '%s' "$SETUP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("extensionId",""))')"
HOST_PORT="$(printf '%s' "$SETUP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("hostPort","") or "9223")')"

echo ""
echo "Probing the bridge. A failure here is expected until the extension is loaded."
PING_RC=0
python3 test_client.py ping || PING_RC=$?
if [[ "$PING_RC" -eq 0 ]]; then
  echo "Bridge responded: a bridge extension is already loaded and connected."
else
  echo "Bridge not reachable yet (exit $PING_RC). That is normal before the extension is loaded; continue below."
fi

echo ""
echo "Next steps"
echo "=========="
echo "1. Open chrome://extensions/ and turn on Developer mode (top right)."
echo "2. Click 'Load unpacked' and select this directory:"
echo "     $EXT_DIR"
echo "   Expected extension ID: $EXT_ID"
echo "   Enable only one bridge extension at a time; duplicates race for port $HOST_PORT."
echo "3. Verify:"
echo "     cd '$REPO_ROOT' && python3 test_client.py ping"
echo "4. Optional MCP registration. Add this block to your MCP client config"
echo "   (for example mcp/claude_desktop_config.example.json's destination):"
echo ""
python3 - "$REPO_ROOT" "$HOST_PORT" <<'PY'
import json
import os
import sys

root, port = sys.argv[1], sys.argv[2]
block = {
    "mcpServers": {
        "chrome-bridge": {
            "command": "uvx",
            "args": ["--from", os.path.join(root, "mcp"), "chrome-bridge-mcp"],
            "env": {
                "BRIDGE_REPO_ROOT": root,
                "BRIDGE_PORT": port,
            },
        }
    }
}
print(json.dumps(block, indent=2))
PY
echo ""
echo "5. Inspect activity any time with:"
echo "     python3 test_client.py audit tail"
echo "     python3 test_client.py audit summary --since 7d"
