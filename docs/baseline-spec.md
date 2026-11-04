# Bayze 本地开源 AI 路由核心

## 架构规划与 AI 编码实施规范

版本：0.4.1（实施基线）  
日期：2026-11-04  
状态：供实现 AI 编码与后续验收使用

> v0.4 由项目方于 2026-11-04 提出（双接入模式规划）；v0.4.1 为评审补丁版：A）StepResult 补 `mode` 字段；B）bayze_api 主机 allowlist 具体化；C）Bayze API Key 的 P0 存储决策（env + 披露，钥匙串归 P1）。

## 1. 项目目标

建设一个本地运行、可审计、可扩展的开源 AI 模型路由核心。它通过 MCP 等开放工具协议接入支持工具调用的 AI 客户端，让用户在熟悉的客户端中显式调用多模型工作流。第一阶段聚焦瀑布式调用：按用户设定的顺序调用模型，只有在可解释、可配置的升级条件满足时才调用后续模型。

产品服务对象是已经使用 DeepSeek、通义千问、豆包等 AI 助理的用户。Bayze 不要求用户更换主力 AI 助理，也不假设所有客户端都允许第三方接管其原生模型调用。

### 首期边界

- 路由核心在用户本机运行，请求从本机直接发往用户配置的模型供应商。
- 提供两种可选模型接入模式：
  - **本地 BYOK**：用户自带供应商账号/API Key，本地路由核心直接请求用户选择的模型供应商，由用户管理供应商充值和费用。
  - **Bayze 统一 API**：用户在 `https://app.lanwealth.com` 注册/登录、充值并创建 Bayze API Key；本地路由核心使用该 Key 调用 Bayze 国际版统一 API，由 Bayze 账户按现有服务规则计量与扣费。
- Bayze API 模式是用户主动选择的托管模型接入方式，不改变路由引擎本机运行的架构。插件不得收集或保存网站登录密码；用户在网站完成账户与充值操作后，将 API Key 配置到插件。API Key 优先存入系统钥匙串，若首期平台暂不支持则从环境变量读取并在安装说明中披露。**首期实现决策（v0.4.1/C）**：P0 采用环境变量引用（`env:BAYZE_API_KEY`）+ 安装说明披露（延续 ADR-0001 D4）；系统钥匙串集成归 P1（ADR-0002）。
- 首期不自建云端路由、账户或充值系统；Bayze 统一 API 模式复用现有 Bayze 国际版账户、充值、API Key 与 `/v1` 模型代理能力。本项目仍不提供云端日志或远程配置同步。
- 首期采用每个客户端启动一个 MCP stdio 子进程；无常驻 daemon、无本地监听。OpenAI 兼容本地 HTTP API 可作为后续阶段。
- 模型只在用户主动调用相应工具或工作流时参与；不得静默复制用户与主助理的全部对话。
- 不承诺能够增强不支持 MCP、插件或 API 接入的任意原生 AI App。此类用户后续可通过独立兼容入口使用，需另立阶段规划。

## 2. 用户价值与关键原则

1. 用户继续使用熟悉的 AI 助理，由客户端发起任务，Bayze 执行选定的多模型策略并返回结构化结果。
2. 用户控制模型凭证、参与模型、调用顺序、升级条件、预算和数据范围。
3. 每个步骤可解释：展示调用模式、服务端/供应商、模型、触发原因、状态、耗时、用量（若返回）及费用估算；Bayze API 实际扣费以 app.lanwealth.com 账单为准。
4. 默认本地、默认最少数据、默认无遥测。网络请求只发往用户配置的模型服务端点。
5. 核心与供应商适配器分离。添加新模型不应要求改写策略引擎。
6. 策略显式、可审计、可重放（记录请求参数和可用的模型标识；不承诺供应商模型版本或随机采样可完全复现）。不能把“模型觉得结果不好”作为未标记的确定性事实。

## 3. 目标架构

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
      用户选定的模型服务
       ├── 本地 BYOK → 供应商 API
       └── Bayze API Key → app.lanwealth.com/v1 → LiteLLM/模型供应商
