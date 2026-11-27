# 曜见 YaoSight · 搜索与 AI 可见性工作台

曜见是一个本机 SEO 与 GEO 工作台。技术 SEO 使用 SiteOne Crawler，AI 可见性检测使用 NiubiGEO。

1. 在 Windows x64 上安装 PowerShell 7、Node.js 22.13 或更新的受支持版本、npm 和 Git。
2. 运行 `pwsh -File .\setup.ps1`，然后运行 `pwsh -File .\start.ps1`。
3. 打开 http://127.0.0.1:8790/home ，首次使用时设置本机工作台密码。
4. 如需模型检测，复制 `.env.example` 为 `.env`，填入对应平台的配置后重启工作台。

SEO 与 GEO 历史记录保存在本机 `data/`。
