#!/usr/bin/env python3
"""Upload Tie release artifacts and Tauri updater JSON to PackHub."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://3ye.co:32810"
DEFAULT_SLUG = "tie"
TAURI_LATEST_PATH = "tauri-latest.json"
ENV_FILES = (".env", "deploy/.env", "packhub.env")

PLATFORM_FILES = (
    ("android", (".apk",)),
    ("linux", (".deb",)),
    ("windows", (".exe",)),
)


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


def discover_env() -> None:
    cwd = Path.cwd()
    for base in [cwd, *cwd.parents][:6]:
        for name in ENV_FILES:
            load_env_file(base / name)


def env_first(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def version_from_tag(tag: str) -> str:
    tag = tag.strip()
    return tag[1:] if tag.startswith("v") else tag


def version_build(version: str) -> str:
    parts = [int(part) for part in version.split(".")]
    while len(parts) < 3:
        parts.append(0)
    return str(parts[0] * 10000 + parts[1] * 100 + parts[2])


def put(url: str, key: str, data: bytes, content_type: str) -> dict:
    req = urllib.request.Request(
        url,
        data=data,
        method="PUT",
        headers={
            "X-Upload-Key": key,
            "Content-Type": content_type,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise SystemExit(f"上传失败 HTTP {err.code}: {detail or err.reason}") from err
    except urllib.error.URLError as err:
        raise SystemExit(f"连不上 PackHub: {err.reason}") from err
    try:
        parsed = json.loads(body) if body else {}
    except json.JSONDecodeError:
        parsed = {"raw": body}
    parsed["_http"] = status
    return parsed


def pick_artifact(artifacts_dir: Path, suffixes: tuple[str, ...]) -> Path | None:
    matches: list[Path] = []
    for path in sorted(artifacts_dir.iterdir()):
        if not path.is_file() or path.name.endswith(".sig"):
            continue
        name = path.name.lower()
        if any(name.endswith(suffix) for suffix in suffixes):
            matches.append(path)
    if not matches:
        return None
    if suffixes == (".exe",):
        setup = [path for path in matches if "setup" in path.name.lower()]
        if setup:
            return setup[0]
    return matches[0]


def upload_package(base: str, key: str, slug: str, platform: str, path: Path, version: str, build: str, notes: str) -> dict:
    query = {
        "fileName": path.name,
        "version": version,
        "build": build,
        "notes": notes,
    }
    qs = urllib.parse.urlencode({k: v for k, v in query.items() if v})
    target = f"{base}/api/upload/{urllib.parse.quote(slug)}/{platform}?{qs}"
    print(f"uploading {platform}: {path.name}", file=sys.stderr)
    result = put(target, key, path.read_bytes(), "application/octet-stream")
    if not result.get("ok"):
        raise SystemExit(f"PackHub {platform} 上传未成功: {json.dumps(result, ensure_ascii=False)}")
    package = result.get("package") or {}
    print(
        f"ok {platform} version={package.get('version')} build={package.get('build')} file={package.get('fileName')}",
        file=sys.stderr,
    )
    return result


def upload_page(base: str, key: str, slug: str, path: Path, rel: str) -> dict:
    target = f"{base}/api/upload/{urllib.parse.quote(slug)}/pages?{urllib.parse.urlencode({'path': rel})}"
    print(f"uploading page: {rel}", file=sys.stderr)
    result = put(target, key, path.read_bytes(), "application/octet-stream")
    if result.get("ok") is False:
        raise SystemExit(f"PackHub 静态页上传未成功: {json.dumps(result, ensure_ascii=False)}")
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="把 Tie 安装包和 Tauri latest.json 发到 PackHub")
    parser.add_argument("artifacts", help="含 apk/deb/exe 与 tauri-latest.json 的目录")
    parser.add_argument("--url", help="PackHub 根地址")
    parser.add_argument("--key", help="项目上传密钥")
    parser.add_argument("--slug", help="项目 slug，默认 tie")
    parser.add_argument("--version", help="版本号，默认从 GITHUB_REF_NAME 读取")
    parser.add_argument("--build", help="PackHub build，默认按 x.y.z 编成 x*10000+y*100+z")
    parser.add_argument("--notes", help="版本说明")
    parser.add_argument("--manifest", help="Tauri latest.json 路径，默认 <artifacts>/tauri-latest.json")
    parser.add_argument("--manifest-only", action="store_true", help="只上传 Tauri latest.json，不传安装包")
    return parser.parse_args()


def main() -> int:
    discover_env()
    args = parse_args()
    artifacts = Path(args.artifacts).expanduser().resolve()
    if not artifacts.is_dir():
        raise SystemExit(f"目录不存在: {artifacts}")

    url = (args.url or env_first("PACKHUB_URL", default=DEFAULT_URL)).rstrip("/")
    key = args.key or env_first("PACKHUB_KEY", "PACKHUB_UPLOAD_KEY")
    slug = args.slug or env_first("PACKHUB_SLUG", default=DEFAULT_SLUG)
    if not key:
        raise SystemExit("缺少 PACKHUB_UPLOAD_KEY")
    if not slug:
        raise SystemExit("缺少 PACKHUB_SLUG")

    version = args.version or env_first("PACKHUB_VERSION") or version_from_tag(env_first("GITHUB_REF_NAME"))
    if not version:
        raise SystemExit("缺少版本号：传 --version 或设 GITHUB_REF_NAME")
    build = args.build or env_first("PACKHUB_BUILD") or version_build(version)
    notes = args.notes or env_first("PACKHUB_NOTES")

    uploaded = 0
    if not args.manifest_only:
        for platform, suffixes in PLATFORM_FILES:
            path = pick_artifact(artifacts, suffixes)
            if not path:
                print(f"skip {platform}: no {suffixes} in {artifacts}", file=sys.stderr)
                continue
            result = upload_package(url, key, slug, platform, path, version, build, notes)
            latest = (result.get("latestJson") or {}).get("version")
            if latest and latest != version:
                raise SystemExit(f"PackHub 当前版本是 {latest}，期望 {version}")
            uploaded += 1
        if uploaded == 0:
            raise SystemExit(f"未找到可上传的安装包: {artifacts}")
    else:
        uploaded = -1

    manifest = Path(args.manifest).expanduser().resolve() if args.manifest else artifacts / TAURI_LATEST_PATH
    if not manifest.is_file():
        raise SystemExit(f"缺少 Tauri 更新清单: {manifest}")
    page = upload_page(url, key, slug, manifest, TAURI_LATEST_PATH)
    print(json.dumps({"packages": uploaded, "manifest": page.get("url") or TAURI_LATEST_PATH, "ok": True}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