```

本地路由核心在两种模式下都执行策略、预算预估和工作流状态管理。BYOK 请求从本机直接到供应商；Bayze API 模式的每个模型步骤从本机发送到 Bayze 统一 API，再由服务端转发给实际模型供应商。Bayze API 模式下，服务端账本/usage 记录是最终扣费依据；本地费用只作估算，不能替代平台账单。

### 模块职责

| 模块 | 职责 | 不应承担 |
|---|---|---|
| MCP Host | 暴露有限、清晰的工具；校验 schema；将 MCP 调用映射到工作流 | 任意执行 shell、读取整个磁盘、自动抓取客户端完整聊天记录 |
| Workflow Orchestrator | 创建 run、按策略调度步骤、超时/取消/错误处理 | 绑定具体供应商 API 格式 |
| Policy Engine | 解释 waterfall 配置，决定下一步骤或停止 | 自行更改用户策略、无限递归调用 |
| Evaluator | 执行长度、结构、JSON Schema、禁用词、必需字段等检查；可执行结构化第二模型评审 | 把模型评审说成客观真值 |
| Provider Adapter | 统一请求/响应、能力声明、错误映射、用量信息 | 保存密钥或隐式重试/升级整个工作流 |
| Credential Store | 安全读取用户凭证；支持环境变量/系统钥匙串 | 明文写入配置、日志、崩溃报告或仓库 |
| Config Manager | 读取并校验本地配置、版本化迁移、错误提示 | 未经用户确认覆盖配置 |
| Run Journal | 默认只记摘要元数据；支持关闭、轮转、查看/删除 | 持久化原始提示词、完整响应或密钥 |

### 进程与并发模型

- 每个 MCP 客户端启动独立 stdio 子进程；进程只处理本客户端的请求，退出时释放资源，不启动后台服务或监听端口。
- 并发和队列限制按进程实施；首期默认最多 2 个并发 run、最多排队 4 个 run，超出时快速返回 `overloaded`，不得无限积压。
- `max_concurrency` 与 `max_queue_size` 是进程级配置，不放在单个 workflow 的 `limits` 下。
- MCP cancellation 到达时取消当前供应商请求并阻止后续步骤；客户端关闭 stdio 时，进程应在 5 秒内停止发出新供应商请求并退出（供应商网络库若无法中止在途请求，必须记录该限制并在退出时终止请求）。
- 多个客户端进程共享 journal 时使用安全文件锁或改用每进程独立文件，避免并发写损坏。

## 4. 用户流程

1. 用户安装本地路由服务，并在兼容 MCP 的 AI 客户端中注册 stdio server。
2. 用户选择本地 BYOK 或 Bayze 统一 API。BYOK 用户在本地配置供应商和凭证；Bayze API 用户打开 `https://app.lanwealth.com` 完成注册/登录、充值并生成 API Key，然后在本地配置 Bayze API endpoint、Key 引用、模型和策略。插件不得要求或代填用户网站密码。
3. 用户在客户端显式选择 Bayze 工具，例如“执行多模型瀑布工作流”，提交本次必要输入与策略名。
4. 核心验证输入、预算和策略，执行草稿模型。
5. 首发复核工作流总是调用第二个模型进行结构化复核。复核结果为 `accept` 时返回草稿和复核摘要；为 `revise` 时才调用配置好的修订模型。模型评审属于启发式判断，返回结果必须明确标注其不确定性。
6. 返回最终结果、步骤摘要、升级理由、模型清单、用量/费用估算和警告。Bayze API 模式提示以网站账单为准。最终模型输出应标记为生成内容/不可信内容，避免客户端主助理把其中的指令视为系统指令。对评审不确定、达到预算或所有步骤失败的情况如实返回，不伪报成功。

## 5. 首期功能需求

### P0：必须交付

