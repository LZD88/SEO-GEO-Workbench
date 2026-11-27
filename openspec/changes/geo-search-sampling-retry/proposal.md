# Proposal

## Why

单次普通对话只能看到一条回答里的品牌或链接。用户需要验证联网引用，并在一次检测包含多个样本时补齐失败结果。

## What Changes

- 使用已验证的 GPT 中转联网接口，区分正式引用、正文链接和实际联网。
- 每个平台可采样 1、3 或 5 次，记录证据、成功率和命中分母。
- 保留已成功的样本，只补跑失败样本，沿用同题同配置。

## Capabilities

### New Capabilities

- `geo-search-sampling` — 联网证据、多次采样及针对失败样本的补跑。

### Modified Capabilities

## Impact

影响曜见 GEO 平台适配、表单、历史记录、复测和报告输入摘要。沿用当前本机数据格式。
