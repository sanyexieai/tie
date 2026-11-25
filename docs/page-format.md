# Tie Page Format Spec (`tie_version: 1`)

本地工作区以磁盘上的 Markdown 为唯一真相源。CLI、MCP、桌面/Android UI 必须读写同一格式。

**同步语义**（保存无感、Git / 后台、源模型）见 [`sync.md`](./sync.md)。

## 工作区布局

```
<workspace>/
  <根页面标题>.tie          # 每个根页面一份；重名时为 <标题>-2.tie
  pages/<标题>.md          # 重名时为 <标题>-2.md、<标题>-3.md；正文是普通 Markdown
  .tie/
    meta/<page_id>         # Tie 页面元数据（id、父级、排序、标签、时间）
    history/<page_id>/<revision_id>.md
    assets/<page_id>/<filename>
    files/                 # 登记文件元数据与 copy 副本
```

- `pages/`：当前页面（软删页面仍保留文件，见 sidecar 的 `deleted_at`）。文件名用标题；同名的另一页单独写成 `<标题>-2.md`，不会覆盖。页面身份是 `.tie/meta/<id>` 里的 `id`，不写进正文。普通 Markdown 和外来 YAML 原样保留。旧的带 Tie frontmatter 的 `pages/*.md` 仍可读；下次保存时去掉这份头，正文不改。
- `.tie/meta/<page_id>`：这一页的 Tie 元数据。载入普通 Markdown 时只新增这个文件，不改 `pages/*.md`。
- `<根页面标题>.tie`：每个未删除的根页面（`parent_id` 为空）一份。文件名用该页标题，重名写成 `<标题>-2.tie`。文件里的 `root_page` 是页面 id；标题改了会跟着改名，不会另存一份。没有根页面时，才按目录名保留一份工作区入口。
- `.tie/history/`：写入更新前归档的旧版本（每页最多保留 80 个）。
- `.tie/assets/`：页面图片等附件；正文用 `tie://asset/<page_id>/<filename>` 引用。
- `.tie/files/`：外部文件/目录登记（`tie://file/…`）与 copy 导入副本（`tie://path/…`）。
- **`.tiez`**：同一棵树的压缩携带形态（`tie pack` / `tie unpack`）；解压后与磁盘工作区 1:1。

### 解决方案文件（`.tie`）

```text
# Tie solution — open with Tie / `tie open`
tie_version: 1
kind: solution
name: My Notes
root: .
source_id: src_local_0123456789abcdef
root_page: pg_0123456789abcdef
```

| 字段 | 说明 |
|------|------|
| `tie_version` | 解决方案格式版本（当前 `1`） |
| `kind` | 固定 `solution` |
| `name` | 显示名，根页面文件里是该页标题 |
| `root` | 相对本文件所在目录的工作区根，默认 `.` |
| `source_id` | 默认存储源 id（可被 CLI `--source-id` 覆盖） |
| `root_page` | 作为树根打开的页面 id。工作区里每个根页面一份；导出时也可以是当前子页面。缺省表示整个工作区 |

## 页面文件

`pages/*.md` 就是正文。新建和保存都不再往文件头写 Tie 字段。

```markdown
# 页面标题

正文 Markdown…
```

没有一级标题的原文也合法。显示标题取 `.tie/meta` 里的 `title`（首次登记时用文件名）。载入不会为了标题去改这个文件。

### 元数据文件（`.tie/meta/<page_id>`）

```text
tie_version: 1
id: pg_0123456789abcdef
file: pages/页面标题.md
parent_id:
sort_key: 1
icon: 📝
title: 页面标题
tags: [memory, decision]
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
deleted_at:
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `tie_version` | 是 | 固定 `1` |
| `id` | 是 | `pg_` 开头。创建后不改 |
| `file` | 是 | 相对工作区的正文路径，用 `/` |
| `parent_id` | 可空 | 空 = 顶层。**页面树只认此字段** |
| `sort_key` | 是 | 同级排序 |
| `icon` | 否 | 单行 |
| `title` | 是 | 正文没有 `# ` 标题时用它。有一级标题时以标题为准 |
| `tags` | 是 | `[a, b]` |
| `created_at` / `updated_at` | 是 | ISO-8601 |
| `deleted_at` | 否 | 非空即软删 |