- 本地 MCP stdio server，至少提供 `list_workflows`、`run_workflow`、`get_run_summary` 三类有限工具。
- 同时支持本地 BYOK provider 和 Bayze 统一 API provider。Bayze provider 使用 `https://app.lanwealth.com/v1`（可配置，但必须通过主机 allowlist——**P0 固定为 `app.lanwealth.com`，见 §6 与 ADR-0002**）、用户在网站生成的 Bayze API Key 和平台开放的模型目录；Key 从系统钥匙串或环境变量读取。
- 提供 Bayze API 模式的注册/登录/充值/API Key 操作指引和打开网站的链接；不嵌入密码收集、不代理用户登录、不自动代用户充值。
- 两种模式可用于同一工作流，但每一步必须明确显示所用模式与模型；禁止无提示地从 BYOK 切换到 Bayze API，或反向切换。
- 长任务通过 MCP progress notification 发送步骤级进展；进度只含步骤名/状态，不包含 prompt 或 response 内容。
- 至少一个 OpenAI 兼容协议适配器；再加一个在协议、鉴权方式、错误体系三者中至少两项明显不同的适配器（建议 Anthropic Messages 或 Gemini API），以证明适配器边界有效。具体选择须核实 API 与区域可用性。
- `waterfall` 顺序执行，并支持首发 `review_then_revise`：草稿 → 必经结构化评审 → 若评审拒绝则修订。步骤数有硬性上限。
- 确定性检查失败（结构校验、空输出、用户配置的长度/字段条件）可升级；模型评审作为显式启用的启发式质量门，review 步骤按配置的 `always` / `on_check_failure` 执行。质量门失败必须携带原因和评审输出摘要。
- 每步独立超时、整体超时、用户取消、最大步骤数、最大输出 token、预算上限。费用硬上限在请求前按保守预估拦截后续调用，步骤完成后按实际 usage 结算；不保证供应商不会因单次计量差异产生超出预估的费用。
- 用户可选择只把原始任务发给每个步骤，或把上一步输出一并交给下一模型；默认只传完成任务所需的最小上下文。
- 可用 mock adapter 在无密钥情况下演练成功、校验失败、超时、限流、供应商错误、预算停止等路径。
- 安全的密钥读取、配置校验、日志脱敏；默认关闭遥测。
- README 快速开始、配置示例（全部假数据）、客户端 MCP 配置示例、威胁模型、隐私说明、开源许可证和贡献指南。

### P1：后续增强

- 本地 loopback HTTP 的 OpenAI 兼容 API（显式启用、鉴权 token、默认仅绑定 127.0.0.1）。
- 多模型并行比较、分工工作流、人工批准节点、图形配置界面。
- 完善跨平台系统钥匙串集成、配置导入导出、模型能力目录、可选本地评测集。
- 大陆版和国际版的发行配置差异。核心代码尽可能共用，地区服务端点、模型目录、隐私文案、更新分发和合规配置分开管理。

## 6. 配置与协议草案

配置只给出可工作的结构示意。密钥必须通过环境变量或系统钥匙串引用，不得直接填入仓库内的 YAML。

```yaml
version: 1
providers:
  qwen:
    kind: openai-compatible
    base_url: "https://provider.example/v1"
    api_key_ref: "env:BAYZE_QWEN_API_KEY"
    models:
      - id: "configured-model-id"
        # 不作为路由真值；实际能力由 adapter 契约和供应商响应确认
        capabilities_hint: [chat, json]
        pricing:
          currency: USD
          input_per_1m_tokens: 0.10
          output_per_1m_tokens: 0.40

  bayze:
    mode: bayze_api
    kind: openai-compatible
    base_url: "https://app.lanwealth.com/v1"
    api_key_ref: "env:BAYZE_API_KEY"
    # model id 必须来自当前 Bayze API 开放目录
    models:
      - id: "configured-bayze-model-id"

workflows:
  review_then_revise:
    strategy: waterfall
    limits:
      max_steps: 3
      total_timeout_ms: 90000
      max_output_tokens: 5000
      max_cost_usd: 0.05
      allow_unknown_price: false
      max_retries_per_step: 1
    steps:
      - name: draft
        provider: qwen
        model: "configured-model-id"
        input: original
        timeout_ms: 30000
        max_retries: 1
        evaluate: [non_empty, max_chars: 12000]
      - name: review
        provider: another_provider
        model: "configured-model-id"
        input: review_template
        timeout_ms: 30000
        run_if: always
        gate: structured_review
        review_schema: [verdict, reasons]
      - name: revise
        provider: qwen
        model: "configured-model-id"
        input: revision_template
        timeout_ms: 30000
        run_if: review_verdict_is_revise
```

`max_concurrency` 和 `max_queue_size` 属于顶层 runtime 配置，示意如下：

```yaml
runtime:
  max_concurrency: 2
  max_queue_size: 4
```

**`mode: bayze_api` 的校验规则（v0.4.1/B）**：`kind` 必须为 `openai-compatible`，且 `base_url` 主机必须命中 P0 固定 allowlist（`app.lanwealth.com`）；自定义镜像/区域端点留 P1。未声明 `mode` 的 provider 一律视为 `byok`。

