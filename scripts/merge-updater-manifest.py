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
    ("android-aarch64", ".apk"),
)

PACKHUB_PLATFORM_DIRS = {
    "linux-x86_64": "linux",
    "windows-x86_64": "windows",
    "android-aarch64": "android",
}

DEFAULT_PACKHUB_PUBLIC_BASE = "https://3ye.co:32810/v1/tie"


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


def pick_platform_artifacts(artifacts_dir: Path) -> dict[str, tuple[Path, Path | None]]:
    signed_by_ext: dict[str, tuple[Path, Path]] = {}
    unsigned_by_ext: dict[str, Path] = {}
    for path in sorted(artifacts_dir.iterdir()):
        if not path.is_file() or path.suffix == ".sig":
            continue
        sig_path = path.with_name(path.name + ".sig")
        if sig_path.is_file():
            signed_by_ext[path.suffix.lower()] = (path, sig_path)
        else:
            unsigned_by_ext[path.suffix.lower()] = path

    platforms: dict[str, tuple[Path, Path | None]] = {}
    for platform_key, ext in PLATFORM_PICKS:
        signed = signed_by_ext.get(ext)
        if signed:
            platforms[platform_key] = signed
            continue
        if ext == ".apk":
            apk = unsigned_by_ext.get(ext)
            if apk:
                platforms[platform_key] = (apk, None)
    return platforms


def updater_url_mode() -> str:
    mode = os.environ.get("UPDATER_URL_MODE", "github").strip().lower()
    if mode not in {"github", "packhub"}:
        raise ValueError(f"UPDATER_URL_MODE must be github or packhub, got {mode!r}")
    return mode


def packhub_public_base() -> str:
    return os.environ.get("PACKHUB_PUBLIC_BASE", DEFAULT_PACKHUB_PUBLIC_BASE).rstrip("/")


def artifact_url(platform_key: str, file_name: str, *, repo: str, tag: str) -> str:
    if updater_url_mode() == "packhub":
        folder = PACKHUB_PLATFORM_DIRS.get(platform_key)
        if not folder:
            raise ValueError(f"no PackHub folder mapping for {platform_key}")
        return f"{packhub_public_base()}/releases/{folder}/{file_name}"
    if tag:
        return f"https://github.com/{repo}/releases/download/{tag}/{file_name}"
    return file_name


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return self_test()
    if len(sys.argv) != 3:
        print("usage: merge-updater-manifest.py <artifacts-dir> <output.json>", file=sys.stderr)
        return 1

    artifacts_dir = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    repo = os.environ.get("GITHUB_REPOSITORY", "sanyexieai/tie")
    tag = os.environ.get("GITHUB_REF_NAME", "").strip()

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
        url = artifact_url(platform_key, bundle_path.name, repo=repo, tag=tag)
        entry: dict[str, str] = {"url": url}
        if platform_key.startswith("android") or sig_path is None:
            # Android sideload updates are downloaded and installed manually.
            entry["signature"] = ""
        else:
            entry["signature"] = read_signature(sig_path)
        manifest["platforms"][platform_key] = entry

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {output_path} v{version} ({updater_url_mode()}) "
        f"with platforms: {', '.join(sorted(manifest['platforms']))}",
        file=sys.stderr,
    )
    return 0


def self_test() -> int:
    previous_mode = os.environ.get("UPDATER_URL_MODE")
    previous_base = os.environ.get("PACKHUB_PUBLIC_BASE")
    try:
        os.environ["UPDATER_URL_MODE"] = "github"
        github = artifact_url(
            "linux-x86_64",
            "Tie_1.0.38_amd64.deb",
            repo="sanyexieai/tie",
            tag="v1.0.38",
        )
        assert github.endswith("/Tie_1.0.38_amd64.deb"), github
        assert "github.com/sanyexieai/tie/releases/download/v1.0.38" in github, github

        os.environ["UPDATER_URL_MODE"] = "packhub"
        os.environ.pop("PACKHUB_PUBLIC_BASE", None)
        packhub = artifact_url(
            "linux-x86_64",
            "Tie_1.0.38_amd64.deb",
            repo="sanyexieai/tie",
            tag="v1.0.38",
        )
        assert packhub == f"{DEFAULT_PACKHUB_PUBLIC_BASE}/releases/linux/Tie_1.0.38_amd64.deb", packhub
        android = artifact_url(
            "android-aarch64",
            "tie-1.0.38-android-universal.apk",
            repo="sanyexieai/tie",
            tag="v1.0.38",
        )
        assert android.endswith("/releases/android/tie-1.0.38-android-universal.apk"), android
        print("self-test ok", file=sys.stderr)
        return 0
    finally:
        if previous_mode is None:
            os.environ.pop("UPDATER_URL_MODE", None)
        else:
            os.environ["UPDATER_URL_MODE"] = previous_mode
        if previous_base is None:
            os.environ.pop("PACKHUB_PUBLIC_BASE", None)
        else:
            os.environ["PACKHUB_PUBLIC_BASE"] = previous_base


if __name__ == "__main__":
    raise SystemExit(main())
