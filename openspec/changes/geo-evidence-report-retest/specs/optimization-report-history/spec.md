# Optimization Report History

## Purpose

保存用户生成的文章优化报告，使用户在刷新或服务重启后仍可找到分析结果、继续阅读并回到关联的 GEO 检测。

## ADDED Requirements

### Requirement: 持久化已完成的优化报告
系统 SHALL 为成功生成的报告保存标题、模型、生成时间、Markdown 正文与可选的来源检测标识。检测原始正文和图片附件不作为归档字段。

#### Scenario: 重开成功报告
- **WHEN** 用户生成报告后刷新或重启工作台
- **THEN** 可从历史打开原报告，下载同一份 Markdown，并查看可用的关联检测

#### Scenario: 生成失败
- **WHEN** 模型调用或报告保存失败
- **THEN** 用户收到错误提示，历史中没有此次生成的成功报告
