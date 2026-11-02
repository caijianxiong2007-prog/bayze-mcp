# Bayze 架构与数据流

状态：阶段 0 草案
依据：实施基线规范 v0.3
相关：`docs/adr/0001-runtime-and-tooling.md`、`docs/threat-model.md`

## 1. 总体结构

```text
AI 客户端
   │ MCP stdio（首期）
   ▼
MCP Host / Tool Server
   │ 校验输入、用户授权、限额
   ▼
Workflow Orchestrator
   ├── Policy Engine（waterfall / retry / stop）
   ├── Evaluator（确定性检查 + 可选模型评审）
   ├── Budget & Call Guard（步骤数、超时、令牌/费用上限）
   └── Run Journal（本地摘要、可关闭、可清除）
           │
           ▼
     Provider Adapter Interface
       ├── OpenAI-compatible adapter
       ├── Provider-specific adapters
       └── mock adapter（开发/验收）
           │ HTTPS
           ▼
 用户选定的模型供应商 API
```

## 2. 进程模型

- 每个 MCP 客户端拉起一个独立 stdio 子进程；无常驻 daemon、无监听端口。
- 进程内默认最多 2 个并发 run、排队 4 个；超出立即以 `stop_reason: overloaded` 拒绝，不积压。
- MCP cancellation → 中止当前供应商请求并阻止后续步骤；stdio 关闭 → 5 秒内停止发出新供应商请求并退出。

## 3. 数据流与数据驻留

| 数据类别 | 产生于 | 驻留位置 | 流向 | 默认持久化 |
|---|---|---|---|---|
| 用户任务输入 | MCP 客户端 | 进程内存 | → 各步骤所配置供应商 API（按 input 模板裁剪） | 否 |
| 前序模型输出 | 供应商响应 | 进程内存 | → 仅按模板传递给下一步骤；最终输出返回客户端 | 否 |
| API 密钥 | 环境变量 | 进程内存 | → 仅作为 Authorization 头发往对应供应商端点 | 否（禁入配置/日志/journal） |
| 运行摘要 | Orchestrator | 本地 journal（JSONL） | 无外发 | 是（7 天 / 10 MB，可关闭） |
| 运行日志 | 各模块 | stderr（脱敏后） | 仅本地 | 否 |
| 配置 | 用户编辑 | OS 用户配置目录 | 无外发 | 是（不含密钥） |
| 用量/费用估计 | 供应商响应 | 进程内存 + journal 摘要 | 无外发 | 摘要 |

要点：

- 发往供应商的内容 = 步骤输入模板渲染结果（`original` / `original_and_previous` / `review_template` / `revision_template`），绝不包含密钥、journal 内容或内部日志。
- 密钥全生命周期只有三个落点：环境变量 → 进程内存 → 单次请求 Authorization 头。任何其他落点均属违规。
- progress notification 仅含步骤名/状态，不含 prompt 或 response 内容。

## 4. `review_then_revise` 序列

```text
client ── run_workflow ──▶ Bayze
Bayze: VALIDATE（配置 / 预算 / 输入体积）
  ├─ draft：HTTPS → 草稿模型；硬检查 non_empty / max_chars
  │    ├─ 检查失败 → run 以 draft_check_failed 停止（review 跳过，不自动 revise）
  │    └─ 通过 → review（必经）
  ├─ review：HTTPS → reviewer；要求按 JSON schema 返回 {verdict, reasons}
  │    ├─ accept  → 返回 draft + 复核摘要（run 成功）
  │    ├─ revise  → revise 步骤（至多一次）
  │    └─ 无法解析 / 超时 / 被拒 → 停止（不默认 accept，不运行 revise）
  └─ revise：HTTPS → 修订模型 → 返回修订稿 + 复核摘要
全程：每步独立超时；预算原子预留 / 实际 usage 结算；重试与逻辑步骤分开计数
```

## 5. 模块与目录映射

| 目录（基线 §9） | 模块（基线 §3） |
|---|---|
| `src/transport/mcp` | MCP Host（工具暴露、schema 校验、调用映射） |
| `src/application/workflows` | Workflow Orchestrator（含 Budget & Call Guard 调度） |
| `src/domain/policies` | Policy Engine |
| `src/domain/evaluation` | Evaluator |
| `src/providers` | Provider Adapter Interface + OpenAI 兼容 / 独立 / mock 适配器 |
| `src/config` | Config Manager |
| `src/credentials` | Credential Store |
| `src/journal` | Run Journal |
| `src/logging` | 脱敏日志 |
