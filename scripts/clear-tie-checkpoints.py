#!/usr/bin/env python3
"""Remove Cursor checkpoints that rewrite this Tie repo (causes tauri:dev restart loops)."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def checkpoint_roots() -> list[Path]:
    home = Path.home()
    return [
        home / ".config/Cursor/User/globalStorage/anysphere.cursor-commits/checkpoints",
        home / ".config/Cursor/User/globalStorage/anysphere.cursor-retrieval",
    ]


def mentions_repo(path: Path, needle: str) -> bool:
    try:
        if path.is_file() and path.stat().st_size < 2_000_000:
            return needle in path.read_text(errors="ignore")
    except OSError:
        return False
    return False


def dir_touches_repo(directory: Path, needle: str) -> bool:
    meta = directory / "metadata.json"
    if meta.exists():
        try:
            data = json.loads(meta.read_text())
            files = [f.get("fsPath", "") for f in data.get("requestFiles", [])]
            if any(needle in p for p in files):
                return True
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    for path in directory.rglob("*"):
        if mentions_repo(path, needle):
            return True
    return False


def main() -> int:
    root = repo_root()
    needle = str(root) + "/"
    removed: list[str] = []

    for base in checkpoint_roots():
        if not base.exists():
            print(f"skip missing: {base}")
            continue
        for entry in list(base.iterdir()):
            if not entry.is_dir():
                continue
            if dir_touches_repo(entry, needle):
                shutil.rmtree(entry, ignore_errors=True)
                removed.append(str(entry))

    print(f"repo: {root}")
    print(f"removed {len(removed)} checkpoint dir(s)")
    for item in removed:
        print(f"  - {item}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
