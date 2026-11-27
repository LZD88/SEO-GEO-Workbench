# YaoSight 团队模式

Windows 本机工作台继续用根目录的 `启动工作台.cmd` 或 `pwsh -File .\start.ps1` 启动。团队模式运行独立入口，安装数据库和私有报告存储后才部署。请将应用监听端口置于 TLS 反向代理之后，勿直接暴露。反向代理访问日志需要隐藏登录入口的查询参数，其中带有一次性邀请。

## 构建与健康检查

在 Docker 运行环境构建镜像和测试阶段。

```sh
docker build --platform linux/amd64 --target test -t yaosight:test .
docker build --platform linux/amd64 -t yaosight:pilot .
docker run --rm yaosight:pilot node production/web.mjs --check
```

应用默认在 127.0.0.1:8790 监听。容器需要由内部反向代理访问时，设置 `BIND_HOST=0.0.0.0` 并只接入反向代理私网。健康探针使用 `GET /healthz`。

## 数据库与产物

用独立的迁移角色创建应用 schema，给运行角色一个单独的登录账户。运行角色不得拥有数据库管理权限或继承迁移角色。示例角色名为 `yaosight_app`。使用秘密配置注入应用和迁移连接 URL。

| 变量 | 用途 |
| --- | --- |
| `MIGRATION_DATABASE_URL` | 只提供给运行 `node production/migrate.mjs` 的进程 |
| `DATABASE_APP_ROLE` | 迁移完成后取得 schema 运行权限的角色 |
| `DATABASE_URL` | Web 进程的受限连接 |
| `PUBLIC_ORIGIN` | HTTPS 公开入口，例如 `https://insights.example.com` |
| `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET` | OIDC 客户端设置，供应商需提供已验证的邮箱 |

空库启动前执行一次迁移。现有迁移用内容散列校验，可在重复部署时再次执行。变更采用向后兼容的追加迁移，回退应用镜像期间保留原数据库。生产连接请启用证书验证。

报告产物模块接受一个启用了公共访问阻止的私有 S3 bucket。给应用身份分配 `object-store-policy.example.json` 的对象级权限。应用通过 AWS SDK 默认凭证链取得受限运行身份。S3 兼容自托管入口使用 HTTPS。私有报告始终通过授权接口访问。

## 首位团队所有者

在 OIDC 客户端登记回调路径 `/auth/callback`，将公开入口和客户端密钥配置到部署环境。在可信终端运行 `node production/bootstrap.mjs "团队名" owner@example.com`，将生成的单次邀请链接交给对应邮箱的用户。链接有效两天。登录后，所有者可以在团队工作台创建项目及邀请其他成员。

## Web、Worker 与抓取进程

复制 `production/pilot.env.example` 为本地 `.env.production`，填好本环境专用的接入信息。先单独使用迁移账号执行 `npm run migrate`。再运行 `docker compose --env-file .env.production -f compose.production.yml up --build -d`。Web 和 Worker 共用构建产物，抓取器运行在独立的网络与容器中。TLS 入口转发至主机的 127.0.0.1:8790。Worker 的部署环境可配置原有模型变量，抓取进程只接收内部请求令牌。对象存储用 AWS 默认凭证链，兼容服务可提供 `ARTIFACT_ENDPOINT`。部署时检查应用与抓取器的环境和网络权限。

先以 `SCHEDULE_ENABLED=false` 启动。项目页可手动运行，独立校验定期计划后才设置为 `true`。运营人员用 `node production/operator.mjs status` 查看队列、失败分类、预算与处理延迟。周期探针可调用 `node production/check-operations.mjs`，返回码 2 表示达到告警条件。用 `node production/operator.mjs channel gemini pause` 暂停渠道，恢复改为 `resume`。项目级开关使用 `project WORKSPACE PROJECT pause|resume`。

工作空间预算是试点期累计的调用、文章读取和页数单位，可用 `limits WORKSPACE MODEL PAGES ARTICLES ACTIVE` 调整。上游结果待核对时，先暂停相关渠道或项目，在上游账单查明实际用量再进行运维处理。模型报告使用已验证通过的图片能力。运营人员运行 `node production/verify-vision.mjs gemini`，成功记录有效 24 小时。

## 导入本机历史

将要迁移的本地记录显式整理成 UTF-8 JSON 数组，每项包含 `kind`、原 `id` 和 `record`。支持 `geo`、`seo` 和 `article-optimization`。例如 `data/checks` 的检测文件对应 `geo`，`data/article-reports` 的报告文件对应 `article-optimization`。团队所有者在受信主机运行 `node production/import-history.mjs WORKSPACE PROJECT OWNER_ACCOUNT MANIFEST.json`。可重复导入同一批次，旧 ID 与归属项目共同去重。旧检查和报告之间的引用会尽量恢复，字段未知时保持未知。该命令导入记录和其中携带的内容。现有 SEO 原始 HTML、JSON 和日志仍保存在原本机目录。

## 内测验证与回退

- PostgreSQL 集成测试使用独立测试实例，通过 `YS_TEST_DATABASE_ADMIN_URL` 提供测试管理员连接。运行 `node --test 'test/*.test.mjs'`。测试会新建随机命名的数据库和角色，并在退出时清理这些测试资源。
- 记录 Linux Docker 构建、外网抓取以及对私网连接的阻断结果。以有权操作的测试站点验证域名授权、robots、抓取范围、请求上限与报告保存。
- 保持调度关闭，使用 PostgreSQL 原生备份和快照复制私有报告到恢复环境，确保对象键和元数据一致。恢复阶段停止 Worker，核对成员、项目、报告和用量，记录备份时间与恢复用时。按试点目标验证 RPO 24 小时和 RTO 4 小时。
- 回退时关闭调度并停止 Worker，应用镜像回到上一兼容版本，保留数据库和报告。检查处于待核对的外部请求后再恢复调度。

### 当前验收结果

本地 PostgreSQL 17.9 实例通过迁移、权限与 Worker 租约测试。浏览器在测试空间打开项目、发起带引用的 GEO 测试、下载 SEO 样例并切换工作空间。SEO 规则使用 SiteOne 2.5.1 真实抓取生成的样例进行回归。OIDC、上游模型和私有报告存储的集成测试使用各自的受控替身。

发布前需在实际 Linux 运行环境验证镜像构建和抓取隔离，并在预发布连接生产形态的 OIDC、报告存储和模型渠道，完成试点负载、备份恢复及回退。以 OpenSpec 的未勾选验收项跟踪这些结果。