价格表示每百万 input/output tokens 的单价；计价币种必须在 model 定价项中显式给出，示例数字仅是假数据。当前 workflow 的 `max_cost_usd` 以 USD 为预算币种；若模型定价币种不同，必须使用用户配置的汇率和更新时间换算，否则按价格未知处理并 fail-closed。每个模型可有独立输入/输出单价。Bayze API 模式中，本地价格仅用于运行前估算和预算提示；平台可能按点数、套餐、模型价格表或其他现行规则计费，用户界面必须提示“以 Bayze 账单为准”，不得用本地价格冒充最终扣款。

实施者必须在文档中明确费用币种和价格来源。价格未知且设置了硬性费用上限时默认拒绝该次供应商调用（fail-closed）；用户可显式设置 `allow_unknown_price: true`，此时只能提示无法估算，不能宣称硬上限有效。每次调用前按最大输入/输出 token 与已配置单价做保守预估；以原子方式预留预算，若已结算费用 + 在途预留 + 本次最坏情况预估达到上限则停止调用，避免并发 run 同时越过预算。完成后用真实 usage 结算并释放预留；无 usage 时费用标为未知并按保守预估占用预算。`max_output_tokens` 必须尽量作为请求参数发送；供应商不支持时，超过限制判为检查失败，不得静默截断。`base_url` 默认仅允许 HTTPS；本地模型端点需用户显式允许并提示风险。

### 内部统一请求/响应

- `RunRequest`: `workflow_id`, `input`, 可选 `context`, `user_overrides`（只能收紧限制；降低超时/预算/最大步骤数，且只能选择已配置的 provider/model）。
- `RunResult`: `run_id`, `status`, `final_output`, `steps[]`, `stop_reason`, `warnings[]`。
- `StepResult`: `step_id`, `provider_id`, `model_id`, **`mode?`（`byok` | `bayze_api`；由 provider 配置派生，缺省 `byok`——满足 §5「每步明确显示所用模式」，v0.4.1/A）**, `status`, `started_at`, `duration_ms`, `usage?`, `estimated_cost?`, `checks[]`, `error_code?`。
- 状态至少包括 `succeeded`、`failed`、`skipped`、`cancelled`、`budget_exceeded`、`timed_out`。
- run 级停止原因至少包括 `overloaded`、`draft_check_failed`、`missing_required_input`、`budget_exceeded`、`cancelled`、`workflow_exhausted`；它们与 Provider adapter 错误码分开。
- Provider adapter 应声明并通过契约测试验证协议能力（streaming、JSON、tools、vision 等）；具体模型上下文窗口等易变信息不能仅由用户手填声明为已验证事实。配置中的 `capabilities_hint` 只作提醒，不得参与安全决策或作为功能承诺。
- Provider adapter 错误分类应稳定可供策略使用：`auth`、`rate_limit`、`timeout`、`network`、`invalid_request`、`provider_unavailable`、`content_blocked`、`unknown`。只对明确可重试的类别在限额内重试。
- 本地调度拒绝（例如并发/队列已满）属于 run 级 `stop_reason: overloaded`，不是供应商 adapter 错误。
- 重试次数优先级：step 的 `max_retries` 覆盖 workflow 的 `max_retries_per_step`；未设置 step 值时继承 workflow 默认值；两者都未设置时为 0。

## 7. 瀑布策略语义

定义一个可审计的状态机：

```text
START → VALIDATE → STEP_1 → EVALUATE
                         ├─ check gate pass → 按 run_if 执行下一步或完成
                         ├─ check gate fail + next step + budget available → STEP_N
                         └─ otherwise → STOP_WITH_REASON
```

首发 `review_then_revise` 的具体语义：`draft` 通过硬性输入/输出检查后，`review` 必定执行；reviewer 返回符合 schema 的 `accept` 时完成并返回 draft；返回 `revise` 时执行一次 `revise` 并返回修订稿及 review 摘要。reviewer 输出无法解析、超时或被拒绝时必须停止并返回草稿与失败状态，不得默认为 accept。`review_template` 至少含原始任务、草稿和要求 reviewer 按给定 JSON schema 返回 verdict 与简短原因；`revision_template` 含原始任务、草稿及结构化评审意见。用户/模型文本使用明确分隔符并标记为不可信数据。`review` 判断是模型意见而非事实保证，输出中必须标注。

