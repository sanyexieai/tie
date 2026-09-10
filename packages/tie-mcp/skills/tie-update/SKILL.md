---
name: tie-update
description: >-
  Version-gated Tie workspace data follow-up after a specific migration.
  Use ONLY when the current update/changelog names a migration that needs
  Agent cleanup, or the user reports leftovers for that migration (e.g.
  remaining file:/// after href-file-protocol-v1). Do NOT run on every
  Tie app update.
---

# Tie 更新收尾（按迁移版本，非整次更新）

**默认不启用。** 普通版本升级只同步 MCP/Skill 模板；只有发布说明 / 迁移目录里标了「需 Agent 收尾」的项，才跟本 Skill。

## 何时用 / 何时不用

| 用 | 不用 |
|----|------|
| 更新说明写明：迁移 `id` 需 Agent 扫漏 | 用户只说「刚更新了 Tie」且无具体迁移 |
| 用户点名残留（如仍见 `file:///`、链接样式不对且 stamp 已打） | 与历史数据无关的功能更新、纯 UI/性能 |
| `tie_migration_status` 返回某项 `agentFollowUp: true` 且 `remaining > 0` | stamp 未 applied：先让用户重启 Tie 跑脚本，Agent 不抢跑 |

## 迁移目录（随版本增删）

发布方在目录里登记；**没有条目 = 本次更新不需要本 Skill**。

| migration id | 引入背景 | Agent 收尾？ | 残留信号 |
|--------------|----------|--------------|----------|
| `href-file-protocol-v1` | 禁止正文 `file:///`，改相对/绝对协议 | **是**（启动只改区内相对路径；区外大目录不 ingest） | 正文仍含 `file:///` |

以后新迁移：改本表 + MCP 目录；若该项不需 Agent，标「否」或不要挂本 Skill。

## 标准流程（仅针对当前勾选的 migration id）

1. `tie_migration_status`（可传 `migrationId`）确认 stamp 与是否 `agentFollowUp`。  
   - 未 applied → 请用户重启 Tie / `npm run migrate:file-hrefs`，**本轮停**。  
   - applied 且 remaining=0 → 结束，不必改页。
2. 仅处理该 id 的残留（如 `href-file-protocol-v1` → 扫 `file:///`）。
3. 逐页：`tie_get` → 区内写 `tie://path/…` / 区外 `tie_file_ingest` mode=link → `tie_write`。
4. 再 status 一次；可选 `tie_write` note 记结果（含 migration id）。

## `href-file-protocol-v1` 改写规则（仅此项）

- 区内路径 → `tie://path/{sourceId}/{相对路径}`
- 区外 → ingest `link`，正文只用返回的 `tie://file/…`
- 禁止留下 `file:///`；不要清 stamp 全库重跑（除非用户明确要求）

## 禁止

- 因「有更新」就主动全库扫一遍  
- 对手册未列出的迁移瞎猜流程  
- 手写 frontmatter；把 ingest JSON 塞进正文
