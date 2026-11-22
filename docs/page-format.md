# Tie Page Format Spec (`tie_version: 1`)

本地工作区以磁盘上的 Markdown 为唯一真相源。CLI、MCP、桌面/Android UI 必须读写同一格式。

## 工作区布局

```
<workspace>/
  pages/<page_id>.md
  .tie/
    history/<page_id>/<revision_id>.md
    assets/<page_id>/<filename>
    files/                 # 登记文件元数据与 copy 副本
```

- `pages/`：当前页面（软删页面仍保留文件，见 `deleted_at`）。
- `.tie/history/`：写入更新前归档的旧版本（每页最多保留 80 个）。
- `.tie/assets/`：页面图片等附件；正文用 `tie://asset/<page_id>/<filename>` 引用。
- `.tie/files/`：外部文件/目录登记（`tie://file/…`）与 copy 导入副本（`tie://path/…`）。

## 页面文件

```markdown
---
tie_version: 1
id: pg_0123456789abcdef
storage_source_id: src_local_0123456789abcdef
parent_id:
sort_key: 1
icon: 📝
tags: [memory, decision]
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
---

# 页面标题

正文 Markdown…
```

多源绑定时额外出现：

```yaml
storage_source_ids: [src_local_…, s3:…]
```

软删时额外出现：

```yaml
deleted_at: 2026-01-02T00:00:00.000Z
```

### Frontmatter 字段

| 字段 | 必填 | CLI 可写 | 说明 |
|------|------|----------|------|
| `tie_version` | 是 | 否（由写入器固定为 `1`） | 格式版本 |
| `id` | 是 | 创建时生成；更新不可改 | `pg_` + 16 hex |
| `storage_source_id` | 建议 | 可省略 | 协作主源。本地单源 CLI 可省略，由工作区默认源补全 |
| `storage_source_ids` | 否 | 慎改 | 主源 + 备份镜像；仅多源时写出 |
| `parent_id` | 是（可空） | 是 | 空 = 顶层。**页面树只认此字段** |
| `sort_key` | 是 | 是 | 同级排序；整数 |
| `icon` | 否 | 是 | 单行；写入时剥离换行 |
| `tags` | 是 | 是 | `[a, b]` 列表写法 |
| `created_at` | 是 | 否（创建时写入） | ISO-8601 |
| `updated_at` | 是 | 否（每次写入刷新） | ISO-8601 |
| `deleted_at` | 否 | 通过软删 API | 存在即软删 |

### 标题与正文

- 标题取正文**第一个**以 `# ` 开头的行（去掉前缀后 trim）；若无标题行则回退为「无标题」。
- 写入器在缺少一级标题时自动插入 `# {title}`。
- 正文为 Frontmatter 结束标记后的 Markdown（允许开头一个空行）。

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
| `s3:…` | S3 / MinIO 指纹 id |
| `backend:…` / `backend-s3:…` | 自定义后台 |

CLI 本地优先模式：工作区只有一个本地根时，省略的 `storage_source_id` 由 core 推断或写入默认本地源；**不要**手写云端源 id。

## 解析与序列化规则

1. Frontmatter 必须是文件开头的 `---\n` … `---\n`（简易行式 YAML，非完整 YAML 子集）。
2. `tags` / `storage_source_ids` 使用 `[a, b]`；空 tags 为 `[]`。
3. `parent_id:` 后为空字符串表示顶层。
4. Round-trip：`parse(frontmatter(page))` 在规范化后与逻辑字段一致（`storage_source_ids` 单元素时序列化可省略该行）。
5. 更新已有页面前，先把旧内容归档到 `.tie/history/<id>/<nanos>.md`。

## 实现位置

| 实现 | 角色 |
|------|------|
| `src-tauri/crates/tie-local` | **规范实现**（Rust） |
| `tie` CLI | 本地读写入口 |
| `packages/tie-mcp` / `backend` | 过渡期镜像；应收敛到 CLI/core |

Golden fixtures：`src-tauri/crates/tie-local/testdata/page-format/`。

## CLI（本地优先）

```bash
# 构建 / 调用
cargo run -p tie-cli --manifest-path src-tauri/Cargo.toml -- --help
# 或
npm run tie -- --help

export TIE_WORKSPACE=/path/to/workspace   # 含 pages/
tie init "$TIE_WORKSPACE" --source-id src_local_0123456789abcdef
tie --workspace "$TIE_WORKSPACE" write --title "笔记" --markdown "正文" --tag memory
tie --workspace "$TIE_WORKSPACE" search 笔记
tie --workspace "$TIE_WORKSPACE" get 笔记
tie --workspace "$TIE_WORKSPACE" related 笔记
tie --workspace "$TIE_WORKSPACE" recent --limit 10
tie --workspace "$TIE_WORKSPACE" tree
tie --workspace "$TIE_WORKSPACE" files list
tie --workspace "$TIE_WORKSPACE" files ingest /abs/path/to/file --mode link --title 说明
tie --workspace "$TIE_WORKSPACE" files ingest /abs/path/to/file --mode copy --title 副本
tie --workspace "$TIE_WORKSPACE" format check
```

MCP **只**走 `tie` CLI（无 JS 回退）。缺二进制时请用 Skill `tie-upgrade-cli` 或 `tie_doctor` 让 Agent 处理升级与格式兼容。

桌面「接入 Agent」写入 `TIE_CLI`；`npm run mcp:setup` 若无 CLI 会尝试 `cargo build -p tie-cli`。


输出默认为 JSON。`write` 会自动补 frontmatter，更新前写入 `.tie/history/`。