执行条件 `run_if` 是封闭枚举：`always`（仅在依赖的前序步骤成功且硬检查通过后）、`on_check_failure`、`review_verdict_is_revise`。不得支持任意表达式或执行用户提供的代码。`review` 失败策略在 P0 固定为 `stop`：返回草稿（若有）、review 错误状态和停止原因；不运行 revise，也不默认 accept。

草稿若未通过硬性检查（如空响应、超长或结构错误），review 跳过，工作流以 `draft_check_failed` 停止并返回失败结果；不把无效草稿送交 reviewer，也不自动进入 revise。

- 任何工作流最多执行 `max_steps` 个逻辑步骤；同一步骤的网络重试不计为新逻辑步骤，但受 `max_retries` 和整体超时/预算约束；禁止模型要求自身无限递归。
- 每次升级写明结构化 `trigger_reason`，例如 `schema_invalid`、`quality_gate_failed`、`provider_timeout`、`rate_limit`。
- 重试与升级分开计数。单个步骤的网络重试次数必须有上限；重试使用指数退避并遵守 `Retry-After`（若存在）。
- 质量评审只在用户显式选用包含 `structured_review` 的工作流时运行；其误判可能导致错误接受或额外修订，必须向用户披露。其他工作流不因“结果看起来一般”自动升级。
- 当预算、超时、取消、密钥错误或策略耗尽时停止并返回已有结果/原因；不得悄悄换用未配置的模型。
- 步骤输入只允许 `original`、`original_and_previous`、`review_template`、`revision_template` 等受限模板枚举；模板用明确边界包裹用户输入和前序模型输出。`original_and_previous` 要求前序步骤存在成功输出；缺失时以 `missing_required_input` 停止该步骤，不静默退回 `original`。前序输出始终是不可信数据，绝不能按指令执行或授予工具权限；失败项使用结构化字段传递，不拼接内部日志。

## 8. 安全、隐私与开源要求

- 数据流图和隐私说明必须逐项说明：输入、输出、元数据、密钥分别驻留在哪里，哪些内容会发给哪个供应商，默认保存多久。
- BYOK 与 Bayze API 必须在设置和首次调用前分别说明数据路径。BYOK 请求由本机直接发到用户配置的供应商；Bayze API 请求会发送到 Bayze 服务并由其转发到实际模型供应商。Bayze API 模式不得宣称“请求只在本机处理”或“Bayze 不接触提示词”。
- 面向中国大陆用户开放 Bayze API 模式前，单独评估生成式 AI 服务提供者义务、个人信息跨境处理、服务协议/告知同意、数据留存、模型供应商区域资格及所需备案/许可；遵守情况不能从国际版已有 API 能力推定。
- 默认只记录摘要元数据（run/step 状态、模型 ID、耗时、用量、费用估计和停止原因），不记录原始 prompt/response。摘要 journal 默认本地 JSONL、保留 7 天并限制 10 MB，超限按时间轮转；提供 `--no-journal` 完全关闭和清除命令。若未来允许保存 prompt/response，必须单独 opt-in、明确保存位置/期限并支持一键清除。
- 日志、错误、遥测、崩溃报告中不得出现 API key、Authorization header、完整用户输入或模型完整输出；对供应商错误体也先过滤后记录。
- 配置目录遵循操作系统用户配置目录，不得覆盖用户的 `$HOME` 或其他环境变量。凭证仅从环境变量或系统钥匙串读取；密钥不能出现在配置文件、命令行参数、进程列表或 shell history 中。
- MCP 工具采用最小权限；不提供通用文件系统、shell、网络代理能力。客户端传来的内容都视为不可信输入，防止提示注入越权调用本地工具。
- 限制输入体积、输出体积、并发数、队列长度、journal 大小/保留期、请求频率、HTTP 响应大小和连接/读取超时，防止资源耗尽。
- 只允许显式配置的供应商和主机；校验 URL scheme/主机，禁止自动跟随到非 HTTPS/非允许主机的重定向。P0 无 URL 输入工具；DNS rebinding 与代理环境变量纳入威胁模型记录。若 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或等价设置会禁用 TLS 校验，必须拒绝启动并给出错误。
- 默认遥测关闭；若将来加入，必须单独 opt-in、公开字段与目的，并提供关闭和清除方法。
- 在发布前检查许可证兼容性、供应商 SDK 许可、依赖漏洞、SBOM/依赖清单和源码中是否有密钥。
- 大陆服务上线属于独立合规决策。ICP备案与经营性电信许可、生成式 AI 服务备案/登记或算法要求是不同问题，需要按最终部署和业务形态另行确认；本地开源核心不能被宣传为自动满足这些义务。

