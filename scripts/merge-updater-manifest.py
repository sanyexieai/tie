#!/usr/bin/env python3
"""Merge per-platform Tauri updater latest.json files into one release manifest."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def load_manifest(path: Path) -> dict:
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: merge-updater-manifest.py <linux.json> <windows.json> <output.json>", file=sys.stderr)
        return 1

    linux_path = Path(sys.argv[1])
    windows_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    repo = os.environ.get("GITHUB_REPOSITORY", "sanyexieai/tie")
    tag = os.environ.get("GITHUB_REF_NAME", "").strip()
    release_base = f"https://github.com/{repo}/releases/download/{tag}/" if tag else ""

    merged: dict = {}
    for path in (linux_path, windows_path):
        data = load_manifest(path)
        if not data:
            continue
        for key, value in data.items():
            if key == "platforms" and isinstance(value, dict):
                merged.setdefault("platforms", {}).update(value)
            elif key not in merged or key == "platforms":
                merged[key] = value

    if "platforms" not in merged or not merged["platforms"]:
        print("No updater platforms found in input manifests", file=sys.stderr)
        return 1

    if release_base:
        for platform in merged["platforms"].values():
            url = platform.get("url")
            if isinstance(url, str) and url and not url.startswith("http"):
                platform["url"] = release_base + Path(url).name

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {output_path} with platforms: {', '.join(sorted(merged['platforms']))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
