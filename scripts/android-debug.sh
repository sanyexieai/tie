#!/usr/bin/env bash
# 自动连接 Android 设备/模拟器，安装并进入调试（或仅构建安装）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAVA_HOME="${JAVA_HOME:-$HOME/.local/jdk}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
APP_ID="${APP_ID:-com.tie.knowledge}"
DEV_PORT=1420

export JAVA_HOME ANDROID_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

INSTALL_ONLY=false
EXTRA_ARGS=()

usage() {
  cat <<'EOF'
用法: npm run android:debug [-- 额外 tauri 参数]
      npm run android:debug -- --install-only

默认：无设备则启动模拟器 → adb reverse → tauri android dev（热更新调试）

选项:
  --install-only  仅 release 构建并 adb install -r（不启动 dev server）
  -h, --help      显示帮助

示例:
  npm run android:debug
  npm run android:debug -- --install-only
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-only)
      INSTALL_ONLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

adb_has_device() {
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ [[:space:]]device$ ]] && return 0
  done < <(adb devices 2>/dev/null | tail -n +2)
  return 1
}

ensure_device() {
  if adb_has_device; then
    echo "已连接设备:"
    adb devices | tail -n +2
    return 0
  fi
  echo "未检测到 adb 设备，尝试启动模拟器…"
  bash "$ROOT/scripts/start-android-emulator.sh"
}

setup_adb_reverse() {
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    id="${line%%[[:space:]]*}"
    [[ -z "$id" ]] && continue
    adb -s "$id" reverse "tcp:${DEV_PORT}" "tcp:${DEV_PORT}" 2>/dev/null || true
  done < <(adb devices 2>/dev/null | tail -n +2 | grep '[[:space:]]device$')
}

find_apksigner() {
  local candidate
  for candidate in \
    "$ANDROID_HOME/build-tools"/*/apksigner \
    "$ANDROID_HOME/cmdline-tools/latest/bin/apksigner"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

sign_apk_if_needed() {
  local apk="$1"
  if [[ "$apk" != *unsigned* ]]; then
    echo "$apk"
    return 0
  fi
  local keystore="${ANDROID_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
  if [[ ! -f "$keystore" ]]; then
    echo "Release APK 未签名且未找到 debug.keystore：$keystore" >&2
    return 1
  fi
  local apksigner
  apksigner="$(find_apksigner)" || {
    echo "未找到 apksigner，请安装 Android SDK build-tools" >&2
    return 1
  }
  local signed="${TMPDIR:-/tmp}/tie-android-debug-signed.apk"
  cp "$apk" "$signed"
  "$apksigner" sign \
    --ks "$keystore" \
    --ks-pass pass:android \
    --key-pass pass:android \
    --out "$signed" \
    "$signed"
  echo "$signed"
}

find_release_apk() {
  local dir="$ROOT/src-tauri/gen/android/app/build/outputs/apk/universal/release"
  local apk=""
  shopt -s nullglob
  for path in "$dir"/*-signed.apk "$dir"/app-universal-release.apk "$dir"/*release*.apk; do
    if [[ -f "$path" && "$path" != *unsigned* ]]; then
      apk="$path"
      break
    fi
  done
  if [[ -z "$apk" ]]; then
    for path in "$dir"/*unsigned*.apk "$dir"/*.apk; do
      if [[ -f "$path" ]]; then
        apk="$path"
        break
      fi
    done
  fi
  shopt -u nullglob
  [[ -n "$apk" ]] || return 1
  echo "$apk"
}

launch_app() {
  adb shell am start -n "${APP_ID}/.MainActivity" >/dev/null 2>&1 \
    || adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
    || true
}

ensure_device
setup_adb_reverse

if "$INSTALL_ONLY"; then
  echo "构建 Release APK…"
  cd "$ROOT"
  npm run tauri:android:build
  apk="$(find_release_apk)" || {
    echo "未找到 APK，请检查 src-tauri/gen/android/app/build/outputs/apk/" >&2
    exit 1
  }
  apk="$(sign_apk_if_needed "$apk")" || exit 1
  echo "安装: $apk"
  adb install -r "$apk"
  launch_app
  echo "已安装并尝试启动 Tie（$APP_ID）"
  exit 0
fi

echo "启动 Android 开发调试（tauri android dev）…"
exec node "$ROOT/scripts/tauri-android-dev.mjs" "${EXTRA_ARGS[@]}"
