# Changelog

All notable changes to Tie are documented in this file.

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

[Unreleased]: https://github.com/sanyexieai/tie/compare/v1.0.18...HEAD
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