`storage_source_id(s)` 放在应用配置里，不写入 sidecar。

### 旧版 Frontmatter（只读）

文件以 `---\n` 开头，并且块里有 `tie_version:` 或 `id:` 以 `pg_` 开头时，仍按旧 Tie 页面解析。没有这些标记的 YAML（例如 `title:`、`aliases:`）是正文的一部分，载入和打开都不会剥掉，也不会在前面再加 `# 标题`。

历史版本（`.tie/history/`）和远程对象仍保存带这份头的快照，方便旧版本读回。那不是工作区正文格式。

### 标题与正文

- 正文第一个 `# ` 行是标题。没有这种行时，用 sidecar 里的 `title`，再没有则用文件名。
- 载入、打开、导入都不会改写已有 Markdown 的字节。
- 在编辑器里保存时：文件本来就以 `# ` 开头，标题会写回这一行；否则正文按原文保存，标题只更新 sidecar。
- 正文里的 `tie://page/`、`tie://asset/` 等是 Tie 自己的链接，不要求其他 Markdown 工具认识。其余语法按普通 Markdown 写。

### 层级与链接

- **树层级**：只认 `parent_id`。正文里的页面链接**不**维护子页列表。
- **页面链接**（任选）：
  - `[[精确标题]]`
  - `tie://page/{id}`
- **附件**：`tie://asset/{pageId}/{filename}`（对应 `.tie/assets/{pageId}/{filename}`）
- **登记文件（区外）**：`tie://file/{sourceId}/{fileId}`（旧写法 `tie://file/{fileId}` 在写入时补 sourceId）
- **工作区内相对路径**：`tie://path/{sourceId}/{相对路径}`
- **禁止**在 Tie 管理的正文里手写 `file:///`。

### `storage_source_id` 约定

| 形态 | 含义 |
|------|------|
| `src_local_<16hex>` / `src_smb_<16hex>` / `source-demo-local` | 本机 / SMB |
| `backend:…` / `backend-s3:…` | 自定义后台（S3 若使用，由后台托管，不是客户端直连源） |
| `s3:…` | **废弃**：旧版客户端直连桶；可读兼容，勿再新写 |

页面绑定放在应用配置，不写进正文或 sidecar。CLI 本地优先模式由 core 补全；**不要**手写云端源 id。

## 解析与序列化规则

1. `pages/*.md` 可以是普通 Markdown。Tie 元数据在 `.tie/meta/<id>`。
2. 只有开头 `---\n` … `---\n` 里含 `tie_version:` 或 `id` 以 `pg_` 开头，才是旧版 Tie 头。其他 YAML 属于正文。
3. `tags` 使用 `[a, b]`；空 tags 为 `[]`。`parent_id:` 后为空表示顶层。
4. 历史快照仍用 `frontmatter(page)`，`parse` 之后字段与逻辑页一致。
5. 更新已有页面前，先把旧内容归档到 `.tie/history/<id>/<nanos>.md`。正文若与磁盘一致则不重写该文件。

## 实现位置

| 实现 | 角色 |
|------|------|
| `src-tauri/crates/tie-local` | **规范实现**（Rust） |
| `tie` CLI | 本地读写入口 |
| `backend` | 账号和 HTTP API。页面字节以 `tie-local` 为准。后台 MCP 调用 `tie-cli mcp`，不在这里再写一套页面规则 |

Golden fixtures：`src-tauri/crates/tie-local/testdata/page-format/`。

## CLI（本地优先）

