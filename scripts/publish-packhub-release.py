#!/usr/bin/env python3
"""把 Tie 安装包和 Tauri updater JSON 发到 PackHub。

本地（自动收集当前机器上的 Tauri / Android 产物）::

    npm run packhub:publish
    npm run packhub:publish -- --dry-run
    npm run packhub:publish -- --platform linux --notes '修了侧栏滚动条'

CI（扁平产物目录）::

    python3 scripts/publish-packhub-release.py dist --manifest dist/tauri-latest.json

凭证：``.env`` / ``packhub.env`` 里的 ``PACKHUB_UPLOAD_KEY``（``phk_...``），不要提交仓库。

默认**不传** version/build，由 PackHub 当前版本末位 +1、build +1。
同一轮多平台会沿用第一次上传返回的号，避免连加。
只有 ``--version`` / ``--build``、环境变量或 CI 的 ``GITHUB_REF_NAME`` 才会钉死版本。
自动生成的 tauri-latest.json 会与线上已有桌面平台条目合并；只有 ``--replace-manifest`` 才会整份覆盖。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_URL = "https://3ye.co:32810"
DEFAULT_SLUG = "tie"
TAURI_LATEST_PATH = "tauri-latest.json"
ENV_FILES = (".env", "deploy/.env", "packhub.env")
DEFAULT_TIMEOUT_SEC = 1800
UPLOAD_ATTEMPTS = 3
PLATFORMS = ("linux", "windows", "android")

PLATFORM_FILES = (
    ("linux", (".deb",)),
    ("windows", (".exe",)),
    ("android", (".apk",)),
)

DEFAULT_ARTIFACT_DIRS = (
    ROOT / "dist",
    ROOT / "src-tauri/target/release/bundle/deb",
    ROOT / "src-tauri/target/release/bundle/rpm",
    ROOT / "src-tauri/target/release/bundle/nsis",
    ROOT / "src-tauri/target/release/bundle/msi",
    ROOT / "src-tauri/gen/android/app/build/outputs/apk/universal/release",
    ROOT / "release-artifacts-android",
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
    seen: set[Path] = set()
    cwd = Path.cwd()
    bases = [cwd, *cwd.parents][:6]
    if ROOT not in bases:
        bases.append(ROOT)
    for base in bases:
        for name in ENV_FILES:
            path = (base / name).resolve()
            if path in seen:
                continue
            seen.add(path)
            load_env_file(path)


def env_first(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def version_from_tag(tag: str) -> str:
    tag = tag.strip()
    return tag[1:] if tag.startswith("v") else tag


def version_from_package() -> str:
    pkg = ROOT / "package.json"
    data = json.loads(pkg.read_text(encoding="utf-8"))
    version = str(data.get("version", "")).strip()
    if not version:
        raise SystemExit("package.json 没有 version")
    return version


def upload_timeout_sec() -> float:
    raw = env_first("PACKHUB_TIMEOUT", default=str(DEFAULT_TIMEOUT_SEC))
    try:
        value = float(raw)
    except ValueError as err:
        raise SystemExit(f"PACKHUB_TIMEOUT 无效: {raw}") from err
    return max(60.0, value)


def is_retryable(err: BaseException) -> bool:
    reason = str(getattr(err, "reason", err)).lower()
    text = f"{type(err).__name__} {reason}".lower()
    return any(token in text for token in ("timed out", "timeout", "temporarily", "reset", "broken pipe"))


def put(url: str, key: str, data: bytes, content_type: str) -> dict:
    timeout = upload_timeout_sec()
    last_error: BaseException | None = None
    for attempt in range(1, UPLOAD_ATTEMPTS + 1):
        started = time.monotonic()
        req = urllib.request.Request(
            url,
            data=data,
            method="PUT",
            headers={
                "X-Upload-Key": key,
                "Content-Type": content_type,
                "Content-Length": str(len(data)),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                status = resp.status
            elapsed = time.monotonic() - started
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {"raw": body}
            parsed["_http"] = status
            parsed["_elapsed_sec"] = round(elapsed, 1)
            return parsed
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")
            raise SystemExit(f"上传失败 HTTP {err.code}: {detail or err.reason}") from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last_error = err
            elapsed = time.monotonic() - started
            if attempt < UPLOAD_ATTEMPTS and is_retryable(err):
                wait = 2 ** attempt
                print(
                    f"upload attempt {attempt}/{UPLOAD_ATTEMPTS} failed after {elapsed:.0f}s ({err}); retry in {wait}s",
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(wait)
                continue
            raise SystemExit(f"连不上 PackHub: {getattr(err, 'reason', err)}") from err
    raise SystemExit(f"连不上 PackHub: {getattr(last_error, 'reason', last_error)}")


def artifact_rank(path: Path, suffixes: tuple[str, ...]) -> tuple:
    name = path.name.lower()
    unsigned = "unsigned" in name
    if suffixes == (".exe",):
        return (unsigned, 0 if "setup" in name else 1, name)
    if suffixes == (".apk",):
        signed_name = name.endswith("-signed.apk")
        release_name = name == "app-universal-release.apk"
        return (unsigned, 0 if signed_name or release_name else 1, name)
    return (unsigned, 0, name)


def collect_matches(folder: Path, suffixes: tuple[str, ...]) -> list[Path]:
    if not folder.is_dir():
        return []
    matches: list[Path] = []
    for path in folder.iterdir():
        if not path.is_file() or path.name.endswith(".sig"):
            continue
        name = path.name.lower()
        if any(name.endswith(suffix) for suffix in suffixes):
            matches.append(path)
    return matches


def pick_artifact(search_dirs: list[Path], suffixes: tuple[str, ...]) -> Path | None:
    matches: list[Path] = []
    seen: set[Path] = set()
    for folder in search_dirs:
        for path in collect_matches(folder, suffixes):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            matches.append(path)
    if not matches:
        return None
    matches.sort(key=lambda path: artifact_rank(path, suffixes))
    return matches[0]


def resolve_search_dirs(artifacts: str | None) -> list[Path]:
    if artifacts:
        path = Path(artifacts).expanduser().resolve()
        if not path.is_dir():
            raise SystemExit(f"目录不存在: {path}")
        return [path]
    dirs: list[Path] = []
    seen: set[Path] = set()
    candidates = list(DEFAULT_ARTIFACT_DIRS)
    bundle = ROOT / "src-tauri/target/release/bundle"
    if bundle.is_dir():
        candidates.extend(sorted(child for child in bundle.iterdir() if child.is_dir()))
    for folder in candidates:
        resolved = folder.resolve() if folder.exists() else folder
        if not folder.is_dir() or resolved in seen:
            continue
        seen.add(resolved)
        dirs.append(folder)
    return dirs


def link_or_copy(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        dest.symlink_to(src.resolve())
    except OSError:
        shutil.copy2(src, dest)


def has_desktop_artifact(files: list[Path]) -> bool:
    suffixes = (".deb", ".rpm", ".exe", ".msi", ".appimage", ".dmg")
    return any(path.name.lower().endswith(suffixes) for path in files)


def is_desktop_platform_key(key: str) -> bool:
    return key.startswith(("linux-", "windows-", "darwin-"))


def manifest_has_desktop(data: dict) -> bool:
    platforms = data.get("platforms")
    if not isinstance(platforms, dict):
        return False
    return any(is_desktop_platform_key(str(key)) for key in platforms)


def fetch_json(url: str) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            parsed = json.loads(resp.read().decode("utf-8", errors="replace"))
        return parsed if isinstance(parsed, dict) else None
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as err:
        print(f"warn: 读取 {url} 失败: {err}", file=sys.stderr)
        return None


def public_tauri_latest_url(base: str, slug: str) -> str:
    return env_first("PACKHUB_TAURI_LATEST", default=f"{base}/v1/{slug}/site/{TAURI_LATEST_PATH}")


def merge_tauri_manifest(local: dict, remote: dict | None, *, keep_remote_version: bool) -> dict:
    remote_platforms = dict((remote or {}).get("platforms") or {})
    local_platforms = dict(local.get("platforms") or {})
    merged = {**(remote or {}), **local, "platforms": {**remote_platforms, **local_platforms}}
    if keep_remote_version and remote:
        if remote.get("version"):
            merged["version"] = remote["version"]
        if remote.get("pub_date"):
            merged["pub_date"] = remote["pub_date"]
    return merged


def prepare_manifest_for_upload(
    path: Path,
    *,
    public_url: str,
    has_new_desktop: bool,
    replace: bool,
) -> Path | None:
    local = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(local, dict):
        raise SystemExit(f"Tauri 更新清单格式无效: {path}")
    if replace:
        if not manifest_has_desktop(local):
            print(f"warning: {path} 没有 linux/windows/darwin 条目", file=sys.stderr)
        return path
    remote = fetch_json(public_url)
    merged = merge_tauri_manifest(local, remote, keep_remote_version=not has_new_desktop)
    if not manifest_has_desktop(merged):
        print("skip manifest: 没有 linux/windows/darwin 条目，拒绝覆盖桌面更新清单", file=sys.stderr)
        return None
    path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    keys = ", ".join(sorted(str(key) for key in (merged.get("platforms") or {})))
    print(f"manifest version={merged.get('version')} platforms={keys}", file=sys.stderr)
    return path


def generate_manifest(files: list[Path], version: str) -> Path | None:
    if not files:
        return None
    staging = Path(tempfile.mkdtemp(prefix="tie-packhub-"))
    for path in files:
        link_or_copy(path, staging / path.name)
        sig = path.with_name(path.name + ".sig")
        if sig.is_file():
            link_or_copy(sig, staging / sig.name)
    output = staging / TAURI_LATEST_PATH
    env = os.environ.copy()
    env["UPDATER_URL_MODE"] = "packhub"
    env["GITHUB_REF_NAME"] = f"v{version}"
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/merge-updater-manifest.py"), str(staging), str(output)],
        env=env,
        cwd=str(ROOT),
        check=False,
    )
    if result.returncode != 0 or not output.is_file():
        print("未生成 tauri-latest.json（桌面自动更新需要对应 .sig）", file=sys.stderr)
        return None
    return output


def resolve_manifest(
    args: argparse.Namespace,
    search_dirs: list[Path],
    version: str,
    uploaded_files: list[Path],
    *,
    public_url: str,
) -> Path | None:
    if args.skip_manifest and not args.manifest_only:
        return None
    manifest: Path | None = None
    if args.manifest:
        manifest = Path(args.manifest).expanduser().resolve()
        if not manifest.is_file():
            raise SystemExit(f"缺少 Tauri 更新清单: {manifest}")
    else:
        for folder in search_dirs:
            candidate = folder / TAURI_LATEST_PATH
            if candidate.is_file():
                manifest = candidate
                break
        if manifest is None:
            manifest = generate_manifest(uploaded_files, version)
        if manifest is None and args.manifest_only:
            raise SystemExit("缺少 Tauri 更新清单：传 --manifest 或先构建带 .sig 的安装包")
        if manifest is None:
            return None
    return prepare_manifest_for_upload(
        manifest,
        public_url=public_url,
        has_new_desktop=has_desktop_artifact(uploaded_files),
        replace=args.replace_manifest,
    )


def upload_package(base: str, key: str, slug: str, platform: str, path: Path, version: str, build: str, notes: str) -> dict:
    query = {
        "fileName": path.name,
        "version": version,
        "build": build,
        "notes": notes,
    }
    qs = urllib.parse.urlencode({k: v for k, v in query.items() if v})
    target = f"{base}/api/upload/{urllib.parse.quote(slug)}/{platform}?{qs}"
    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"uploading {platform}: {path.name} ({size_mb:.1f} MiB)", file=sys.stderr, flush=True)
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
    parser = argparse.ArgumentParser(
        description="把 Tie 安装包和 Tauri latest.json 发到 PackHub",
        epilog="不传目录时，自动从 src-tauri/target/release/bundle 与 Android APK 输出目录收集。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("artifacts", nargs="?", help="含 apk/deb/exe 的目录；省略则自动收集本地产物")
    parser.add_argument("--url", help="PackHub 根地址")
    parser.add_argument("--key", help="项目上传密钥")
    parser.add_argument("--slug", help="项目 slug，默认 tie")
    parser.add_argument("--version", help="钉死版本号；默认不传，PackHub 当前版本末位 +1")
    parser.add_argument("--build", help="钉死 build；默认不传，PackHub 在最大 build 上 +1")
    parser.add_argument("--notes", help="版本说明")
    parser.add_argument("--platform", action="append", choices=PLATFORMS, help="只上传指定平台，可重复")
    parser.add_argument("--manifest", help="Tauri latest.json 路径")
    parser.add_argument("--manifest-only", action="store_true", help="只上传 Tauri latest.json，不传安装包")
    parser.add_argument("--skip-manifest", action="store_true", help="不上传 tauri-latest.json")
    parser.add_argument("--replace-manifest", action="store_true", help="不与现有 tauri-latest.json 合并，整份覆盖")
    parser.add_argument("--dry-run", action="store_true", help="只列出将要上传的文件，不请求 PackHub")
    return parser.parse_args()


def main() -> int:
    discover_env()
    args = parse_args()
    search_dirs = resolve_search_dirs(args.artifacts)

    url = (args.url or env_first("PACKHUB_URL", default=DEFAULT_URL)).rstrip("/")
    key = args.key or env_first("PACKHUB_KEY", "PACKHUB_UPLOAD_KEY")
    slug = args.slug or env_first("PACKHUB_SLUG", default=DEFAULT_SLUG)
    if not slug:
        raise SystemExit("缺少 PACKHUB_SLUG")
    if not args.dry_run and not key:
        raise SystemExit("缺少 PACKHUB_UPLOAD_KEY：在仓库根目录 .env 填写，或传 --key")

    version = args.version or env_first("PACKHUB_VERSION") or version_from_tag(env_first("GITHUB_REF_NAME"))
    build = args.build or env_first("PACKHUB_BUILD")
    notes = args.notes or env_first("PACKHUB_NOTES")
    wanted = tuple(args.platform) if args.platform else PLATFORMS
    pinned = bool(version or build)

    print(
        f"PackHub {url} slug={slug} version={version or 'auto(+1)'} build={build or 'auto(+1)'}",
        file=sys.stderr,
    )
    if search_dirs:
        print("search: " + ", ".join(str(path) for path in search_dirs), file=sys.stderr)
    else:
        print("search: (no local artifact dirs found)", file=sys.stderr)

    uploaded = 0
    uploaded_files: list[Path] = []
    if not args.manifest_only:
        for platform, suffixes in PLATFORM_FILES:
            if platform not in wanted:
                continue
            path = pick_artifact(search_dirs, suffixes)
            if not path:
                print(f"skip {platform}: no {suffixes}", file=sys.stderr)
                continue
            if "unsigned" in path.name.lower():
                print(f"warning {platform}: 将上传未签名包 {path.name}", file=sys.stderr)
            if args.dry_run:
                extra = f" version={version or 'auto(+1)'} build={build or 'auto(+1)'}"
                print(f"dry-run {platform}: {path}{extra}", file=sys.stderr)
                uploaded += 1
                uploaded_files.append(path)
                continue
            result = upload_package(url, key, slug, platform, path, version, build, notes)
            package = result.get("package") or {}
            got_version = str(package.get("version") or "")
            got_build = "" if package.get("build") is None else str(package.get("build"))
            if got_version and not version:
                version = got_version
            if got_build and not build:
                build = got_build
            latest = (result.get("latestJson") or {}).get("version")
            if pinned and version and latest and str(latest) != str(version):
                raise SystemExit(f"PackHub 当前版本是 {latest}，期望 {version}")
            uploaded += 1
            uploaded_files.append(path)
        if uploaded == 0:
            hint = args.artifacts or "本地 Tauri/Android 产物目录"
            raise SystemExit(f"未找到可上传的安装包: {hint}")
    else:
        uploaded = -1

    manifest_version = version or version_from_package()
    manifest = resolve_manifest(
        args,
        search_dirs,
        manifest_version,
        uploaded_files,
        public_url=public_tauri_latest_url(url, slug),
    )
    manifest_url = None
    if manifest is None:
        print("skip manifest: 没有 tauri-latest.json", file=sys.stderr)
    elif args.dry_run:
        print(f"dry-run page: {manifest} -> {TAURI_LATEST_PATH}", file=sys.stderr)
        manifest_url = TAURI_LATEST_PATH
    else:
        page = upload_page(url, key, slug, manifest, TAURI_LATEST_PATH)
        manifest_url = page.get("url") or TAURI_LATEST_PATH

    print(json.dumps({
        "packages": uploaded,
        "manifest": manifest_url,
        "version": version or "auto",
        "build": build or "auto",
        "ok": True,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
