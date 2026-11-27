# Tie 1.0 发布前检查清单

在创建 `v1.0.0` tag 并上传安装包前，请逐项确认。

## 自动发布（GitHub Actions）

推送符合 `v*` 的 tag 后，`.github/workflows/release.yml` 会：

1. 在 **Ubuntu 22.04** 构建 Linux 安装包（`.deb` / `.rpm`；固定 22.04 以兼容 WebKitGTK 4.1 与较低 glibc）
2. 在 Windows 构建 Windows 安装包（`.msi` / `.exe` NSIS）
3. 在 **Ubuntu 22.04** 构建 Android 通用 APK（`tie-<版本>-android-universal.apk`）
4. 创建 GitHub Release，并附上上述产物与 `latest.json`（供桌面端自动更新）

### 自动更新签名

Release 构建会读取 GitHub Secrets 中的 updater 私钥，为安装包生成 `.sig` 并合并 `latest.json`：

| Secret | 说明 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | `tauri signer generate` 生成的私钥**全文**（或 `TAURI_SIGNING_PRIVATE_KEY_PATH` 指向的文件内容） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码；无密码时可留空 |

本地生成密钥（公钥已写入 `src-tauri/tauri.conf.json`）：

```bash
CI=true npx tauri signer generate -w ~/.tauri/tie.key -f --ci
cat ~/.tauri/tie.key   # 复制到 GitHub Secret，勿提交仓库
```

**私钥丢失后，已安装用户将无法再验证你发布的新版本。**

### Windows 更新目录

正式 Windows 更新清单使用 NSIS `.exe`（`scripts/merge-updater-manifest.py`），客户端从正在运行的可执行文件读取安装目录，传入 `/TIE_CURRENT_INSTALL` 标记，并将 `/D=<当前目录>` 作为最后一个安装参数传给 NSIS。目录参数不加引号，包含空格和中文时也保留完整路径，不依赖工作目录或注册表中另一份安装的路径。无法确定当前目录时不启用自动安装，仍可下载安装包手动安装。

旧客户端尚不包含这个参数。新 NSIS 包在普通页面和任何卸载、复制之前增加一个兼容入口：旧客户端默认的 `/P /UPDATE` 请求缺少标记时，要求用户选择一次已有 `tie.exe` 的安装目录，取消则退出安装；已传当前目录的新客户端跳过此页，后续自动更新无需重复选择。已有的另一份安装不会自动删除。不要将 Windows 自动更新清单改为 MSI，除非同时实现 MSI 的目录参数。

### Android 发布签名（可选，推荐）

未配置时 CI 仍会构建 **未签名** APK（文件名带 `-unsigned`，一般无法直接安装）。配置以下 Secret 后，Gradle 会在 Release 构建时自动签名：

| Secret | 说明 |
|--------|------|
| `ANDROID_KEY_BASE64` | Release keystore（`.jks`）的 base64，例如 `base64 -w0 tie-release.jks` |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | keystore 与 key 的密码（若相同则填同一值） |

本地生成 keystore 示例：

```bash
keytool -genkey -v -keystore tie-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias tie
base64 -w0 tie-release.jks   # 输出写入 ANDROID_KEY_BASE64
```

桌面端启动时会静默检查 PackHub 的 Tauri 清单 `https://3ye.co:32810/v1/tie/site/tauri-latest.json`（GitHub `latest.json` 为回退）；发现新版本会提示，也可在「设置 → 应用更新」手动检查。

打 `v*` tag 后，Release 工作流会把 Android / Linux / Windows 安装包同步到 PackHub，并更新上述 Tauri 清单。CI 需要仓库 Secret `PACKHUB_UPLOAD_KEY`（项目上传密钥 `phk_...`）。

示例：

```bash
# 仅 bump 版本并推送 tag（工作区需干净）
npm run release -- patch

# 连同当前所有改动一起发布（常用）
npm run release -- patch --all -m "桌面端自动更新"

# 指定版本号
npm run release -- 1.0.2 --all
```

```bash
# 确认 package.json / src-tauri/tauri.conf.json / backend/package.json 版本号一致
git tag v1.0.0
git push origin v1.0.0
```

也可使用 `npm run release -- patch --all` 自动完成版本号同步、提交与 tag 推送。

完成后在仓库 Releases 页下载安装包。CI（`ci.yml`）仍会在普通 push / PR 上跑检查与构建产物。

## 自动化（CI 必须通过）

- [ ] `npm run check`
- [ ] `npm test`（前端单元测试）
- [ ] `npm run test:backend`（后台 API 集成测试）
- [ ] `npm run build && npm run test:e2e`（浏览器冒烟）
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml`
- [ ] `npm run tauri:build`（当前平台；发布 Linux 用 `tauri:build:linux`，Windows 用 `tauri:build:windows`）
- [ ] CI `build-linux` / `build-windows` 产物可下载

## 桌面端手工冒烟

- [ ] 首次启动：默认工作区与欢迎页正常
- [ ] Windows 自定义目录（含中文和空格）：自动更新覆盖原目录，默认目录没有新副本，快捷方式仍指向原目录的新版本
- [ ] Windows 旧版 `/P /UPDATE`：先选择已有安装目录；取消时不卸载、不复制；新客户端带当前目录标记时不再询问
- [ ] 本地目录存储：新建/保存/历史/回收站
- [ ] 图片附件：粘贴上传 → 重启后仍可显示
- [ ] 导出 Markdown：无附件 `.md`；有附件 `assets/` 目录
- [ ] S3 源（可选）：连接、同步、409 冲突 UI
- [ ] 跨源迁移 file ↔ S3：正文、历史、附件均保留

## 自定义后台（可选）

- [ ] `npm run backend:dev` 启动；客户端登录注册
- [ ] 工作区页面 CRUD + 附件上传/下载
- [ ] 乐观锁：两客户端改同一页 → 409 + diff UI
- [ ] 生产环境设置强随机 `TIE_JWT_SECRET`（≥32 字符，禁用默认值）
- [ ] 生产环境 `TIE_BIND=127.0.0.1` 或正确配置 `TIE_CORS_ORIGIN`

## 文档与产物

- [ ] `CHANGELOG.md` 已更新 1.0.0 条目
- [ ] README 安装说明与「已知限制」准确
- [ ] GitHub Release 附 `.deb` / `.rpm` / `.msi` / `.exe`（NSIS）、对应 `.sig` 与 `latest.json`
- [ ] PackHub 已同步 apk / deb / exe，且 `https://3ye.co:32810/v1/tie/site/tauri-latest.json` 版本号正确
- [ ] 版本号一致：`package.json`、`src-tauri/tauri.conf.json`、`backend/package.json`

## 已知限制（1.0 可接受，需在 Release Notes 写明）

- 不支持 backend 工作区 ↔ backend-s3 Provider 互迁
- 不支持两个 backend-s3 Provider 互迁
- 涉及后台源的页面迁移不保留历史版本
- 浏览器演示模式不支持真实附件存储（需桌面端或连后台）
- 无多用户协作与细粒度权限
- 自动更新需 Release 已配置 updater 签名 Secret；开发模式（`tauri:dev`）不会检查更新
