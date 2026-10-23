#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHROME_APP="${AGENTTAB_CHROME_APP:-Google Chrome}"
CHROME_USER_DATA_DIR="${AGENTTAB_CHROME_USER_DATA_DIR:-}"
CHROME_PROFILE_DIRECTORY="${AGENTTAB_CHROME_PROFILE_DIRECTORY:-}"
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
    [--user-data-dir DIR] [--profile-directory NAME] \
    [--debugging-url http://127.0.0.1:PORT]
  scripts/reload_unpacked_extension.sh --live-lifecycle --extension-id ID \
    --socket PATH --debugging-url http://127.0.0.1:PORT --download-dir PATH \
    --host-restart-command '["reviewed-host-restart", "arg"]' \
    [--debugger-idle-wait-seconds SECONDS] [--chrome-app APP]
  scripts/reload_unpacked_extension.sh --print-live-prerequisites

The default form reloads through a supplied loopback DevTools service-worker
target without changing the active tab, or falls back to opening the AgentTab
wake page in the background with reload=1. The wake page is handed to the
Chrome instance that owns the user data directory (the application's default
unless --user-data-dir is given) and opened in every profile there that has
the extension installed, so an unrelated Chrome instance or the last-focused
profile cannot receive it. Use --profile-directory to pick one profile.
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
    --user-data-dir)
      require_value "$1" "${2:-}"
      CHROME_USER_DATA_DIR="$2"
      shift 2
      ;;
    --profile-directory)
      require_value "$1" "${2:-}"
      CHROME_PROFILE_DIRECTORY="$2"
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

if ((LIVE_LIFECYCLE != 0)); then
  open -g -a "$CHROME_APP" "chrome-extension://$EXTENSION_ID/wake.html?reload=1"
else
  default_user_data_dir() {
    case "$1" in
      "Google Chrome") printf '%s\n' "$HOME/Library/Application Support/Google/Chrome" ;;
      "Google Chrome Beta") printf '%s\n' "$HOME/Library/Application Support/Google/Chrome Beta" ;;
      "Google Chrome Dev") printf '%s\n' "$HOME/Library/Application Support/Google/Chrome Dev" ;;
      "Google Chrome Canary") printf '%s\n' "$HOME/Library/Application Support/Google/Chrome Canary" ;;
      "Google Chrome for Testing") printf '%s\n' "$HOME/Library/Application Support/Google/Chrome for Testing" ;;
      "Chromium") printf '%s\n' "$HOME/Library/Application Support/Chromium" ;;
      *) return 1 ;;
    esac
  }

  user_data_dir="$CHROME_USER_DATA_DIR"
  if [[ -z "$user_data_dir" ]] && ! user_data_dir="$(default_user_data_dir "$CHROME_APP")"; then
    printf 'No default user data directory is known for %s; pass --user-data-dir\n' "$CHROME_APP" >&2
    exit 64
  fi

  profiles=()
  if [[ -n "$CHROME_PROFILE_DIRECTORY" ]]; then
    profiles=("$CHROME_PROFILE_DIRECTORY")
  else
    # Every profile listed in Local State whose preferences record the extension.
    while IFS= read -r profile; do
      profiles+=("$profile")
    done < <(
      python3 - "$user_data_dir" "$EXTENSION_ID" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
extension_id = sys.argv[2]
try:
    profiles = json.loads((root / "Local State").read_text())["profile"]["info_cache"]
except (OSError, ValueError, KeyError, TypeError):
    profiles = {}
for profile in sorted(profiles):
    for name in ("Secure Preferences", "Preferences"):
        try:
            settings = json.loads((root / profile / name).read_text())["extensions"]["settings"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if isinstance(settings, dict) and extension_id in settings:
            print(profile)
            break
PY
    )
  fi
  if ((${#profiles[@]} == 0)); then
    printf 'Extension %s is not installed in any Chrome profile under %s; pass --user-data-dir or --profile-directory\n' \
      "$EXTENSION_ID" "$user_data_dir" >&2
    exit 69
  fi

  # `open -n` starts a short-lived Chrome process that forwards the URL to the
  # instance owning the user data directory through Chrome's process singleton.
  # Plain `open -a` sends it to whichever same-named instance macOS picks first,
  # which can be a headless or test Chrome without the extension.
  for profile in "${profiles[@]}"; do
    launch_args=(--profile-directory="$profile")
    if [[ -n "$CHROME_USER_DATA_DIR" ]]; then
      launch_args=(--user-data-dir="$CHROME_USER_DATA_DIR" "${launch_args[@]}")
    fi
    open -g -n -a "$CHROME_APP" --args "${launch_args[@]}" "chrome-extension://$EXTENSION_ID/wake.html?reload=1"
    printf 'AgentTab reload requested in %s profile %s\n' "$CHROME_APP" "$profile"
  done
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