## 9. 代码库建议

实现者先检查现有 Bayze 代码仓库、工作区规则和依赖，不要假定新建仓库或未经同意改造现有桌面客户端。若独立新仓库，采用可替换的清晰分层；语言/框架依据目标 MCP SDK 的维护状态、跨平台打包能力和依赖安全作出选择，并在 ADR 中记录理由。不要为了追求抽象而引入微服务或云端基础设施。

建议目录（按所选语言调整）：

```text
src/
  transport/mcp/
  application/workflows/
  domain/policies/
  domain/evaluation/
  providers/
  config/
  credentials/
  journal/
  logging/
tests/
  unit/
  contract/
  integration/
docs/
  architecture.md
  threat-model.md
  privacy.md
  adr/
```

需要维护版本化配置 schema 和迁移；对 Provider Adapter、工作流策略及 MCP 工具参数提供契约。依赖应精简、锁定版本并可复现构建。

## 10. 交给编码 AI 的执行规则

把本文件作为实施约束，向编码 AI 下达任务时要求它：

1. 先读取仓库 `AGENTS.md`、README、现有架构和 git 状态，列出计划修改文件、已存在的用户改动和实现决策；若确为空仓库，在新项目中实施；不得覆盖或清理用户已有改动。
2. 先输出短 ADR：运行时/语言、MCP SDK、配置格式、凭证存储和打包选择；解释取舍后再编码。
3. 按 P0 分阶段实现，每阶段汇报改动、未完成项、风险和运行方式；只接入本文件定义的现有 Bayze API。不得新建云端代理、账号/充值/计费系统，不得抓取客户端聊天记录或加入自动遥测。
4. 采用类型化 schema、清晰错误码、依赖注入和 provider mock；避免把策略条件散落在供应商适配器中。
5. 对涉及用户数据、联网、密钥、日志、自动重试、预算和本地监听的行为逐项落实本文件要求，并在 README 说明。
6. 交付完整安装/配置/客户端接入文档、假数据示例、威胁模型、隐私说明、许可证和 changelog。
7. 不得声称支持某模型能力，除非有适配器能力声明与契约覆盖；不确定的供应商 API、模型价格、政策和区域可用性必须标为待核验。
8. 完成后提供：变更摘要、文件清单、架构决策、运行步骤、测试与构建结果、已知限制、尚需人工确认的产品/合规决策。测试不能只报告 lint/build；需覆盖策略分支和凭证/日志安全。

## 11. 建议交付阶段

| 阶段 | 交付 | 完成定义 |
|---|---|---|
| 0. 仓库与方案核验 | repo 评估、ADR、数据流图、威胁模型草稿、Bayze API 流程核验 | 产品边界与技术选择有记录；核实网站注册/登录、充值、创建/撤销 API Key、模型目录、成功/失败调用与扣费记录的生产流程；没有改动既有用户内容 |
| 1. 核心骨架 | 配置 schema、统一类型、Provider interface、mock provider | 无真实密钥也能启动并校验配置 |
| 2. 瀑布引擎 | 状态机、检查器、预算、超时、取消与运行摘要 | mock 场景能覆盖所有停止/升级分支，步骤数受限 |
| 3. MCP 接入 | stdio server、工具 schema、客户端配置示例 | MCP 客户端可发现并调用工具；错误为结构化结果 |
| 4. 真实供应商 | BYOK OpenAI-compatible + 至少一个独立适配器；Bayze API provider | 用户可选直连或 Bayze Key；模型目录、鉴权、限额、错误映射、usage/账单口径核对完成 |
| 5. 安全与发布 | 密钥/日志检查、依赖清单、跨平台安装、文档 | 默认无遥测、无密钥泄露、无公网监听、npm/包管理器安装步骤可复现；正式二进制签名、校验和与 SBOM 在正式发布阶段完成 |

## 12. 验收清单

### 功能验收

