#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY_PATH="${BRIDGE_EXTENSION_KEY:-$REPO_ROOT/extension_key.pem}"
CHROME_APP="${BRIDGE_CHROME_APP:-Google Chrome}"

extension_id="$(python3 "$REPO_ROOT/extension_identity.py" id --key "$KEY_PATH")"
open -g -a "$CHROME_APP" "chrome-extension://$extension_id/wake.html?reload=1"
printf 'Reload requested for extension %s in %s\n' "$extension_id" "$CHROME_APP"
