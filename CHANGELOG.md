# Changelog

All notable changes to Tie are documented in this file.

## [1.0.53] - 2026-11-25

- 左下角设置区域低调显示真实同步阶段与处理数量，包括文档、附件、文件和批注。
- 保留连接状态和原有布局；同步结束恢复常态，悬停可查看工作区、最近完成时间及异常详情。

## [1.0.52] - 2026-11-25

- 修复桌面端登录后首次同步、大工作区同步及会话刷新占用窗口主线程，导致整个应用无响应的问题。
- 后台注册、管理员创建与改名统一检查用户名唯一，阻止大小写或前后空格不同的重名账号。
- 管理页注册或登录后保留会话，普通用户自动进入“我的账号”；修复刷新账号页时丢失访问令牌的问题。
- Linux 开发版使用独立启动入口，避免与已安装的正式版混淆。

## [1.0.51] - 2026-11-25

- 统一网页登录、桌面后台同步与 Rust MCP；修复网页登录空工作区无法创建首篇文档和会话续期后的通知连接。
- 同步双向补齐附件、文件登记与单文件副本；双端冲突保留双方，永久删除的已同步回收站页面不再复活。
- 修复跨源迁移失败后删除源数据或误删目标副本的问题。
- 修复阅读视图危险链接、后台资源路径校验、压缩包解包越界和后台会话凭据边界。
- 补齐桌面 CLI 准备、签名发布和飞牛部署流程；迁移旧后台的账号、文档、历史和文件，保留原密码登录。
- 后台仍不支持目录副本同步；此类情况明确提示未同步并保留本地目录。

## [1.0.50] - 2026-10-16

- 修复桌面正式版发现 PackHub 更新后直接进入手动下载、跳过自动更新插件的问题。
- 优先检查签名自动更新，插件失败或旧更新源未发现版本时再回退到清单下载。
- 增加自动安装与重启、手动回退和更新检查失败的回归测试。

## [1.0.49] - 2026-10-15

- 支持 Mermaid 代码块图表预览，保留源码编辑及 Markdown 保存格式。
- 空流程图显示节点示例，语法错误显示提示，修改源码后自动重新渲染。
- 增加流程图、时序图、错误恢复及 Markdown 源码保留的浏览器回归测试。

## [1.0.48] - 2026-09-29

- 修复附件指向离线自动挂载磁盘时，启动及页面切换卡死的问题。
- 附件列表和路径可用性检查移出界面主线程；文件探测增加 150 毫秒等待上限和最多 4 个并发系统调用。
- Linux 自动跳过尚未挂载的 autofs 路径，保留离线附件的名称、路径和目录类型；磁盘挂载后可重新探测。
- 增加离线挂载、已挂载磁盘、探测超时、并发耗尽恢复及附件元数据保留的回归测试。

## [1.0.47] - 2026-09-24

- 修复顶部“云”数据源菜单被容器裁剪、点击后不可见的问题，保留状态文本省略。

## [1.0.46] - 2026-09-24

- 修复桌面端最后一页无法删除且无提示的问题。
- 防止排队中的旧草稿将回收站页面重新恢复；保留显式恢复操作。
- 页面删除失败时在侧栏显示具体错误。

## [1.0.45] - 2026-09-24

- 修复离线删除页面后，重新连接后台时未同步回收站状态的问题。
- 删除或恢复页面时，云端同步失败不再被静默忽略。
- 添加页面删除同步回归测试。

## [1.0.44] - 2026-09-22

- 默认后台服务启用默认弹窗。
- 优化窄窗口下的面包屑和保存状态布局。

## [1.0.43] - 2026-09-22

- 优化后台服务设置与高级选项，更新默认服务地址。
- 合并本地与后台数据源显示，改进自动同步。

## [1.0.2] - 2026-09-01

## [1.0.3] - 2026-09-01

## [1.0.4] - 2026-09-01

## [1.0.5] - 2026-09-01

## [1.0.6] - 2026-09-01

## [1.0.7] - 2026-09-02

## [1.0.8] - 2026-09-02

## [1.0.9] - 2026-09-02

## [1.0.10] - 2026-09-02

## [1.0.11] - 2026-09-02

## [1.0.12] - 2026-09-02

## [1.0.13] - 2026-09-02

## [1.0.14] - 2026-09-02

## [1.0.15] - 2026-09-02

## [1.0.16] - 2026-09-02

## [1.0.17] - 2026-09-02

## [1.0.18] - 2026-09-02

## [1.0.19] - 2026-09-03

## [1.0.20] - 2026-09-03

## [1.0.21] - 2026-09-03

## [1.0.22] - 2026-09-03

## [1.0.23] - 2026-09-06

## [1.0.24] - 2026-09-06

## [1.0.25] - 2026-09-06

## [1.0.26] - 2026-09-06

## [1.0.27] - 2026-09-06

## [1.0.28] - 2026-09-06

## [1.0.29] - 2026-09-06

## [1.0.30] - 2026-09-09

## [1.0.31] - 2026-09-09

## [1.0.32] - 2026-09-09

## [1.0.33] - 2026-09-09

## [1.0.34] - 2026-09-09

## [1.0.35] - 2026-09-10

## [1.0.36] - 2026-09-10

## [1.0.37] - 2026-09-10

## [1.0.38] - 2026-09-13

### Improved

- 全局和局部知识图谱文字自动避让，优先显示悬停节点、当前页面及连接较多的节点。
- 缩放时保持字号稳定，放大后显示更多名称；悬停显示更完整的标题，文字描边减少连线干扰。

## [1.0.39] - 2026-09-14

### Fixed

- 打包后的 Tie MCP 因找不到仓库外的 `shared/file-meta.js` 无法启动。

### Changed

