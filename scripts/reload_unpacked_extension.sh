#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHROME_APP="${AGENTTAB_CHROME_APP:-Google Chrome}"
EXTENSION_ID=""
LIVE_LIFECYCLE=0
SOCKET_PATH=""
DEBUGGING_URL=""
DOWNLOAD_DIR=""
HOST_RESTART_COMMAND=""
DEBUGGER_IDLE_WAIT_SECONDS=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/reload_unpacked_extension.sh [--extension-id ID] [--chrome-app APP] \
    [--debugging-url http://127.0.0.1:PORT]
  scripts/reload_unpacked_extension.sh --live-lifecycle --extension-id ID \
    --socket PATH --debugging-url http://127.0.0.1:PORT --download-dir PATH \
    --host-restart-command '["reviewed-host-restart", "arg"]' \
    [--debugger-idle-wait-seconds SECONDS] [--chrome-app APP]
  scripts/reload_unpacked_extension.sh --print-live-prerequisites

The default form reloads through a supplied loopback DevTools service-worker
target without changing the active tab, or falls back to opening the AgentTab
wake page in the background with reload=1.
The live form runs the explicit, interactive PR3 lifecycle probe only after the
candidate is already loaded into a disposable trusted macOS Chrome profile.
It does not request or remove Chrome permissions; each permission, pause,
disable, and restoration transition is performed by the human through Chrome
or AgentTab UI when prompted.
USAGE
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    printf '%s requires a value\n' "$option" >&2
    exit 64
  fi
}

while (($#)); do
  case "$1" in
    --extension-id)
      require_value "$1" "${2:-}"
      EXTENSION_ID="$2"
      shift 2
      ;;
    --chrome-app)
      require_value "$1" "${2:-}"
      CHROME_APP="$2"
      shift 2
      ;;
    --live-lifecycle)
      LIVE_LIFECYCLE=1
      shift
      ;;
    --socket)
      require_value "$1" "${2:-}"
      SOCKET_PATH="$2"
      shift 2
      ;;
    --debugging-url)
      require_value "$1" "${2:-}"
      DEBUGGING_URL="$2"
      shift 2
      ;;
    --download-dir)
      require_value "$1" "${2:-}"
      DOWNLOAD_DIR="$2"
      shift 2
      ;;
    --host-restart-command)
      require_value "$1" "${2:-}"
      HOST_RESTART_COMMAND="$2"
      shift 2
      ;;
    --debugger-idle-wait-seconds)
      require_value "$1" "${2:-}"
      DEBUGGER_IDLE_WAIT_SECONDS="$2"
      shift 2
      ;;
    --print-live-prerequisites)
      exec python3 "$REPO_ROOT/tests/architecture/verify_permissions.py" --print-live-prerequisites
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

if [[ -n "$EXTENSION_ID" ]]; then
  if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
    printf '%s\n' '--extension-id must be the 32-character Chrome extension ID' >&2
    exit 64
  fi
else
  EXTENSION_ID="$(
    python3 -c \
      'import json, pathlib, sys; print(json.loads(pathlib.Path(sys.argv[1]).read_text())["developmentExtension"]["id"])' \
      "$REPO_ROOT/config/identity.json"
  )"
fi

if ((LIVE_LIFECYCLE != 0)) && [[ -z "$SOCKET_PATH" || -z "$DEBUGGING_URL" || -z "$DOWNLOAD_DIR" || -z "$HOST_RESTART_COMMAND" ]]; then
  printf '%s\n' '--live-lifecycle requires --socket, --debugging-url, --download-dir, and --host-restart-command' >&2
  usage >&2
  exit 64
fi

if ((LIVE_LIFECYCLE == 0)) && [[ -n "$DEBUGGING_URL" ]]; then
  exec python3 "$REPO_ROOT/tests/architecture/verify_permissions.py" \
    --request-extension-reload \
    --extension-id "$EXTENSION_ID" \
    --debugging-url "$DEBUGGING_URL"
fi

open -g -a "$CHROME_APP" "chrome-extension://$EXTENSION_ID/wake.html?reload=1"

if ((LIVE_LIFECYCLE == 0)); then
  printf '%s\n' 'AgentTab reload requested in the selected Chrome application'
  exit 0
fi

live_args=(
  python3 "$REPO_ROOT/tests/architecture/verify_permissions.py"
  --live-lifecycle
  --interactive
  --candidate-dir "$REPO_ROOT/packages/extension/dist"
  --extension-id "$EXTENSION_ID"
  --socket "$SOCKET_PATH"
  --debugging-url "$DEBUGGING_URL"
  --download-dir "$DOWNLOAD_DIR"
  --extension-reload-script "$SCRIPT_DIR/reload_unpacked_extension.sh"
  --host-restart-command "$HOST_RESTART_COMMAND"
  --runs 3
)
if [[ -n "$DEBUGGER_IDLE_WAIT_SECONDS" ]]; then
  live_args+=(--debugger-idle-wait-seconds "$DEBUGGER_IDLE_WAIT_SECONDS")
fi
exec "${live_args[@]}"
