#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" == Linux ]]; then
  "$(dirname "$0")/setup-linux-dev-icon.sh"
fi

exec npx tauri dev
