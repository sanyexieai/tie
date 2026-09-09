---
name: tie-memory
description: "Use Tie MCP for durable project memory: decisions, bugs, preferences, notes, and external file resources (PDF etc.). Trigger when the user asks to remember something, ingest a book/file, link notes to original files, record an ADR, or when a durable insight should outlive the current session."
---

# Tie 外接知识库（本地 MCP）

本文件是默认模板。用户在 Tie 里接入后，Skill 真相源是本地 `SKILL.md` 文件。

通过 MCP tools 读写工作区 `pages/*.md` 与 `.tie/files/`，与 Tie 桌面端看到的是同一份文件。**不需要**启动 Tie Backend。

## 何时写入

- 架构决策、取舍与否决方案 → `tie_write` + `kind: "decision"`
- 排障结论、坑点 → `kind: "bug"`
- 用户长期偏好 → `kind: "preference"`
- 一般备忘 → `kind: "note"`
- PDF/书籍/其它外部文件 → 先 `tie_file_ingest`，再用 `tie_write` 整理摘要与笔记

会话里临时推理、一次性命令输出：**不要**入库。

## 操作顺序

1. 先 `tie_search` / `tie_list_recent`（可加 `tag: "memory"` / `resource`）避免重复页
2. 需要全文时用 `tie_get`
3. 关联上下文用 `tie_related`
4. 外部文件用 `tie_file_ingest` / `tie_file_list` / `tie_file_get`
5. 新建或更新用 `tie_write`（不要手写 frontmatter）

## 正文链接协议（必须遵守）

桌面端按协议区分样式并打开；**写正文时选用正确协议**，不要混用。

| 用途 | 协议 / 写法 | 桌面样式 | 何时用 |
|------|-------------|----------|--------|
| 页面互链 | `[[标题]]` 或 `[标题](tie://page/{pageId})` | 普通链接 | 关联其它笔记页 |
| 已登记文件/目录 | `[标题](tie://file/{fileId})` | 副本 / 外链 / 目录 | **外部**资源，须先 `tie_file_ingest` |
| 工作区内相对路径 | `[标题](tie://path/{相对路径})` | 相对 | 文件已在工作区目录内（相对工作区根；POSIX；禁止 `..`） |
| 本机绝对路径 | `[标题](file:///...)` | 绝对 | **不推荐**作稳定链接；跨机器易失效，打开行为依赖本机 |
| 页面图片附件 | `![](tie://asset/{pageId}/{文件名})` | 图片 | 由桌面上传产生；不要手写伪造 |

约定摘要：

- **稳定外链资源** → 只写 `tie://file/{id}`（ingest 返回的 `url`）
- **工作区内部路径** → 写 `tie://path/docs/spec.pdf`（相对根目录）
- **不要**把 `file:///` 当成登记协议的替代品
- `tie://path/` 与 `file:///` **互不影响**：绝对路径协议与行为保持不变

示例：

```markdown
参见 [[排障手册]] 与 [ADR](tie://page/pg_xxx)

[手册 PDF（工作区副本）](tie://file/file_abc)
[资料夹（外链）](tie://file/file_dir1)
[工作区内规格](tie://path/docs/spec.pdf)
```

## 外部文件 / 目录（副本 / 外链）

主入口是 MCP，不是桌面「文件库」页。外部文件/目录必须先 `tie_file_ingest`，再用返回的 `tie://file/{id}` 写入正文。

### 选 mode

- `copy`：导入工作区副本（`.tie/files/{id}/`），适合希望跟知识库一起备份的小中型文件；目录会递归复制到 `{id}/original/`
- `link`：只记录本机原路径，适合大文件、已有书库**目录**；跨机器可能失效

二者在编辑器中样式不同（副本=实心芯片，外链=描边芯片），但链接协议相同：`tie://file/{fileId}`。目录资源 `kind: "directory"`，点击由系统文件管理器打开。

### 标准流程（书 / PDF / 文件夹）

1. `tie_file_ingest`：`path` + `mode`（+ 可选 `title`）→ 拿到 `id`、`kind`、`mime`/`ext`/`size`、`url`
2. 阅读原文件或依据用户说明，提炼**类型、摘要、要点**（MCP 只提供元数据与文本类 preview，不做 PDF 全文解析）
3. `tie_write` 建书目/摘录页：`tags` 含 `resource`（可再加主题标签）
4. 正文放入资源链接：
   - 副本：`[书名（工作区副本）](tie://file/{id})`
   - 外链：`[书名（原文件）](tie://file/{id})`
   - 目录：`[资料夹](tie://file/{id})`
   - 若文件本就在工作区内：`[说明](tie://path/相对路径)`（无需 ingest）
5. 相关笔记用 `[[页面标题]]` / `tie://page/...` 互链；需要打开已登记路径时用 `tie_file_open_hint`

### 禁止

- 把整份 PDF/二进制塞进 `markdown`
- 把 `tie_file_ingest` 的整段 JSON 当作正文写入（只要提炼后的 Markdown）
- 手写 frontmatter 假装登记文件（必须走 `tie_file_*`）
- 手写 `file:///...` 当作工作区资源链接（外部资源走 `tie_file_ingest` → `tie://file/{id}`；区内文件走 `tie://path/…`）

## 写入规则

- 创建：提供 `title` + `markdown`/`body`，可选 `kind`、`tags`、`parentTitle` / `parentId`
- `markdown` / `body` 必须是**纯 Markdown 正文**，不要传包含 `id/title/markdown` 的 JSON 包装字符串
- 更新：必须带 `pageId`（或 `matchTitle: true` 且标题精确匹配）
- **父子树**：用 `parentTitle` / `parentId` 写入 frontmatter `parent_id`；侧栏与编辑器底部子页列表由客户端按 id 渲染，**不要**在父页正文维护子链接
- `#标签` 仍走 frontmatter `tags`
- 禁止写入密钥、token、密码、私钥
