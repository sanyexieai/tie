#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_DIR="$ROOT/src-tauri/gen/android/app/build/outputs/apk/universal/release"
OUT_DIR="${1:-$ROOT/release-artifacts-android}"
VERSION="${GITHUB_REF_NAME:-local}"
VERSION="${VERSION#v}"

mkdir -p "$OUT_DIR"

shopt -s nullglob
candidates=(
  "$APK_DIR"/*-signed.apk
  "$APK_DIR"/app-universal-release.apk
  "$APK_DIR"/*release*.apk
)

apk=""
for path in "${candidates[@]}"; do
  if [[ -f "$path" && "$path" != *unsigned* ]]; then
    apk="$path"
    break
  fi
done

if [[ -z "$apk" ]]; then
  for path in "$APK_DIR"/*unsigned*.apk "$APK_DIR"/*.apk; do
    if [[ -f "$path" ]]; then
      apk="$path"
      break
    fi
  done
fi

if [[ -z "$apk" ]]; then
  echo "No Android APK found under $APK_DIR"
  find "$ROOT/src-tauri/gen/android/app/build/outputs" -name '*.apk' -print 2>/dev/null || true
  exit 1
fi

suffix="android-universal"
if [[ "$apk" == *unsigned* ]]; then
  suffix="android-universal-unsigned"
fi

dest="$OUT_DIR/tie-${VERSION}-${suffix}.apk"
cp "$apk" "$dest"
echo "Collected $(basename "$dest") from $apk"
ls -la "$OUT_DIR"