- 桌面端默认从 PackHub 检查更新（GitHub 作为回退）；打 tag 发布时 CI 会把安装包同步到 PackHub。

## [1.0.40] - 2026-09-14

### Fixed

- GitHub Actions 向 PackHub 上传大 APK 时不再因 300 秒超时失败（加长超时并重试）。

## [1.0.41] - 2026-09-16

## [1.0.42] - 2026-09-16

## [Unreleased]

### Added

- Playwright browser E2E smoke tests (workspace load, navigation, Markdown export).
- Backend API integration tests (auth, workspace pages, optimistic locking, assets).
- Linux Tauri build step in CI.
- Release checklist (`RELEASE.md`).

### Added

- Production backend security: JWT secret validation, loopback bind default, configurable CORS.
- Tauri CSP and tightened capability permissions for dialog/opener plugins.
- User-facing install, backup, and known-limitations documentation in README.

### Changed

- Backend refactored to export `createApp()` for testability; data directory configurable via `TIE_DATA_DIR`.
- Generated desktop app icons; Linux CI bundles `.deb` and `.rpm` (AppImage deferred).

## [0.1.0] - 2026-08-28

### Added

- Notion-style page tree, Tiptap/Typora-style editor, tags, links, and knowledge graph.
- Multi-storage providers: local/SMB directories, S3, custom Express backend, backend-s3 proxy.
- Offline sync queue, S3 incremental sync, conflict detection with diff UI.
- Page attachments (`tie://asset/`) with cross-source migration and Markdown export bundling.
- Express backend with JWT auth, workspace pages, S3 providers, and AI tag suggestions.
- Unit tests for sync merge, attachments, transfer policy, and sync queue.

[Unreleased]: https://github.com/sanyexieai/tie/compare/v1.0.49...HEAD
[1.0.49]: https://github.com/sanyexieai/tie/releases/tag/v1.0.49
[1.0.42]: https://github.com/sanyexieai/tie/releases/tag/v1.0.42
[1.0.41]: https://github.com/sanyexieai/tie/releases/tag/v1.0.41
[1.0.40]: https://github.com/sanyexieai/tie/releases/tag/v1.0.40
[1.0.39]: https://github.com/sanyexieai/tie/releases/tag/v1.0.39
[1.0.38]: https://github.com/sanyexieai/tie/releases/tag/v1.0.38
[1.0.37]: https://github.com/sanyexieai/tie/releases/tag/v1.0.37
[1.0.36]: https://github.com/sanyexieai/tie/releases/tag/v1.0.36
[1.0.35]: https://github.com/sanyexieai/tie/releases/tag/v1.0.35
[1.0.34]: https://github.com/sanyexieai/tie/releases/tag/v1.0.34
[1.0.33]: https://github.com/sanyexieai/tie/releases/tag/v1.0.33
[1.0.32]: https://github.com/sanyexieai/tie/releases/tag/v1.0.32
[1.0.31]: https://github.com/sanyexieai/tie/releases/tag/v1.0.31
[1.0.30]: https://github.com/sanyexieai/tie/releases/tag/v1.0.30
[1.0.29]: https://github.com/sanyexieai/tie/releases/tag/v1.0.29
[1.0.28]: https://github.com/sanyexieai/tie/releases/tag/v1.0.28
[1.0.27]: https://github.com/sanyexieai/tie/releases/tag/v1.0.27
[1.0.26]: https://github.com/sanyexieai/tie/releases/tag/v1.0.26
[1.0.25]: https://github.com/sanyexieai/tie/releases/tag/v1.0.25
[1.0.24]: https://github.com/sanyexieai/tie/releases/tag/v1.0.24
[1.0.23]: https://github.com/sanyexieai/tie/releases/tag/v1.0.23
[1.0.22]: https://github.com/sanyexieai/tie/releases/tag/v1.0.22
[1.0.21]: https://github.com/sanyexieai/tie/releases/tag/v1.0.21
[1.0.20]: https://github.com/sanyexieai/tie/releases/tag/v1.0.20
[1.0.19]: https://github.com/sanyexieai/tie/releases/tag/v1.0.19
[1.0.18]: https://github.com/sanyexieai/tie/releases/tag/v1.0.18
[1.0.17]: https://github.com/sanyexieai/tie/releases/tag/v1.0.17
[1.0.16]: https://github.com/sanyexieai/tie/releases/tag/v1.0.16
[1.0.15]: https://github.com/sanyexieai/tie/releases/tag/v1.0.15
[1.0.14]: https://github.com/sanyexieai/tie/releases/tag/v1.0.14
[1.0.13]: https://github.com/sanyexieai/tie/releases/tag/v1.0.13
[1.0.12]: https://github.com/sanyexieai/tie/releases/tag/v1.0.12
[1.0.11]: https://github.com/sanyexieai/tie/releases/tag/v1.0.11
[1.0.10]: https://github.com/sanyexieai/tie/releases/tag/v1.0.10
[1.0.9]: https://github.com/sanyexieai/tie/releases/tag/v1.0.9
[1.0.8]: https://github.com/sanyexieai/tie/releases/tag/v1.0.8
[1.0.7]: https://github.com/sanyexieai/tie/releases/tag/v1.0.7
[1.0.6]: https://github.com/sanyexieai/tie/releases/tag/v1.0.6
[1.0.5]: https://github.com/sanyexieai/tie/releases/tag/v1.0.5
[1.0.4]: https://github.com/sanyexieai/tie/releases/tag/v1.0.4
[1.0.3]: https://github.com/sanyexieai/tie/releases/tag/v1.0.3
[1.0.2]: https://github.com/sanyexieai/tie/releases/tag/v1.0.2
[0.1.0]: https://github.com/example/tie/releases/tag/v0.1.0
