#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON_SRC="$ROOT/src-tauri/icons/icon.png"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
ICON_DST="$ICON_DIR/com.tie.knowledge.png"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP="$DESKTOP_DIR/com.tie.knowledge.desktop"
BINARY="$ROOT/src-tauri/target/debug/tie"

if [[ ! -f "$ICON_SRC" ]]; then
  echo "Tie icon source missing: $ICON_SRC" >&2
  exit 1
fi

mkdir -p "$ICON_DIR" "$DESKTOP_DIR"
cp "$ICON_SRC" "$ICON_DST"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Tie
GenericName=Knowledge Editor
Comment=Local-first markdown knowledge editor
Exec=$BINARY
Icon=com.tie.knowledge
StartupWMClass=tie
Terminal=false
Categories=Office;TextEditor;Utility;
EOF

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Linux dev icon installed: $DESKTOP"