- [ ] 全新环境可按文档安装、启动和注册 MCP server。
- [ ] Bayze API 路径可从网站注册/登录、充值、生成 API Key，完成真实推理请求并核实扣费；API Key 可撤销，插件只保存 Key 引用/安全凭证，不保存网站密码。
- [ ] 同一工作流可使用 Bayze API Key；每步清晰展示调用模式和模型，绝不静默切换到另一接入模式。
- [ ] `list_workflows` 只展示已配置工作流，不泄露密钥或本地无关信息。
- [ ] 普通 waterfall 的首模型通过全部硬检查时不发生意外升级。
- [ ] `review_then_revise` 总是调用 reviewer；`accept` 不调用 revise，`revise` 只调用一次修订步骤。
- [ ] 校验失败/升级时只调用下一配置模型，并记录结构化原因（如 `check_failed:<check_id>`）。
- [ ] 请求超时、限流、无效凭证、网络断开、空响应、结构错误、取消、预算耗尽和所有步骤失败均有明确结果。
- [ ] 模型顺序、输入传递范围、最大步骤数和预算可由用户配置且边界生效。
- [ ] Provider mock 能重复运行并产生确定结果；真实供应商测试可选择性执行，不把真实密钥放入测试产物。
- [ ] 配置 schema 错误可定位到具体字段；配置升级保留原文件备份或明确迁移策略。

### 安全与隐私验收

- [ ] 静态检索、运行日志、异常和 MCP 响应中均无密钥或 Authorization header。
- [ ] 默认没有 prompt/response 持久化、遥测或非预期的网络目的地。
- [ ] 仅允许配置过的供应商域名；重定向、DNS/SSRF 和本地端点行为经过审查。
- [ ] 输入、输出、并发、响应体、重试次数和总调用时长均有上限。
- [ ] MCP 工具不可任意读写文件、执行 shell 或访问客户端历史。
- [ ] MCP cancellation 可中止后续步骤；关闭 stdio 后 5 秒内不再发出供应商请求且进程退出。
- [ ] 未知价格在硬预算模式下默认 fail-closed；显式允许未知价格时有清晰警告。超预算时不继续调用。
- [ ] 日志注入带有伪造密钥的供应商错误响应，确认错误体经过过滤且没有凭证泄露。
- [ ] README 能让普通用户识别会向哪家供应商发送哪些数据，并能关闭/清除本地摘要记录。

### 发布验收

- [ ] 支持平台与最低版本明确，安装包/二进制有校验和，构建步骤可重现。
- [ ] 开源许可证、依赖许可、隐私说明、威胁模型和贡献规则齐备。
- [ ] 没有未经验证的“支持所有 App/模型”“完全隐私”“自动备案合规”等表述。

## 13. 当前待定产品决策

1. 独立开源仓库还是纳入现有 Bayze 仓库？编码 AI 第 0 阶段先检查现有项目，不应自行决定跨仓迁移。
2. 开源许可证（建议在确认依赖和商业策略后由项目方决定）。
3. 首批验证的 MCP 客户端和两家供应商；消费级 DeepSeek/通义/豆包 App 不应假定支持用户配置 MCP。首批候选应从经核实支持 MCP 的客户端中选择（例如 Cherry Studio、Claude Desktop/Code、Cursor，须在实施时核实当前版本能力）。
4. 首发工作流已定为 `review_then_revise`：草稿模型生成、reviewer 必经复核、拒绝时修订模型最多执行一次；验收样例需覆盖 accept/revise/invalid review。
5. journal 已定为默认仅摘要、保留 7 天/最多 10 MB、支持 `--no-journal`。若平台实现成本要求更改，编码 AI 需先以 ADR 提出。
6. P1 是否提供 localhost OpenAI 兼容 API；需另行定安全边界和客户端兼容矩阵。
7. 大陆用户是否可使用 Bayze 国际版 API、对应服务主体/服务区域、个人信息跨境机制及生成式 AI 相关合规结论，需在开放该模式前单独确认。

## 14. 本轮结论

本方案采用“用户本机运行的路由核心 + 用户可选择 BYOK 或 Bayze 统一 API + 每客户端独立 MCP stdio 进程 + 必经结构化复核的可解释瀑布路由”。BYOK 保持本机直连供应商；Bayze API 模式复用现有 `app.lanwealth.com` 账户、充值、Key 管理与模型代理，每个步骤由本机策略引擎编排并经所选服务计量。新建云端路由/账户/计费系统、自动接管第三方 App、聊天历史同步和未评估的地区化服务仍属后续独立产品决策。
