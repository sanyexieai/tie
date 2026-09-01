# Tie

Tie 是一个本地优先的知识编辑器原型：用页面树组织内容，以 Markdown 保存页面，并为后续的标签、链接、图谱与多存储 Provider 预留边界。

## 当前完成的纵向切片

- Notion 风格的无限层级页面树。
- 页面树的展开/收起状态会按工作区保存在本地偏好中；新建或拖入子页面时，其父页面会自动展开。
- 从搜索、链接、图谱、收藏或最近打开进入深层页面时，侧栏会自动展开该页面的祖先路径。
- 页面树支持键盘：Enter / Space 打开页面，→ 展开子页面，← 收起子页面，↑/↓ 在可见页面间移动焦点，Home/End 跳到首尾页面。
- 工作区名称可在左侧顶部重命名，仅影响 Tie 内的显示与配置，不会改动实际存储目录。
- 页面可设置图标；图标会持久化到 Markdown Frontmatter，并同步显示在页面树和编辑区。
- 可复制页面正文与标签，副本会插入原页面之后并保留同一父级和存储源；页面树中的子树不会被隐式复制。
- 新建顶层页面、在当前页创建子页面、拖拽调整层级；子页面会在父页面正文中自动生成可点击的标题链接，改名后自动同步；删除页面及其子树会进入回收站，可随时恢复。
- 恢复页面时会一并恢复已删除的祖先链；若原父级已被外部操作彻底移除，则页面会安全恢复为顶层页，避免成为不可见孤儿页面。
- 基于 Tiptap 的 Typora 风格写作区：编辑区默认无固定工具栏；标题、列表、任务、引用、链接、代码块和表格均可自动保存为 Markdown。离开编辑器或应用进入后台时会立即触发一次保存兜底。输入 `/` 可搜索并插入写作块、创建子页面或关联知识库页面。
- 代码块在富文本写作模式下使用常见语言语法高亮，切换源码模式或保存后仍是普通 fenced Markdown 代码块。
- 写作区支持通过 `/图片` 插入图片 URL 或 data URL，通过 `/上传图片` 选择本地图片，或直接粘贴、拖入图片；已连接存储源（本地/SMB/S3/后台/backend-s3）会保存为 `tie://asset/` 附件，浏览器演示模式仍使用 data URL。
- Typora 式编辑细节：点击正文底部留白会定位到新的空行；支持 Markdown 源码模式与 `Ctrl/Cmd + /` 切换。
- Markdown 源码模式的开关状态会按工作区保存，重新打开后保持上次选择。
- 底部拼写检查开关会按工作区保存，并同时应用于富文本和源码模式。
- 大纲与局部图谱的正文标题导航同时支持富文本与 Markdown 源码模式。
- 支持页面内查找与替换：`Ctrl/Cmd + F` 打开查找栏，Enter / Shift + Enter 在当前页面内跳转匹配项；“全部替换”只修改当前页面正文，源码模式同样可用。
- 支持专注模式：从底部状态栏切换，或使用 `Ctrl/Cmd + Shift + Enter` 隐藏左右侧栏专心写作。
- `Ctrl/Cmd + K` 命令面板可搜索页面，并快速执行新建子页、收藏、查找、源码模式、版本历史、专注模式、标签和知识图谱等操作。
- 右侧大纲与页面元数据。
- 移动端通过底部“关系”入口以抽屉形式查看大纲、属性、链接与局部图谱，保留后续移动端扩展空间。
- 基于稳定页面链接的出站链接与反向链接面板。
- 右侧“链接到”面板可移除普通页面链接；由父子关系自动维护的链接会标记为“子页面”，不可在这里删除。
- 右侧链接面板会列出正文中出现、但尚未建立页面链接的其他页面标题，帮助发现潜在知识关联。
- 未链接提及可直接在右侧面板转换为稳定页面链接；关联完成后会立即反映到反向链接与知识图谱。
- 全局搜索：按标题、标签与正文检索页面，支持 `Ctrl/Cmd + Shift + F` 快捷打开。
- 全局标签视图：浏览标签、查看标签关联页面，并可从页面顶部标签直接进入筛选。
- 可在标签视图重命名标签，并按当前存储源筛选决定仅更新单一来源或全工作区的关联页面。
- “智能提取”会根据标题、正文、已有标签与工作区标签给出本地候选标签；可逐个添加或一键全部采纳。
- 手动输入标签时会即时列出工作区内的同名候选，帮助复用既有标签；仍可按回车创建新标签。
- 当前页面的多类型局部知识图谱：标题页、标签和正文内容抽象使用不同节点样式；图中区分入链、出链、标签与内容关系，标题页节点可直接打开。
- 局部图谱中标题页节点可打开页面，标签节点可直接进入对应标签视图，正文内容抽象节点可定位到对应标题。
- 全局知识图谱：从左侧“图谱”进入，汇总全工作区的标题页、标签、内容抽象及其关系。
- 浏览器开发模式使用 `localStorage` 演示持久化；Tauri 桌面模式将页面保存为真实 Markdown 文件。
- 桌面端可注册多个存储源：任意本地目录或操作系统已挂载的 SMB 共享目录。每个页面都带有 `storage_source_id`，保存时会回写到所属源的 `pages/*.md`；不同源的页面仍可在同一页面树、链接和图谱中关联。旧版单目录配置会自动迁移为一个存储源。
- 页面迁移到其他存储源时，会将其整个子页面树、Markdown 文件及每页历史版本一并迁移；稳定页面 ID 与跨来源链接保持不变。
- 存储源可设置显示名称，方便区分多个同名目录；名称只保存在 Tie 配置中，不会修改实际文件路径或 SMB 共享名称。
- 侧栏存储源会分别显示正常页面与回收站页面数量；只要回收站仍有页面，该来源仍会受到安全断开保护。
- 存储源区提供「同步并载入」：冲掉离线队列、同步远程源，并从磁盘重新读取本地/SMB；适用于外部编辑器、挂载目录或同步工具改过文件之后。该操作会重新载入内存中的页面树，不会主动写入本地文件。
- 「同步并载入」会检测本地目录与 SMB 挂载是否可访问；不可访问来源会在侧栏用红点标示，恢复挂载后再同步并载入即可恢复。
- 可将现有 `.md` 文件导入当前选中的存储源；原文件保持不变，Tie 会在目标源创建带 Frontmatter 的新页面文件。同批导入原本由 Tie 管理的页面时，会保留父子关系并重写批内页面链接。
- 可从页面右上角导出当前内容为 Markdown；若正文含 `tie://asset/` 附件，桌面端会在所选 `.md` 旁写入 `assets/` 目录并重写为相对路径，浏览器模式则下载含 `assets/` 的 `.zip`；无附件时仍为单个 `.md` 文件。
- 页面保存时会保留真实变化的历史版本；桌面端历史位于所属源的 `.tie/history/<页面 ID>/`，浏览器演示模式则保存在 `localStorage`，均可从编辑器右上角预览后恢复。每页保留最近 80 个版本。
- 历史版本预览会精确标记当前选中项；若外部同步工具移除了历史文件，会给出可恢复的读取失败提示。
- 当页面保存失败（例如 SMB 暂时不可用）时，状态栏会保留失败原因并提供“重试”入口；内容不会被清空。
- 远程源（S3、自定义后台）保存时使用乐观锁：若其他设备已更新同一页面，会提示冲突并支持查看差异、覆盖远程或载入远程版本。
- 同步并载入时若本地与远程内容不一致，会在页面树与存储设置中标记冲突数量。
- 桌面模式首次运行会在应用数据目录初始化 `workspace/pages/*.md`，文件带有 Frontmatter，其中包含稳定页面 ID、父页面、排序和标签。

