# Changelog

All notable changes to Tie are documented in this file.

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

[Unreleased]: https://github.com/sanyexieai/tie/compare/v1.0.42...HEAD
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
