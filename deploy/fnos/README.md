# 飞牛部署

使用 Node 后台和 Rust `tie-cli`，HTTPS 保持在 `32043`。网页、账号页、管理页、API、WebSocket 和 MCP 通过同一入口访问。

HTTPS 使用 Tie 自己的入口脚本，替换证书路径模板后直接启动 nginx。自定义 443 配置无需默认 IPv6 配置脚本的包清单查询，避免 Alpine 的 `apk manifest` 阻塞入口启动。

## 准备产物

1. 在项目根运行 `npm run preflight`、`npm run test:e2e` 和 Rust 测试。
2. 运行 `npm run build`，将 `dist/` 与源码一起同步到飞牛。
3. 使用 Ubuntu 22.04 发布构建的 Linux 包，从中提取 `/usr/bin/tie-cli` 放入 `deploy/fnos/bin/tie-cli`。不要直接使用依赖更高 glibc 的开发机产物。
4. 将 `.env.example` 和 `backend.env.example` 分别复制为 `.env`、`backend.env`，填写版本、飞牛证书和随机 JWT 密钥。保留原 JWT 密钥可避免已有登录会话立即失效。配置文件权限设为 `600`。

同步后将 `dist/` 的目录权限设为 `755`、文件权限设为 `644`，确保 nginx 的非 root 用户可以读取静态网页。不要对整个部署目录递归放开权限，其中的环境配置和迁移导出仍须保持私密权限。

```bash
find dist -type d -exec chmod 755 {} +
find dist -type f -exec chmod 644 {} +
```

`backend.env` 的 CORS 列表按实际客户端来源配置。桌面端常用来源已列在示例中，同站网页无需额外跨站配置。

凭据库的加密数据与主密钥默认保存在数据卷的 `vault.json` 与 `.private/vault.key`，都不在工作区中。请安全备份主密钥；可用 `TIE_VAULT_KEY_FILE` 指定额外挂载的私有密钥文件。内网凭据操作仅在管理员通过 `TIE_VAULT_ALLOWED_ORIGINS` 允许对应 HTTPS origin 后执行。使用和授权见[凭据库说明](../../docs/vault.md)。

## 迁移旧 Rust 后台

先在服务器上为 SQLite 创建一致性备份，并复制原数据目录。保持原服务到切换前可用。迁移工具拒绝覆盖非空目标，保留账号密码摘要、工作区归属、页面、历史版本和附件/文件副本；只打印数量。

```bash
# 在仓库根目录导出一致性 SQLite 副本。旧 data 必须包含 users/<owner>/workspaces/<id>。
python3 scripts/migrate-legacy-backend.py \
  --database /absolute/path/to/legacy-snapshot.sqlite \
  --legacy-data-dir /absolute/path/to/legacy-data-copy \
  --export-json /absolute/path/to/legacy-export.json

# 新 backend-v2-data 卷须为空；以只读方式挂载旧数据与导出文件。
docker compose -f deploy/fnos/compose.yaml run --rm --no-deps --entrypoint node \
  -v /absolute/path/to/legacy-export.json:/migration/export.json:ro \
  -v /absolute/path/to/legacy-data-copy:/legacy-data:ro \
  backend /app/scripts/migrate-legacy-backend.mjs \
  --input /migration/export.json --output /data --legacy-data-dir /legacy-data
```

使用工具的 `--export-json` 在服务器只读导出 SQLite，再通过新镜像中的 Node helper 写入新数据卷。导出文件包含账号摘要，应保留 `600` 权限，完成后清理临时导出文件。旧 S3 Provider 只统计，不自动读取远端数据；迁移前须确认所有需要的页面已经落在磁盘/SQLite。

新后台使用独立 `backend-v2-data` 卷。迁移后核对账号、工作区、页面、历史和文件数量，再启动候选服务验证 `/health`、登录、页面和 MCP。若启用 MCP，服务设置中的路径应为 `/usr/local/bin/tie-cli`。

## 切换

```bash
docker compose config --quiet
docker compose build backend
docker compose up -d --remove-orphans
docker compose ps
```

切换时按同一个 Compose 项目 `tie-backend` 替换旧容器。检查 `https://域名:32043/`、`/health`、`/admin/` 和 `/me/`，以及已登录会话的 API、WebSocket 和 MCP。

不要使用 `docker compose down -v`，它会删除持久数据。证书续期后重载 nginx：`docker compose exec https nginx -s reload`。
