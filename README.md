# Tie

Tie 是一个本地优先的知识编辑器原型：用页面树组织内容，以 Markdown 保存页面，并为后续的标签、链接、图谱与多存储 Provider 预留边界。

## 当前完成的纵向切片

- Notion 风格的无限层级页面树。
- 新建顶层页面、在当前页创建子页面、删除页面及其子树。
- Typora 风格的安静写作区：标题、标签和 Markdown 正文自动保存。
- 右侧大纲与页面元数据。
- 浏览器开发模式使用 `localStorage` 演示持久化；Tauri 桌面模式将页面保存为真实 Markdown 文件。
- 桌面模式首次运行会在应用数据目录初始化 `workspace/pages/*.md`，文件带有 Frontmatter，其中包含稳定页面 ID、父页面、排序和标签。

## 运行

```bash
npm install
npm run dev
```

生产前端构建：

```bash
npm run build
```

启动桌面端：

```bash
npm run tauri dev
```

Linux 桌面端构建需要系统已安装 WebKitGTK、libsoup 和相关 GTK 开发库；缺少这些依赖时，前端的浏览器开发模式仍可使用。

## 下一步

1. 用 Tiptap 替换基础 Markdown 文本区，保留 Markdown 可逆保存。
2. 加入拖拽排序、回收站和工作区选择。
3. 建立 SQLite 索引、双向链接、标签搜索和基础图谱。
4. 接入 MinIO Provider 与离线同步队列。
