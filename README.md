# 曜见 YaoSight · 搜索与 AI 可见性工作台

本机入口 http://127.0.0.1:8790/home 。技术 SEO 使用 SiteOne Crawler 2.5.1，AI 品牌可见性使用 NiubiGEO 0.3.3。

1. 双击 `启动工作台.cmd`，或者在此目录运行 `pwsh -File .\start.ps1`。进入首页后点击「登录」，首次设置工作台密码，之后用该密码登录本机仪表盘。会话在退出、服务重启或八小时后失效。关闭启动窗口会停止工作台。
2. 进入「SEO 审计」，点击「试跑样例」，然后点「查看报告」，按建议处理网站问题。检查自己的网站时，填写网址并确认有权抓取。
3. 进入「GEO 工具」，填写文章或品牌信息，选择 AI 平台并点击「开始检测」。结果显示哪些平台在回答中提到品牌或引用文章，并提供下一步建议。
4. 文章检测用来源链接比对原文，忽略常见追踪参数，保留其余查询参数和原始链接。正文链接与平台正式引用分别标记。品牌检测使用 NiubiGEO 的名称匹配。
5. SEO 的抓取文件在 `data/seo/`，GEO 检测与监测记录在 `data/checks/` 和 `data/geo/`，本机密码校验信息在 `data/account.json`。工作台只监听本机。备份时复制整个 `data/`。
6. 在文章 GEO 结果点击「帮我优化这篇文章」，或在文章优化页选择检测记录。新的文章检测会尝试保存正文和配图到 `data/article-context/`，可直接用于优化。只有旧检测结果时可按 GEO 结果生成建议，也可自行补充正文做逐段分析。报告保存到 `data/article-reports/`，可在「历史报告」打开和下载。
7. 在 GEO 结果中点击「再测一次」对照前后结果。有平台没返回结果时，可用「重试未返回的平台」。

## 本机管理员

在项目目录运行 `powershell.exe -NoProfile -File .\setup-admin.ps1`，按提示设置独立的管理员密码，然后访问 `http://127.0.0.1:8790/admin`。后台显示策略、模型渠道、完整 GEO 运行记录，以及 SEO 原始 HTML、JSON 和日志。策略控制新建 GEO 检测。默认每个平台一次，对已配置支持联网的平台请求联网。

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

已验证中转 GPT 模型支持 Responses API 联网时，可加 `GPT_RELAY_SEARCH=on` 并重启。管理员启用联网且已选平台支持联网时使用 `/responses`。文章优化的识图使用原接口。

全新机器先运行 `pwsh -File .\setup.ps1`。需要 Windows x64、PowerShell 7、Node.js 22.13 或更新的受支持版本、npm、Git 和网络连接。日常使用无需 Docker 或数据库。

上游项目：[SiteOne Crawler（MIT）](https://github.com/janreges/siteone-crawler) · [NiubiGEO（Apache-2.0）](https://github.com/Albert-Weasker/niubigeo)。

## 团队试点

生产构建、PostgreSQL 迁移、邀请登录、Worker 和独立抓取进程的配置见 [团队模式部署说明](production/README.md)。
