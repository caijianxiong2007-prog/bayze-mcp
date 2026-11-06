# ADR-0006: 多 AI 协作第一批——parallel 评委选优/置信度 + waterfall 修订循环/rubric/升级

日期：2026-11-06 · 状态：已接受 · 关联：ADR-0002（双模式）、ADR-0005（parallel）

## 背景

Bayze 已有两种协作策略：waterfall（草稿→结构化评审→按需修订）与 parallel（多模型并行对比）。
15 次 dogfood 与学界证据指出两个缺口：

1. **parallel 最后一步断在人工**——N 份输出拼接后由人对比选优，AI 客户端无法自动拿到最优答案。
2. **waterfall 单次修订不收敛**——评审打回后只有一次修订机会；修订仍不合格时只能带着已知缺陷交付。
   且 qwen-plus 评审判准漂移（同任务时宽时严）暴露 rubric 缺失。

## 决策

### D1：parallel 可选评委（judge）自动选优

- workflow 级可选字段 `judge: { provider, model, timeout_ms? }`（仅 parallel 策略）。
- ≥2 个成功输出时，引擎用 judge 模型评审 N 份候选，要求返回
  `{"winner":"<步骤名>","reason":"..."}`；解析 fail-closed（winner 必须是有效步骤名、reason 非空，
  复用 parseReview 的严格风格）。
- **评委失败不推翻运行**：评委调用/解析失败时保留「拼接对比」行为并写入 warnings——
  评委是增强，不是闸门。选优成功时 finalOutput=胜者内容，`judgeSummary` 记录胜者与理由。
- 评委调用走完整预算流程（reserve/settle/release）并作为独立 StepResult 呈现（透明可审计）。

### D2：parallel 置信度（confidence）——确定性一致性信号

- RunResult 新增可选 `confidence: number`（0-1）：成功输出间的平均两两 Jaccard 相似度
  （拉丁词 + CJK 二元组，归一化后），纯确定性、零额外调用，v1 启发式。
- <2 个成功输出时不报告。它是信号不是保证，README 如实说明。

### D3：waterfall 修订循环（max_revisions）

- limits 新增 `max_revisions`（int ≥1，默认 1=现行为）。
- 全部步骤执行完且最近评审 verdict=revise、本轮修订已交付、循环次数未用尽时，
  引擎跳回最近的结构化评审步骤重跑「评审→修订」，直到 accept / 次数用尽 / 超时 / maxSteps。
- 循环内每次执行都计入 executed/maxSteps 与预算——无失控路径。
- 次数用尽仍 revise：交付最后一次修订（succeeded）+ warning 如实说明「评审仍要求修改」。

### D4：评审 rubric 注入（治判准漂移）

- gate 步骤可选 `rubric: [string...]`；缺省用内置四项默认 rubric
  （任务完成度/准确性/显式约束合规/完整性）。
- rubric 写入 review_template 的 system 提示：「逐项 1-5 打分，任一项 ≤2 则 verdict=revise」。
  引擎仍只按 verdict 闸门（评分是提示级引导，不新增解析面）。

### D5：修订循环用尽后的可选升级（escalate_to）

- workflow 级可选 `escalate_to: { provider, model }`（仅 waterfall）。
- 循环用尽且 verdict 仍 revise 时，用升级模型做最后一次修订（不再重评审），
  成功则交付并标注 escalation 步骤；失败/未配置则保持 D3 行为。
- 动机：dogfood 中 lite 模型修订能力不足、pro 模型太慢太贵——升级只发生在确有需要时（成本感知）。

## 后果

- schema 校验：judge 仅 parallel、escalate_to 仅 waterfall、rubric 仅 gate 步骤、跨引用校验 provider/model 存在。
- 后续（第二批）：MoA 聚合策略复用本批的评委基建；辩论（第三批）待评审质量验证后评估。
- 向后兼容：全部字段可选，默认值等价于旧行为；162 项既有测试不改动语义。