## 存储与同步

统一存储抽象层支持多种 Provider，页面树、链接与图谱可跨源关联：

| 类型 | 说明 |
|------|------|
| 本地目录 / SMB | 真实 Markdown 文件，历史在 `.tie/history/` |
| 本地 S3 | MinIO、AWS S3、R2 等；凭据存系统 keyring，配置在 `workspace.json` |
| 自定义后台 | 可选 Express 服务，托管工作区页面与 S3 Provider 凭据 |
| backend-s3 | 通过后台代理访问 S3，本地不保存密钥 |

- **离线队列**：file / S3 / 后台源保存失败时自动入队，可在存储设置中重试。
- **增量同步**：S3 按对象索引增量拉取，减少全量下载。
- **跨源迁移**：可在编辑器中切换存储源；file ↔ S3 迁移时保留历史版本与 `tie://asset/` 图片附件。
- **冲突处理**：保存冲突与同步冲突均可对照 diff，并选择保留本地或远程。同步时本地较新的冲突会自动推送到远程。
- **页面附件**：本地目录/SMB 保存在 `.tie/assets/<页面ID>/`；S3 与 backend-s3 保存在 `tie/assets/<页面ID>/`；后台工作区保存在服务端工作区目录；Markdown 引用 `tie://asset/<页面ID>/<文件名>`。

### 启动自定义后台

```bash
npm run backend:dev
```

默认地址 `http://127.0.0.1:8787`。开发模式允许使用默认 JWT 密钥；**生产环境**必须配置强随机 `TIE_JWT_SECRET` 并绑定 `127.0.0.1`（见 `backend/.env.example`）。

可选环境变量（见 `backend/.env.example`）：`OPENAI_API_KEY` 等用于后台 AI 标签建议。

