#!/usr/bin/env python3
"""Build Tauri updater latest.json from signed release artifacts."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# Prefer one updater target per platform key (Tauri static manifest format).
PLATFORM_PICKS: tuple[tuple[str, str], ...] = (
    ("linux-x86_64", ".deb"),
    ("windows-x86_64", ".exe"),
)


def read_signature(sig_path: Path) -> str:
    return sig_path.read_text(encoding="utf-8").strip()


def version_from_tag(tag: str) -> str:
    tag = tag.strip()
    if tag.startswith("v"):
        tag = tag[1:]
    return tag


def version_from_artifacts(artifacts_dir: Path) -> str | None:
    for pattern in (r"_(\d+\.\d+\.\d+)_", r"-(\d+\.\d+\.\d+)-"):
        for path in artifacts_dir.iterdir():
            if not path.is_file():
                continue
            match = re.search(pattern, path.name)
            if match:
                return match.group(1)
    return None


def pick_platform_artifacts(artifacts_dir: Path) -> dict[str, tuple[Path, Path]]:
    by_ext: dict[str, tuple[Path, Path]] = {}
    for path in sorted(artifacts_dir.iterdir()):
        if not path.is_file() or path.suffix == ".sig":
            continue
        sig_path = path.with_name(path.name + ".sig")
        if not sig_path.is_file():
            continue
        by_ext[path.suffix.lower()] = (path, sig_path)

    platforms: dict[str, tuple[Path, Path]] = {}
    for platform_key, ext in PLATFORM_PICKS:
        pair = by_ext.get(ext)
        if pair:
            platforms[platform_key] = pair
    return platforms


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: merge-updater-manifest.py <artifacts-dir> <output.json>", file=sys.stderr)
        return 1

    artifacts_dir = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    repo = os.environ.get("GITHUB_REPOSITORY", "sanyexieai/tie")
    tag = os.environ.get("GITHUB_REF_NAME", "").strip()
    release_base = f"https://github.com/{repo}/releases/download/{tag}/" if tag else ""

    if not artifacts_dir.is_dir():
        print(f"Artifacts directory not found: {artifacts_dir}", file=sys.stderr)
        return 1

    platform_pairs = pick_platform_artifacts(artifacts_dir)
    if not platform_pairs:
        print(f"No signed updater artifacts found in {artifacts_dir}", file=sys.stderr)
        for path in sorted(artifacts_dir.iterdir()):
            if path.is_file():
                print(f"  {path.name}", file=sys.stderr)
        return 1

    version = version_from_tag(tag) if tag else version_from_artifacts(artifacts_dir)
    if not version:
        print("Could not determine release version", file=sys.stderr)
        return 1

    manifest: dict = {
        "version": version,
        "notes": "",
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {},
    }

    for platform_key, (bundle_path, sig_path) in platform_pairs.items():
        url = release_base + bundle_path.name if release_base else bundle_path.name
        manifest["platforms"][platform_key] = {
            "signature": read_signature(sig_path),
            "url": url,
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {output_path} v{version} with platforms: {', '.join(sorted(manifest['platforms']))}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
