# 兼容性矩阵（首轮试点实测）+ 生成器使用说明

> 本文件记录 bayze-mcp 首轮**试点兼容性实测**的结果。这是第一轮范围有限的真实运行记录，
> **不是**「兼容所有模型」的承诺。未列入的模型 = 未验证，不代表不支持。

## 实测范围

- 工作流：交叉复核（draft→review→revise）、受限字数写作（单步确定性检查）
- 任务：每工作流 2 个代表性任务（中英各一）
- 角色：草稿/修订 = 被测模型，评审 = 固定评审模型（DeepSeek/通义中选一）
- 记录：完成情况、评审可解析性、费用、耗时（质量列人工评判，首版留空待填）

## 矩阵表（由 `bayze compat` 自动生成，勿手改）

<!-- COMPAT-TABLE-START -->

<!-- COMPAT-TABLE-END -->

## 如何更新

```bash
bayze compat --config <配置文件> --out docs
```

runner 会把结果写入 `docs/compatibility.json`（原始数据）并把 Markdown 表格
插入本文件 `COMPAT-TABLE` 标记之间。

## 已知限制

- 试点样本量小（每模型 2 任务），结论是「该模型在该任务上能否跑通 + 费用耗时」，
  不是模型质量的完整评测
- 未覆盖：streaming、vision、function calling 等能力维度
- 质量列需人工评判后补填
