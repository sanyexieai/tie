#!/usr/bin/env bash
# 安装命令行 Android 模拟器（无需 Android Studio）。Linux x86_64 用 x86_64 镜像更快。
set -euo pipefail

JAVA_HOME="${JAVA_HOME:-$HOME/.local/jdk}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
AVD_NAME="${AVD_NAME:-tie}"
API_LEVEL="${API_LEVEL:-35}"
ABI="${ABI:-x86_64}"

export JAVA_HOME ANDROID_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"

IMAGE="system-images;android-${API_LEVEL};google_apis;${ABI}"

echo "JAVA_HOME=$JAVA_HOME"
echo "ANDROID_HOME=$ANDROID_HOME"
echo "镜像: $IMAGE"

yes | sdkmanager --install emulator "$IMAGE"

if avdmanager list avd | rg -q "Name: ${AVD_NAME}"; then
  echo "AVD ${AVD_NAME} 已存在，跳过创建"
else
  echo no | avdmanager create avd -n "$AVD_NAME" -k "$IMAGE" -d pixel_6 --force
  echo "已创建 AVD: $AVD_NAME"
fi

echo ""
echo "启动模拟器: npm run android:emulator"
echo "或: emulator -avd $AVD_NAME"
