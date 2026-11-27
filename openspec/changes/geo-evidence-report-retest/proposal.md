## Why

用户需要依据可核对的 GEO 证据改进文章，并在发布修改后用相同条件复测。当前检测历史缺少模型配置快照，优化报告刷新后也无法从工作台恢复。

## What Changes

- 区分原文引用、正文链接、品牌提及、未命中、调用失败与联网状态。
- 将优化报告保存在本地，记录来源检测，可从历史重新打开和下载。
- 从检测结果或关联报告发起同题复测，并排显示基线与本次结果。

## Capabilities

### New Capabilities

- `geo-evidence` — 检测证据、联网状态与模型元数据。
- `optimization-report-history` — 文章优化报告的存储、查看和下载。
- `geo-retest` — 基于历史检测复测及前后对照。

### Modified Capabilities

## Impact

曜见本机工作台、检测与报告 API、优化 Agent、历史记录、现有 JSON 数据。保留原有登录、GEO 表单及报告下载方式。
