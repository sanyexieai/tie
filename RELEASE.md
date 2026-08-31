# Tie 1.0 发布前检查清单

在创建 `v1.0.0` tag 并上传安装包前，请逐项确认。

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
- [ ] GitHub Release 附 `.deb` / `.rpm` / `.msi` / `.exe`（NSIS）等对应平台产物
- [ ] 版本号一致：`package.json`、`src-tauri/tauri.conf.json`、`backend/package.json`

## 已知限制（1.0 可接受，需在 Release Notes 写明）

- 不支持 backend 工作区 ↔ backend-s3 Provider 互迁
- 不支持两个 backend-s3 Provider 互迁
- 涉及后台源的页面迁移不保留历史版本
- 浏览器演示模式不支持真实附件存储（需桌面端或连后台）
- 无多用户协作与细粒度权限