### AI 标签

「设置 → AI 标签提取」可配置：

- **本地 CLI（推荐复用订阅）**：桌面端调用本机 `claude` / `codex` / `agent` 无头模式提取标签（禁工具、临时目录、45s 超时）；需已安装并登录对应 CLI
- **Tie 后台模式**：调用已连接后台的 `/api/v1/ai/suggest-tags`
- **OpenAI 兼容模式**：直连兼容 API（客户端保存配置）

也可在编辑器中使用本地「智能提取」候选标签；启用 AI 后会与启发式结果合并。

## 安装

### 桌面端（推荐）

1. 从 Release 下载对应平台的 `.deb` / `.rpm` / `.msi` / `.dmg` 安装包。
2. 首次启动会自动在应用数据目录创建工作区与欢迎页。
3. 在「存储设置」中添加本地目录、SMB 挂载路径、S3 或自定义后台。

Linux 从源码构建：

```bash
npm install
npm run tauri:build
```

产物位于 `src-tauri/target/release/bundle/`。

### 浏览器演示模式

```bash
npm install
npm run dev
```

数据保存在浏览器 `localStorage`，适合体验 UI，**不适合**作为正式知识库（无真实文件存储与附件持久化）。

### 自定义后台（可选）

```bash
npm run backend:dev
```

**生产部署**前请务必：

- 设置 `NODE_ENV=production`
- 设置至少 32 字符的随机 `TIE_JWT_SECRET`（勿用默认值）
- 保持 `TIE_BIND=127.0.0.1`，或仅在受控内网暴露并配置 `TIE_CORS_ORIGIN`

详见 `backend/.env.example`。

## 备份

| 存储类型 | 备份方式 |
|----------|----------|
| 本地目录 / SMB | 直接复制整个存储源目录（含 `pages/`、`.tie/history/`、`.tie/assets/`） |
| 本地 S3 | 备份 bucket 内 `tie/` 前缀对象；凭据在系统 keyring |
| 后台工作区 | 复制 `backend/data/workspaces/<工作区 ID>/` |
| 浏览器演示 | 无法可靠备份，请勿用于重要数据 |

Tie 内的页面 ID 与跨源链接写在 Markdown Frontmatter 中；迁移目录时保持 `pages/*.md` 与 `.tie/` 目录结构即可。

## 已知限制（1.0）

- 无多用户协作、共享权限或实时协同编辑
- 不支持后台工作区 ↔ backend-s3 Provider 互迁，也不支持两个 backend-s3 Provider 互迁
- 涉及后台源的页面迁移**不保留**历史版本（file ↔ S3 迁移会保留）
- 浏览器模式不支持 `tie://asset/` 真实附件存储
- Linux AppImage 安装包尚未提供（当前 Release 为 deb/rpm；Windows 为 msi/nsis）
- 无应用内自动更新；升级需手动下载新版本
- Codex / Agent 外接知识库为可选本地包 `@tie/mcp`（`packages/tie-mcp`），不依赖自定义后台

## 运行

```bash
npm install
npm run dev
```

生产前端构建：

```bash
npm run build
```

启动桌面端（Linux / Windows / macOS）：

```bash
npm run tauri
```

Windows 需已安装 [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)（多数 Win10/11 已自带）；安装包默认会引导下载 Bootstrapper。

桌面端构建（按当前 OS 自动选择包格式）：

```bash
npm run tauri:build
# 或显式指定：
npm run tauri:build:linux    # deb + rpm
npm run tauri:build:windows  # msi + nsis
```

推送版本 tag（如 `v1.0.0`）后，GitHub Actions 会自动构建 Linux / Windows 安装包并发布到 [Releases](../../releases)。详见 [`RELEASE.md`](RELEASE.md)。

Linux 构建需要 WebKitGTK、libsoup 和相关 GTK 开发库；缺少这些依赖时，前端的浏览器开发模式仍可使用。

### 可选：Agent 知识库（Codex / Cursor / Claude Code）

- **桌面端**：存储设置 →「Agent 知识库」→ 选择工作区与客户端 →「接入所选客户端」
- **命令行**：

```bash
npm run mcp:setup -- --workspace /path/to/workspace
# 仅部分客户端：
npm run mcp:setup -- --workspace /path/to/workspace --clients cursor,claude
```

配置与 Skill 见 [`packages/tie-mcp/README.md`](packages/tie-mcp/README.md)。

## 开发检查

```bash
npm run check
npm test
npm run test:backend
npm run test:mcp
npm run build && npm run test:e2e
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build
```

CI 在 push / PR 时自动运行上述检查（含后台 API 测试、浏览器 E2E，以及 Linux / Windows 桌面构建）。发布前请对照 [`RELEASE.md`](RELEASE.md)。
