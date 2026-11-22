#!/usr/bin/env bash
# 兼容旧入口；跨平台请用: npm run tauri
set -euo pipefail
exec node "$(dirname "$0")/tauri-dev.mjs" "$@"
