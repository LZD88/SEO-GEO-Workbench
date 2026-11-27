# 曜见 YaoSight · 搜索与 AI 可见性工作台

本机入口 http://127.0.0.1:8790/home 。技术 SEO 使用 SiteOne Crawler 2.5.1，AI 品牌可见性使用 NiubiGEO 0.3.3。

1. 双击 `启动工作台.cmd`，或者在此目录运行 `pwsh -File .\start.ps1`。进入首页后点击「登录」，首次设置工作台密码，之后用该密码登录本机仪表盘。会话在退出、服务重启或八小时后失效。关闭启动窗口会停止工作台。
2. 进入「SEO 数据」，点击「试跑样例」，在「历史记录」下载 HTML 报告、JSON 数据和日志。审计自己的网站时，填写网址并确认有权抓取。每次最多 100 个网址，深度最多 3 层，每秒最多 2 个请求。
3. 进入「GEO 工具」，填写文章或品牌信息并勾选平台。每个平台可选 1、3 或 5 次采样，提交前会显示预计请求数量。勾选支持联网的平台后可启用联网。在「历史记录」查看各平台的成功样本、实际联网和引用。可从有配置快照的结果只补跑失败样本，成功样本会沿用。
4. 文章检测用来源链接比对原文，忽略常见追踪参数，保留其余查询参数和原始链接。正文链接与平台正式引用分别标记。品牌检测使用 NiubiGEO 的名称匹配。
5. SEO 的抓取文件在 `data/seo/`，GEO 检测与监测记录在 `data/checks/` 和 `data/geo/`，本机密码校验信息在 `data/account.json`。工作台只监听本机。备份时复制整个 `data/`。
6. 「文章优化 Agent」可以读取公开 HTTP(S) 文章页，导入标题、前 12,000 字符正文及最多 4 张配图。生成的报告保存到 `data/article-reports/`，可在 Agent 的「历史报告」重新打开并下载 Markdown。
7. 在 GEO 结果中使用「同题复测」对照基线和本次的证据。旧记录缺少配置快照时，可选择按当前配置复测，页面会标出差异。新记录会在模型或联网配置变化时提示改用新检测。

后台配置方法：复制 `.env.example` 为 `.env`，按下面的表填好密钥与模型，再重启工作台。系统环境变量优先。接口地址由后台固定，密钥不通过网页传输或保存。

| 平台 | 密钥变量 | 模型变量 |
| --- | --- | --- |
| 豆包 | `ARK_API_KEY` | `DOUBAO_MODEL`，填火山方舟模型或接入点 ID |
| 千问 | `DASHSCOPE_API_KEY` | `QWEN_MODEL`，默认 `qwen-plus` |
| GPT | `OPENAI_API_KEY` | `GPT_MODEL`，默认 `gpt-4.1-mini` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL`，默认 `gemini-3-flash-preview` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL`，默认 `deepseek-chat` |
| 百度 AI（文心） | `QIANFAN_API_KEY` | `WENXIN_MODEL`，填百度千帆支持的模型 ID |

GPT、Gemini 默认请求联网，可将 `GPT_MODEL_SEARCH` 或 `GEMINI_MODEL_SEARCH` 设为 `off`。其他平台当前使用基础对话 API。检测结果来自实际配置的模型 API，可能与同名平台的消费者网页端不同。未完成配置的平台在前台不可选。

使用中转站时，在 `.env` 填 `GEO_RELAY_BASE_URL`，以及要接入的平台对应的 `*_RELAY_API_KEY` 和 `*_RELAY_MODEL`。模型 ID 以中转站的模型列表为准。配置了中转密钥的平台走兼容的 `/chat/completions` 接口，当前用于采样回答和检测品牌提及。未配置中转密钥的平台继续使用原有接口。

已验证中转 GPT 模型支持 Responses API 联网时，可加 `GPT_RELAY_SEARCH=on` 并重启。GEO 表单选择联网后才走 `/responses`，文章优化的识图仍走原接口。

全新机器先运行 `pwsh -File .\setup.ps1`。需要 Windows x64、PowerShell 7、Node.js 22.13 或更新的受支持版本、npm、Git 和网络连接。日常使用无需 Docker 或数据库。

上游项目：[SiteOne Crawler（MIT）](https://github.com/janreges/siteone-crawler) · [NiubiGEO（Apache-2.0）](https://github.com/Albert-Weasker/niubigeo)。

## 团队试点

生产构建、PostgreSQL 迁移、邀请登录、Worker 和独立抓取进程的配置见 [团队模式部署说明](production/README.md)。
