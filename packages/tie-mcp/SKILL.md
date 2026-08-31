---
name: tie-memory
description: "Use Tie MCP for durable project memory: decisions, bugs, preferences, and notes. Trigger when the user asks to remember something, record an ADR, look up prior decisions, or when a durable insight should outlive the current session."
---

# Tie 外接知识库（本地 MCP）

本文件是默认模板。用户在 Tie 里接入后，Skill 真相源是本地 `SKILL.md` 文件。

通过 MCP tools 读写工作区 `pages/*.md`，与 Tie 桌面端看到的是同一份文件。**不需要**启动 Tie Backend。

## 何时写入

- 架构决策、取舍与否决方案 → `tie_write` + `kind: "decision"`
- 排障结论、坑点 → `kind: "bug"`
- 用户长期偏好 → `kind: "preference"`
- 一般备忘 → `kind: "note"`

会话里临时推理、一次性命令输出：**不要**入库。

## 操作顺序

1. 先 `tie_search` / `tie_list_recent`（可加 `tag: "memory"`）避免重复页
2. 需要全文时用 `tie_get`
3. 关联上下文用 `tie_related`
4. 新建或更新用 `tie_write`（不要手写 frontmatter）

## 写入规则

- 创建：提供 `title` + `markdown`/`body`，可选 `kind`、`tags`、`parentTitle`
- 更新：必须带 `pageId`（或 `matchTitle: true` 且标题精确匹配）
- 正文用 Markdown；可用 `[[页面标题]]` 做链接
- 禁止写入密钥、token、密码、私钥
