---
name: tauri-dev-restart-loop
description: >-
  Prevents and fixes Tie tauri:dev unexplained restart loops caused by Cursor
  checkpoints rewriting src-tauri (especially lib.rs). Use when the app keeps
  rebuilding/restarting without user edits, when the user says 程序总是重启 /
  又有写入没关 / File src-tauri changed Rebuilding, or before long Rust edits
  while npm run tauri:dev is running.
---

# Tie：`tauri:dev` 无故反复重启

## 根因（必须先认清）

不是 Tie 业务代码在循环写盘。常见元凶是 **Cursor checkpoint** 后台把旧内容写回仓库，尤其是：

- `src-tauri/src/lib.rs`
- 其它 `src-tauri/src/*.rs`

`npm run tauri:dev` 一旦看到 Rust 文件变化就会 **整窗重编译并重启**，表现为「程序自己总在重启」。

终端典型日志：

```text
Info File src-tauri/src/lib.rs changed. Rebuilding application...
Running DevCommand (`cargo run ...`)
```

## 立刻处理

1. **先停手**：不要继续改 `src-tauri`，避免和 checkpoint 写回打架。
2. **清掉本仓库相关 checkpoint**（优先跑脚本）：

```bash
python3 scripts/clear-tie-checkpoints.py
```

3. 观察 `src-tauri/src/lib.rs` 的 mtime 是否还在变；若 15–30 秒内仍被改，再跑一次脚本并检查是否还有其它进程在写仓库。
4. 确认 `tauri:dev` 终端停在 `Running target/debug/tie` 且不再出现 `Rebuilding application`。

## 开发时禁止事项

- **禁止**为了「省事」长期开着会回写 `src-tauri` 的 checkpoint / 自动恢复，却同时跑 `tauri:dev`。
- **禁止**在排查重启时乱改业务逻辑「试能不能修好」；先清 checkpoint。
- **不要**把知识库 / workspace `pages/` 建在本仓库目录里（会触发 Vite 无意义 HMR；虽通常不重编 Rust，但会干扰判断）。

## 正常 vs 异常

| 现象 | 判断 |
|------|------|
| 你刚改了 `.rs` / `Cargo.toml` 后重启一次 | 正常 |
| 没人改代码，每隔几分钟整窗重启 | 异常 → 清 checkpoint |
| 只有 Vite `hmr update`、窗口不关 | 前端热更新，不是本问题 |

## 脚本说明

`scripts/clear-tie-checkpoints.py`：删除 Cursor checkpoints 目录里涉及本仓库绝对路径的条目。可重复执行。
