---
name: tie-memory
description: "Use Tie MCP for durable project memory: decisions, bugs, preferences, notes, and external file resources (PDF etc.). Trigger when the user asks to remember something, ingest a book/file, link notes to original files, record an ADR, or when a durable insight should outlive the current session."
---

# Tie 外接知识库

本文件是默认模板。用户在 Tie 里接入后，Skill 真相源是本地 `SKILL.md` 文件。

通过 MCP tools 读写工作区。纯本地模式访问 `pages/*.md` 与 `.tie/files/`，与 Tie 桌面端使用同一份文件，无需启动后台。已绑定服务器时，`tie mcp` 先检查健康状态，正常时通过 HTTP 访问后台工作区；本地副本由同步进程对齐。

## 连接与授权

- 有本地工作区时保留本机 `tie mcp` 入口；后台正常时数据请求走 HTTP。无应用的原生 HTTP Agent 可直接连接服务器 `/mcp`。
- 优先读取同源的本地登录会话；没有登录会话时，由用户主动提供 MCP token。CLI 远程模式可用 `TIE_MCP_URL` + `TIE_MCP_TOKEN_FILE`，无需本地工作区。密钥不得写进页面或提交仓库。
- HTTP 异常不得自动转本地。先调用 `tie_connection`（`action: "status"`）查看故障与 `confirmationId`，说明故障及本地副本位置，并取得用户明确同意；再调用 `action: "confirm_local"`、该 `confirmationId` 与 `confirmed: true`。许可仅覆盖当前故障期，HTTP 成功后撤销。纯本地工作区无需确认。
- 接入细节见 `tie-mcp-connect`；验证时用 `tie_doctor.transport` 确认实际通道，不能仅看工具列表。

## 何时写入

- 架构决策、取舍与否决方案 → `tie_write` + `kind: "decision"`
- 排障结论、坑点 → `kind: "bug"`
- 用户长期偏好 → `kind: "preference"`
- 一般备忘 → `kind: "note"`
- PDF/书籍/其它外部文件 → 先 `tie_file_ingest`，再用 `tie_write` 整理摘要与笔记

会话里临时推理、一次性命令输出：**不要**入库。

## 操作顺序

1. 先用 `tie_tree({depth: 1})` 看顶层分类，按主题用 `root` 逐级展开相关分支，不反复输出整棵树
2. 在选定分类内用 `tie_search` 的 `root` 检索，按需用 `exclude` 排除无关分支；可叠加 `tag: "memory"` / `resource`，用于查找知识及避免重复页
3. 需要全文时用 `tie_get`；关联上下文用 `tie_related`
4. 新知识尽量选定合适的已有分类，通过 `parentId` 写入；更新已有页使用 `pageId`，不顺便重排分类
5. 外部文件用 `tie_file_ingest` / `tie_file_list` / `tie_file_get`；正文与笔记通过 `tie_write` 写入（不要手写 frontmatter）

## 按树检索与分类

树节点就是页面，父子关系表达知识分类。`tie_tree` 只返回节点摘要，不返回正文：

- `depth` 为返回层数，范围 `1..8`，默认 `2`；传入 `root` 时，该节点算第一层
- `root` 可用页面 ID 或唯一标题；分类标题可能重名，优先使用树中返回的 ID
- `childCount` 是直接子节点数；`childrenTruncated: true` 表示还有未展开的子节点，不代表叶子

推荐逐级查看：`tie_tree({depth: 1})` → `tie_tree({root: "pg_project", depth: 2})` → 选更具体的分类节点。只展开与当前问题有关的分支。

搜索示例：`tie_search({query: "部署", root: "pg_project", exclude: ["pg_archive"], limit: 8})`。

- `root` 包含选定节点自身及其全部后代；不传时可搜索整个工作区
- `exclude` 是节点 ID 或唯一标题数组，排除各节点及其全部后代；排除优先于包含
- 先按树范围筛候选，再评分与取 `limit`，无关分支不会占用结果名额
- 结果中的 `breadcrumb` 只含分类路径的 `id` / `title`，从顶层到父节点，不含命中页自身；根据路径确认结果所属分类后再读全文

相关分类内没有足够结果时，再有意识地扩大到父分类或其他分支。不要把“本次范围内无结果”说成整个知识库都没有这项知识。`tie_list_recent` 可用于了解近期变化，但不能替代按分类检索。

写入时尽量复用最细且稳定的已有分类，逐级确定归属，例如已有的“研究 → 数据库 → PostgreSQL”。分类不是必填项：没有合适分类时可以直接写入，不因此阻断保存。不要为每条知识硬造多层目录，也不要自动搬动旧页面；只有用户明确需要时才新建分类页。

本机 `tie_write`、`tie_import`、`tie_file_ingest` 成功后会尽力同步一次。结果中的 `sync.state` 为 `synced`（本轮成功）、`pending`（本地已保存但仍待同步）或 `skipped`（未绑定服务器）；向用户说明时区分落盘成功和同步完成。后台 HTTP 写入不反向启动同步。本机文件登记、打开提示及导入导出只由本机 CLI 提供，原生 HTTP Agent 不提供宿主文件访问。