```bash
# 构建 / 调用
cargo run -p tie-cli --manifest-path src-tauri/Cargo.toml -- --help
# 或
npm run tie -- --help

export TIE_WORKSPACE=/path/to/workspace   # 含 pages/，或指向 *.tie
tie init "$TIE_WORKSPACE" --source-id src_local_0123456789abcdef
tie open "$TIE_WORKSPACE/workspace.tie"
tie --workspace "$TIE_WORKSPACE" write --title "笔记" --markdown "正文" --tag memory
tie --workspace "$TIE_WORKSPACE" list
tie --workspace "$TIE_WORKSPACE" search 笔记
tie --workspace "$TIE_WORKSPACE" get 笔记
tie --workspace "$TIE_WORKSPACE" related 笔记
tie --workspace "$TIE_WORKSPACE" recent --limit 10
tie --workspace "$TIE_WORKSPACE" tree
tie --workspace "$TIE_WORKSPACE" delete 笔记
tie --workspace "$TIE_WORKSPACE" restore 笔记
tie --workspace "$TIE_WORKSPACE" history list 笔记
tie --workspace "$TIE_WORKSPACE" files list
tie --workspace "$TIE_WORKSPACE" files ingest /abs/path/to/file --mode link --title 说明
tie --workspace "$TIE_WORKSPACE" format check
tie --workspace "$TIE_WORKSPACE" solution write --name "My Notes"
tie --workspace "$TIE_WORKSPACE" pack --out ./notes.tiez
tie unpack ./notes.tiez --out ./notes-copy
tie --workspace "$TIE_WORKSPACE" export --page 笔记 --depth 2 --out ./pack
tie --workspace "$OTHER_WORKSPACE" import ./pack --strategy skip
```

| 命令族 | 作用 |
|--------|------|
| `init` / `open` / `solution` | 工作区与 `.tie` 解决方案 |
| `pack` / `unpack` | 整树 `.tiez` 压缩携带 |
| `write` / `get` / `list` / `search` / `recent` / `tree` / `related` | 页面读写与浏览 |
| `delete` / `restore` / `purge` | 软删 / 恢复 / 彻底删除 |
| `history` | 版本列表 / 读取 / 恢复 |
| `files` | `.tie/files` 登记 |
| `export` / `import` | 页面闭包（子集分享，不是整树 pack） |
| `format check` | 格式校验 |

页面读写只走 Rust `tie` CLI（无 JS 回退），后台 HTTP 也调用同一 CLI。缺二进制时用 Skill `tie-upgrade-cli` 或 `tie_doctor`。已有本地工作区的 Agent 保留 `tie mcp` 桥接，服务器健康时走 HTTP，异常降级须用户确认；无应用的远程 Agent 可用用户提供的 MCP token 直接连接 `/mcp`。连接与同步规则见 [`sync.md`](./sync.md#与-mcp--agent)。不要用 `node` 启动 `server.js`。

输出默认为 JSON。`write` 把元数据写入 `.tie/meta/`，更新前把旧内容放入 `.tie/history/`。旧的 Tie 头仍能读，下次保存时去掉。

## 页面闭包导出 / 导入（`tie export` / `tie import`）

用于分享或迁移一撮页面，**不是**同步通道（见 [`sync.md`](./sync.md)）。MCP：`tie_export` / `tie_import`。

- **导出范围**：根页面（`--page` id 或精确标题）+ 出链（`[[标题]]` / `tie://page/{id}`，`--depth` 跳，默认 2）+ 根下完整 `parent_id` 子树（`--no-children` 可关）+ 以上页面的 `.tie/assets/{pageId}/`。子树内页面的出链同样按 `--depth` 跟随；被链入的页面不会再带上它们的子页。
- **不包含**：入链、`.tie/history/`、`tie://file/` / `tie://path/` 登记数据（正文里这类链接原样保留，目标工作区可能失效）、已软删页面。
- **输出**：目录（`--out`，须不存在或为空；默认 `./tie-export-<rootId>`），布局为标准 `pages/*.md` + `.tie/assets/…`，另有 `.tie/export.json` 清单（仅供参考）。不在包内的 `parent_id` 会被清空；`storage_source_id(s)` 不导出，导入时补为目标工作区默认源。
- **导入**：`tie import <dir> [--strategy skip|overwrite|new-id]`，默认保留原 id：
  - `skip`（默认）：id 已存在则跳过该页（及其附件）。
  - `overwrite`：覆盖已存在页面，旧内容先归档到 `.tie/history/`。
  - `new-id`：仅 id 已存在的页面换新 id，并重写包内 `tie://page/{id}`、`tie://asset/{id}/…` 与 `parent_id`；`[[标题]]` 链接不变。
- 导出与导入均输出 JSON 摘要（页面列表、附件数、各动作计数）。
