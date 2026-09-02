#!/usr/bin/env bash
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
AVD_NAME="${AVD_NAME:-tie}"

export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"

if ! command -v emulator >/dev/null 2>&1; then
  echo "未找到 emulator。先运行: bash scripts/setup-android-emulator.sh" >&2
  exit 1
fi

if adb devices | rg -q "emulator.*device$"; then
  echo "已有运行中的模拟器: $(adb devices | rg emulator)"
  exit 0
fi

echo "启动 AVD: $AVD_NAME"
emulator -avd "$AVD_NAME" -no-snapshot -gpu auto -no-boot-anim &
disown

echo "等待 adb 连接…"
for _ in $(seq 1 90); do
  if adb devices | rg -q "emulator.*device$"; then
    echo "模拟器已就绪"
    adb devices
    exit 0
  fi
  sleep 2
done

echo "超时：模拟器仍未就绪，请检查 emulator 窗口或日志" >&2
exit 1