有服务器绑定时，宿主文件操作也先检查服务器；HTTP 故障未经用户确认不得执行。它们仍在本机处理，不将本机路径发送给后台，不能利用这些工具绕过降级确认。

## 正文链接协议（必须遵守）

桌面端按协议区分样式并打开；**写正文时选用正确协议**，不要混用。

| 用途 | 协议 / 写法 | 桌面样式 | 何时用 |
|------|-------------|----------|--------|
| 页面互链 | `[[标题]]` 或 `[标题](tie://page/{pageId})` | 普通链接 | 关联其它笔记页 |
| 绝对登记（区外文件/目录） | `[标题](tie://file/{sourceId}/{fileId})`；旧写法 `tie://file/{fileId}` 缺省当前页源 | 登记；找不到文件会标缺失 | **外部**资源，须先 `tie_file_ingest` mode=link |
| 相对路径（区内文件，含 copy 导入） | `[标题](tie://path/{sourceId}/{相对路径})`；旧写法可省略 sourceId | 相对 | 文件已在该存储源内（含 `.tie/files/{id}/original…`、图片附件） |
| 页面图片附件 | `![](tie://asset/{pageId}/{文件名})` | 图片 | 相对路径的显示别名，对应 `.tie/assets/{pageId}/{文件名}`；由桌面上传产生 |

约定摘要：

- **区外资源** → `tie_file_ingest` mode=`link`，正文只写返回的 `tie://file/…`（不要写 `file:///`）
- **导入副本 / 区内文件** → `tie://path/…`（相对该存储源根；POSIX；禁止 `..`）
- **不要**把手写 `file:///` 当作稳定链接；桌面会在粘贴时改写成 path 或 file
- 新链接带上 `sourceId`（`src_local_…` / `s3:…`），以便跨存储源解析。`tie_file_ingest` 会从环境变量 `TIE_SOURCE_ID` / `TIE_STORAGE_SOURCE_ID`，或工作区页面的 `storage_source_id` 推断并写入 URL。

示例：

```markdown
参见 [[排障手册]] 与 [ADR](tie://page/pg_xxx)

[手册 PDF（工作区副本）](tie://path/src_local_2e27348a0aa628a6/.tie/files/file_abc/original.pdf)
[资料夹（登记）](tie://file/src_local_2e27348a0aa628a6/file_dir1)
[工作区内规格](tie://path/src_local_2e27348a0aa628a6/docs/spec.pdf)
```

## 外部文件 / 目录

主入口是 MCP，不是桌面「文件库」页。区外文件/目录必须先 `tie_file_ingest`，再用返回的 `url` 写入正文。

### 选 mode

- `copy`：导入工作区副本（`.tie/files/{id}/original…`），正文用返回的 **相对** `tie://path/…`；适合要跟知识库一起走的小中型文件
- `link`：只登记本机原路径，正文用 **绝对** `tie://file/…`；适合大文件、已有书库目录。换机器会显示「找不到」，可重新绑定

目录资源 `kind: "directory"`，点击由系统文件管理器打开。

### 标准流程（书 / PDF / 文件夹）

1. `tie_file_ingest`：`path` + `mode`（+ 可选 `title`）→ 拿到 `id`、`kind`、`url`
2. 阅读原文件或依据用户说明，提炼**类型、摘要、要点**（MCP 只提供元数据与文本类 preview，不做 PDF 全文解析）
3. `tie_write` 建书目/摘录页：`tags` 含 `resource`（可再加主题标签）
4. 正文放入 ingest 返回的 `url`（不要手写 `file:///`）
5. 相关笔记用 `[[页面标题]]` / `tie://page/...` 互链；需要打开已登记路径时用 `tie_file_open_hint`

### 禁止

- 把整份 PDF/二进制塞进 `markdown`
- 把 `tie_file_ingest` 的整段 JSON 当作正文写入（只要提炼后的 Markdown）
- 手写 frontmatter 假装登记文件（必须走 `tie_file_*`）
- 手写 `file:///...` 当作工作区资源链接

## 版本化数据收尾（可选）

普通升级不同步跑全库清洗。仅当某次发布引入的 migration（如 `href-file-protocol-v1`）在目录中标了需 Agent 收尾、且 stamp 后仍有残留时，才用 Skill **`tie-update`** + `tie_migration_status`。详见 `skills/tie-update/SKILL.md`。

## 写入规则

- 创建：提供 `title` + `markdown`/`body`，可选 `kind`、`tags`、`parentTitle` / `parentId`；尽量先按树选分类，优先传明确的 `parentId`
- `markdown` / `body` 必须是**纯 Markdown 正文**，不要传包含 `id/title/markdown` 的 JSON 包装字符串
- 更新：必须带 `pageId`（或 `matchTitle: true` 且标题精确匹配）
- **父子树**：用 `parentId` / `parentTitle` 指定父节点；元数据由 `tie_write` 管理，侧栏与编辑器底部子页列表按 id 渲染。重名分类使用 ID，**不要**在父页正文维护子链接。未提供分类仍允许写入；更新时不传父节点可保留原归属
- `#标签` 仍走 frontmatter `tags`
- 禁止写入密钥、token、密码、私钥
