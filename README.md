# notion-caldav-sync 0.9.0

单人独立部署的 Notion ↔ Apple Calendar / CalDAV 双向同步服务，基于 TypeScript。

0.9.0 从 CalDAVKit 提取核心，替代此前的 Python 实现。公开版只支持一位用户，没有注册、OAuth 托管或多人界面。单人版和内部 AgentMQ 均使用 PostgreSQL；AgentMQ 使用 AWS PostgreSQL 并负责多账号管理。

## 同步规则

| 操作 | 结果 |
| --- | --- |
| Notion 新建有日期任务 | 创建日历事件 |
| 任一侧改标题、日期、状态或 Description | 回写另一侧 |
| 两边同时改不同字段 | 按上次成功同步的基线合并 |
| 两边改同一字段 | 时间较新的修改优先；相差不足60秒时 Notion 优先 |
| 日历删除已同步事件 | 清除 Notion 日期，保留任务；重新设日期可恢复事件 |
| Notion 明确归档、移入垃圾箱或清除日期 | 删除已确认归属的日历事件 |
| Notion 页面失去访问权限或返回 404 | 报告问题，保留日历事件 |
| 日历删除时 Notion 同时改日期 | 报告冲突，保留数据供处理 |

Apple Calendar 的状态可以通过标题前图标或备注的 `Status:` 修改。自动显示的 Overdue 不会改掉 Notion 原状态。Notion 自定义 status 通过已有选项和分组映射，不会新增选项。

仅管理选定 Notion 数据源及此前确认的事件。普通日历事件不会自动创建 Notion 页面。Location、Categories、提醒和其他日历扩展字段保留在日历中，不映射为 Notion 字段；新事件有默认提醒。重复和循环事件会报告问题，待人工处理。

## 独立部署

需要 Node.js 24、pnpm 10.33.0 和 PostgreSQL 17+。公开版不依赖 Cloudflare、D1、Clerk 或 AgentMQ 私有代码，可在服务器或 Docker 中独立运行；也可连接自己的 AWS RDS PostgreSQL。

1. `mise install`，`pnpm install --frozen-lockfile`，`pnpm build`。
2. 创建自己的 Notion integration，开启读取及更新权限，把所需数据源分享给它。自部署无需公共 OAuth integration 审核。
3. 为 Apple ID 创建 App 专用密码，找到要同步的日历集合 URL。
4. 复制 `.env.example` 到 `.env`，填写凭据、`NOTION_SOURCE_IDS`（逗号分隔 data source ID）、`CALENDAR_HREF`（以 `/` 结尾的 HTTPS 地址）和 `DATABASE_URL`。用 `openssl rand -hex 32` 生成 `DATA_ENCRYPTION_KEY`，独立生成管理及 webhook setup token。
5. 保持 `SYNC_INTERVAL_SECONDS=0`。`node --env-file=.env dist/main.mjs` 启动；首次会创建 `notion_caldav_sync.state`。把服务放在 HTTPS 反向代理之后，勿公开 PostgreSQL 端口。
6. 携带 `X-Admin-Token` 访问 `GET /admin/preview`，保存并检查计划；用 `POST /admin/full-sync` 执行首次同步。
7. 验证后设 `SYNC_INTERVAL_SECONDS=300` 并重启。间隔从上一次执行完成后计算，不堆积并发任务。

Docker 可用 `docker build -t notion-caldav-sync:0.9.0 .`，随后使用 `--env-file` 并设 `HOST=0.0.0.0` 运行。数据库由 `DATABASE_URL` 指定，容器中的 localhost 不指向宿主机。

详见 [配置](docs/configuration.md) 和 [0.9.0 迁移](docs/migration-0.9.0.md)。切换前停止旧版写入，避免两个服务同时管理同一日历。

## 接口

- `GET /health`：版本、模式、同步方向。
- `GET /admin/preview`：只读计划及两侧字段，需要 admin token。
- `POST /admin/full-sync`：双向同步，需要 admin token。
- `POST /webhook/notion?setup=<WEBHOOK_SETUP_TOKEN>`：首次验证保存 token，随后校验 HMAC 签名并处理重放。

完整扫描使用完整快照判断变化和删除。每次最多100个数据源、5000个任务、5000个日历成员、200次请求和180秒；超过限制或返回错误即停止。写入使用已观察到的 ETag，失败不会降级成无条件覆盖，也不会自动重试写入。

Notion 不提供条件 PATCH。服务写入前复核版本，发现变化便停止；最后一次读取与 PATCH 之间仍有 API 本身无法原子消除的短窗口。

## 验证

设置 `TEST_DATABASE_URL` 为本机独立的 `_test` 数据库后，`pnpm check` 运行类型检查和真实 Node.js／PostgreSQL HTTP 入口测试，外部协议使用固定数据；`pnpm build` 验证打包。每次 E2E 的命令、结果、TAP 和协议 trace 保存在 `artifacts/e2e/`。

本地测试已覆盖 PostgreSQL 重启、跨进程锁、账号绑定、条件写入及删除保护。真实 Notion／iCloud 的临时资源互测也已通过创建、双向字段修改、日历删除、重新设日期和 Notion 归档。报告保存在本机，发布时附上验收记录。0.9.0 尚未发布。

容器验证使用 `docker build -t notion-caldav-sync:0.9.0-test .`，再运行 `node tests/docker/check.mjs`。它创建并清理自己的临时 PostgreSQL 和服务容器，保存镜像 ID、命令及结果到 `artifacts/docker/`。使用其他 Docker context 时设置 `TEST_DOCKER_CONTEXT`。

MIT；提取代码的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
