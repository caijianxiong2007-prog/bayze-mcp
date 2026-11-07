# Changelog

本项目遵循基线规范（`docs/baseline-spec.md`）的阶段交付。

## 0.14.1（2026-11-07）—— Cherry 四工作流测试反馈：token 封顶截断修复

- **修复（关键）**：tokenCapFor 换算除数 2.2→**1.0（安全下界）**——实测中文密集输出仅
  ~1.05 字/token，按 2.2 设 token 上限会在字符闸触发前**静默硬截断成品**（实测两跑
  均卡死在 114 tokens=119 字半句；辩论裁决截断在"若团队已完成服务"）。除数 1.0 保证
  字符闸恒先触发（超闸有压缩重试兜底），token 上限退化为纯成本兜底
- **聚合补齐压缩重试 + 截断检测**（此前仅辩论裁决有）：aggregate 超 max_chars →
  自校准重试（HARD LIMIT 指令 + 实测比率钳 token）→ 仍超限才降级拼接；重试校验用
  收紧后的闸（含 per-run maxChars）；截断（末尾无终止标点）→ 警告
- live 配置 synthesize_moa 聚合闸 250→320（200 字任务 + 余量）
- 193 测试全绿（断言随新行为更新）；Mimosa 仅剩已知误报

## 0.14.0（2026-11-06）—— debate 立场指派 + 截断检测（ADR-0006 D8）

- **stances 立场指派**：三次实测同向退化（双方锚定同一结论，用户显式分派也无效——
  两个步骤同一份 input 无注入入口）。workflow 可选 `stances: [支持方, 反对方]`（仅 debate），
  开场/反驳注入己方立场：「按指派立场尽力论证，但绝不编造证据」。缺省保持涌现行为
  （开放分析题四测曾真交锋）
- **截断检测**：裁决/压缩重试交付时末尾无终止标点 → 警告「可能被 token 封顶截断」
  （六测实测裁决尾部被截「…（保」但静默通过字符闸）
- 193 测试全绿（+1 stances 注入/校验）

## 0.13.2（2026-11-06）—— Cherry debate 二测反馈修复包

- **开场退化修复**：实测单方开场=整场迷你辩论（自写反驳+裁决，均早于真实交锋）——
  开场现带 system 限定「只写己方立场，禁止模拟对方/反驳/裁决」
- **token 上限从字符闸推导**（裁决/聚合同用）：evaluate 含 max_chars 时
  maxOutputTokens=ceil(max_chars/1.4)——模型物理上写不到必被拒的长度，
  杜绝「裁决 $0.021 产出整段丢弃」的浪费（实测裁决占单次成本 90%）
- **裁决提示加编造折扣**：折扣无法验证的量化论据（实测 qwen 编造「核查过真实账单/
  QPS=42/Git 记录」），疑似编造须点明并排除出决策
- 191 测试全绿（+1：开场 system 限定 + token 推导 + 编造折扣三断言）

## 0.13.1（2026-11-06）—— Cherry debate 测试反馈修复包

- **修复（关键）**：`context` 字段 MCP 层接收但编排器静默丢弃——用户补充约束被扔掉
  （Cherry 实测「约束被完全忽略」的真相）。现组装进任务文本（ORIGINAL TASK/UNTRUSTED 块），
  全策略生效
- **修复**：debate 双方开场全挂时仍空跑裁决（白花一次 arbiter 调用）并发出
  「降级 transcript」的空头承诺（空 exchanges 无 transcript 可降）。现零立场快速失败：
  不跑裁决、警告如实、finalOutput 缺省
- 修复：debate 警告口径与实际执行一致（rounds held/configured）
- live 配置预算对齐：maxOutputTokens 2500 ≈ 3800 汉字 ≥ 开场 max_chars 4000 可容纳产出
  ——此前 token 预算允许模型写到必然被字符闸拒绝的长度（实测 3441/2908 字 vs 闸 2000）
- 190 测试全绿（+2 context 注入/零立场快速失败）

## 0.13.0（2026-11-06）—— 多 AI 协作第三批：debate 辩论策略（ADR-0006 D7）

- 新增 `strategy: debate`：恰好 2 个辩手步骤 + 必配 `judge`（裁决者）+ 可选 `rounds`（默认 1，上限 3）
- 流程：双方独立开场（不预设立场，分歧自然涌现）→ 每轮同时反驳（看到对方上一轮立场，
  可攻击/修正/让步）→ 裁决者综观全程：简述哪方更有说服力 + 给出独立成立的最终答案
- 裁决输出自由文本，走 aggregate 同款管线：`judge.evaluate` 确定性检查（复用 modelTarget.evaluate）、
  失败降级为辩论记录拼接 + warning（增强不闸门）
- `agreement` 报告终局立场一致性（辩论是否收敛）；审批预估按 rounds 放大
- schema：debate 需 judge、恰 2 步、无 run_if/gate；judge.evaluate 允许于 debate（parallel 仍拒绝）
- 188 测试全绿（+4：schema 边界 / 全流程 / rounds=0 / 裁决拦截降级）

## 0.12.5（2026-11-06）—— Cherry 终验反馈：moa 路径补 candidates

- 修复：candidates 此前仅 judge 选优路径填充——moa 路径成功时候选原文完全不可见、
  降级时只藏在拼接串里（终验实测发现）。现 moa 无论聚合成功/降级都结构化返回
  全部候选（审计面完整）；judge 路径不变
- 184 测试全绿（moa 成功/降级两用例均补 candidates 断言）

## 0.12.3（2026-11-06）—— Cherry 测试③反馈：max_words 确定性检查

- 新增 `{ max_words: N }` 检查（空白分词，面向英文）：dogfood 四次证实模型报字数
  系统性不可信（误差 1~38 词），词数约束从「人肉数」交给引擎；中文无空格会算 1 词，
  中文场景仍用 max_chars
- 动机案例：测试③译文 14 词，qwen 评审自报「exactly 10 words」——若上限是 12 词，
  模型报数会放过违规
- 184 测试全绿（+3）

## 0.12.2（2026-11-06）—— Cherry 测试②反馈：MoA 成品确定性检查

- **修复（结构性缺口）**：aggregate/escalate 的成品此前只查 non_empty——「重写型步骤天然写长」
  （测试②聚合成品 +59% 超标）。modelTarget 新增可选 `evaluate`（缺省 [non_empty]），
  聚合成品检查失败 → 降级拼接对比 + 明细；升级成品失败 → 保留上一版修订
- per-run `max_chars` 收紧覆盖同步作用于聚合成品与升级成品
- 聚合提示词强化：任务声明长度上限必须遵守 / 不引入候选中没有的论断 /
  遵循任务语言的标点排版（治中文混半角标点）
- schema：judge 不允许 evaluate（其输出是引擎解析的 JSON）
- 181 测试全绿（+3）

## 0.12.1（2026-11-06）—— Cherry 测试①反馈修复包

- **改名**：`confidence` → `agreement`——原名字被误解为「评委对选择的把握」；实义是
  多模型候选间相互印证程度（低=各答各的），改名自释义（API 仅发布 2 天，直接改）
- **修复**：per-run `max_chars` 收紧覆盖在 parallel/moa 策略未生效（仅 waterfall 应用）——
  有回归测试钉住
- **新增**：评委选优成功时 RunResult 附 `candidates`（全部候选全文）——落选版本可核对，
  不再只能采信评委自述
- `list_workflows` / `/api/workflows` 暴露 judge/aggregate/escalate_to/max_revisions——
  AI 客户端不再「看不见隐式步骤的模型」
- 178 测试全绿（+1）

## 0.12.0（2026-11-06）—— 多 AI 协作第二批：MoA 聚合策略（ADR-0006 D6）

- 新增 `strategy: moa` + 必配 `aggregate: { provider, model, timeout_ms? }`：
  N 个模型并行作答 → 聚合模型把候选合成一份最终答案（跨候选一致的论断优先、
  冲突按任务要求裁决、只出现一次的错误剔除）——学界验证常胜最强单模型
- 聚合输出自由文本 + non_empty 确定性检查；调用走完整预算流程并作为独立
  StepResult（stepName=aggregate）透明记录；失败降级为拼接对比（增强不闸门）
- judge 仅 parallel（选一份）、aggregate 仅 moa（合一份），互斥防「两种写法一件事」
- 审批预估计入 judge/aggregate 与修订循环放大（每多一轮≈两步均价）
- **修复**：人工批准检查移到策略分发之前——此前 parallel 策略会绕过审批门槛
- 177 测试全绿（+5 MoA schema/引擎/审批预估）

## 0.11.0（2026-11-06）—— 多 AI 协作第一批（ADR-0006）

- parallel 评委自动选优：`judge: {provider, model}` 可选字段，≥2 成功输出时由评委模型从候选中选优，
  `finalOutput`=胜者内容 + `judgeSummary`；评委失败降级为拼接对比（评委是增强不是闸门）
- parallel 置信度信号：`confidence`（0-1）= 成功输出间平均两两相似度（拉丁词+CJK 二元组 Jaccard），
  确定性、零额外调用
- waterfall 修订循环：`limits.max_revisions`（默认 1=旧行为），评审仍打回且次数未用尽时跳回评审步重跑
  「评审→修订」，次数用尽交付最后一次修订并如实警告
- 评审 rubric：gate 步骤可选 `rubric: [string...]`（缺省四项内置），注入评审提示——先逐项 1-5 打分
  再下 verdict，治判准漂移
- 修订循环用尽后的升级：`escalate_to: {provider, model}` 可选，换强模型做最后一次修订并透明记录步骤
- 172 测试全绿（+10）；既有行为零回归（默认值等价旧行为）

## 0.7.0（2026-11-05）—— P2 第一批：Dockerfile + 流式输出 + Web UI

- **Dockerfile**：多阶段构建（builder + runtime），非 root 用户，`node:22-alpine` 基础镜像。支持 `docker run -i bayze-mcp`（stdio）和 `docker run -p 3470:3470 bayze-mcp serve`（HTTP）。用于 glama.ai 自动化安全检查。
- **流式输出（`stream: true`）**：`POST /v1/chat/completions` 支持 SSE 格式流式响应，兼容 Chatbox/LobeChat 等需要流式的工具。步骤进度作为 SSE 注释发送，最终内容按 200 字符分块推送。
- **Web UI 配置界面**：`bayze serve` 启动后访问 `http://127.0.0.1:3470/` 可查看仪表板——工作流列表（含 profile 元数据/质量档位/测试按钮）、供应商列表、快速开始指南。`GET /api/workflows` 返回配置 JSON（需鉴权）。
- 测试 130/130 全绿。

## 0.6.0（2026-11-05）—— 多模型并行比较 + 配置导出（P1 第三批）

- **`parallel` 工作流策略**：多个模型同时执行同一任务，返回全部结果供横向对比。所有步骤并发执行（`Promise.allSettled`），无 `run_if`/`gate`（纯比较模式）。`finalOutput` 为所有成功结果的拼接（`[step_name/model_id]\n内容`），AI 客户端可直接展示对比。
- **`bayze export` 命令**：输出当前配置的 YAML（自动脱敏——配置文件本身只含 `env:`/`keychain:` 引用，不含密钥值），可安全分享。
- parallel 策略的 schema 校验：不允许 `run_if` 和 `gate`（所有步骤无条件并发）。
- 测试 130/130 全绿（新增 4：parallel 三模型并发/每步 mode/schema 拒绝 run_if/schema 拒绝 gate）。

## 0.5.0（2026-11-05）—— localhost OpenAI 兼容 API（P1 第二批 / ADR-0004）

- **`bayze serve`**：启动本地 HTTP 服务器，暴露 OpenAI 兼容的 `POST /v1/chat/completions` 端点。任何支持自定义 OpenAI 端点的工具（不限于 MCP 客户端）现在都可以使用 Bayze 的工作流。
- 安全边界（ADR-0004）：仅绑定 127.0.0.1、Bearer token 鉴权（`BAYZE_SERVE_TOKEN`）、请求体 ≤1MB、HTTP 超时 180s、`X-Content-Type-Options: nosniff`、无 CORS、无流式。
- **用法**：
  ```bash
  export BAYZE_SERVE_TOKEN="$(openssl rand -hex 16)"
  bayze serve --config your-config.yaml --port 3470
  # 然后任何 OpenAI 兼容工具指向 http://127.0.0.1:3470/v1
  ```
- `model` 字段 = 工作流 ID（如 `quick_answer` 或 `review_then_revise_cn`）；最后一条 user 消息 = 任务输入。
- 测试 126/126 全绿。

## 0.4.0（2026-11-05）—— P1 第一批（ADR-0003）

- **runtime.fx 汇率配置**：`runtime.fx: { rate_to_usd, updated_at }` 使 CNY 定价自动换算为 USD——消除手动折算，预算守卫不再对国产供应商报「价格未知」。未配置时保持 fail-closed（不变）。
- **macOS 钥匙串**：`api_key_ref: "keychain:NAME"` 直接从 macOS Keychain 读取密钥（execFileSync 参数数组，无 shell 注入）。仅 darwin；其他平台返回 keychain_unsupported 并建议 env:。
- **`bayze models` 命令**：CLI 拉取 Bayze API `/v1/models` 列出可用模型 id。需 `BAYZE_API_KEY`。
- **per-run max_chars override**：`user_overrides` 新增 `max_chars`（收紧-only）——引擎确定性检查使用 min(原值, 覆盖值)。
- 测试 126/126 全绿。

## 0.3.4（2026-11-05）—— dogfood 关键修复：revise 失败不能报 succeeded + Ark 模型修正

- **修复 revise 失败时顶层报 succeeded 的 bug（关键）**：dogfood 发现 `_cn` 的 revise 步 404 失败（doubao 模型不存在），但顶层仍报 `succeeded`/`completed`，用户拿到未经修订的草稿却以为已成功。现在：revise 被打回但修订步未交付新输出时，状态必须为 `failed`、stopReason 为 `workflow_exhausted`、warnings 包含明确提示。
- **修正 Ark 模型 id**：`doubao-pro-32k` 在 Ark 当前版本不存在（已改名 `doubao-seed-*` 系列）。配置与示例改为 `doubao-seed-2-1-pro-260915`（从 Ark /models API 实测获取）。
- 影响：`_cn` 和 `_cross_intl` 的 revise 分支此前一直是坏的（模型 404），只是从未被触发过（评审全部 accept）；本次修复后 revise 真实可用。

- **空 reasons 橡皮图章修复**：`parseReview` 现在拒绝 `reasons: []`（空数组）——不带任何理由的 accept 不再通过结构化评审门（fail-closed）。dogfood 发现：qwen-plus 曾给出 accept + 空 reasons，gate 直接放行，审计不可接受。
- **新增 `constrained_writing` 工作流**：确定性 `max_chars: 200` 硬上限——当评审模型不严格卡字数时（三个评审者均少报 30~40 字），由引擎确定性拦截。这是「任务显式约束 → 确定性检查」的 P0 落地方案。
- 另据 dogfood 记录：评审模型的字数自报不可信（系统性少报），`reviewSummary.reasons` 中的字数不能作为合规依据。

## 0.3.0（2026-11-05）—— quick_answer + 任务 profile + 评测工具（后续计划 v1.0 增量 A/B/C/D）

- **`quick_answer` 工作流**：单模型一步完成、无评审门——最便宜最快速的模型调用方式。
- **任务 profile**：workflow 新增可选 `profile` 字段（`category` / `quality_tier` / `description` / `max_input_chars`），`list_workflows` 自动携带。AI 客户端可据此推荐合适工作流。P0 不部署隐式 LLM 分类器，由用户显式选择。
- **评测工具 `bayze eval`**：读取任务集 JSON → 通过指定工作流逐条执行 → 汇总成功率/费用/延迟/token；`--compare <id>` 同时跑两个工作流并输出对比表（token 节省/费用差异/延迟对比/按类别分组）。附示例任务集 `eval/tasks.example.json`（25 个任务，翻译/问答/写作三类）。
- 测试 119/119 全绿；真实推理验证通过。

## 0.2.0（2026-11-04）—— 双接入模式（基线 v0.4.1）

- **Bayze 统一 API provider**：provider 新增 `mode: bayze_api`（缺省 `byok`，向后兼容、无迁移）；主机 P0 allowlist 固定 `app.lanwealth.com`；`kind` 必须为 `openai-compatible`（schema 校验级）。ADR-0002 记录全部取舍。
- **逐步模式展示**：`StepResult` / journal 步骤摘要 / `list_workflows` 均新增 `mode`（byok | bayze_api）；同一工作流可混用两模式，每步明确标注，结构性不存在运行中切换。
- **账单口径警告**：凡 run 含 bayze_api 步骤，结果常驻警告「实际扣费以 app.lanwealth.com 账单为准」；本地 pricing 仅作估算。
- 文档：隐私说明新增双路径数据流（含禁用表述清单）；威胁模型 T11；Bayze API 模式示例 `examples/config.bayze.example.yaml`（模型 id 占位待核验）。
- 遗留：阶段 4b「Bayze API 流程核验」（网站注册/充值/Key 生成/模型目录/真实调用/扣费核对）待项目方配合执行。

## 0.1.0（2026-11-02）

首个完整 P0 交付（阶段 0–5）。**2026-11-03 发布至 npm：`bayze-mcp@0.1.0`**（`npx -y bayze-mcp` 即用）。

### 阶段 0：方案核验
- 基线规范 v0.3 冻结入库；ADR-0001（TypeScript + Node ≥22 / 官方 MCP SDK / YAML+Zod / env 凭证 / npm 分发）；架构与数据流文档；威胁模型 T1–T10。

### 阶段 1：核心骨架
- 配置 schema（版本化 + 14 条交叉校验 + 字段级错误 + 本地端点显式 opt-in）；`config check/path` CLI；统一类型（RunResult/StepResult/9 种 stop_reason）；Provider 接口（Result 语义、8 类错误码）；mock adapter（13 场景、零网络）。

### 阶段 2：瀑布引擎
- run_if 封闭枚举状态机；确定性检查与结构化评审门（解析失败一律 fail-closed，绝不默认 accept）；四类受限输入模板（UNTRUSTED 分隔）；预算守卫（保守预估 + 原子预留 + usage 结算 + 未知价格 fail-closed）；重试/超时/取消；摘要 journal（7 天/10MB 轮转、可关闭/清除）；进程内调度（overloaded 快速拒绝）。

### 阶段 3：MCP 接入
- stdio server 三工具（`list_workflows` / `run_workflow` / `get_run_summary`）；步骤级进度通知（仅步骤名/状态）；取消传播；stdio 关闭 5 秒停止兜底；`NODE_TLS_REJECT_UNAUTHORIZED=0` 拒启；客户端接入文档。

### 阶段 4：真实供应商适配器
- OpenAI 兼容（Bearer、/chat/completions）与 Anthropic Messages（x-api-key、/v1/messages、error.type 体系）双适配器；共享 HTTP 策略层（超时/中止/HTTPS+同主机重定向校验/2MB 响应上限）；错误体脱敏；契约测试 18 项（本地回环 HTTP）。

### 阶段 5：安全与发布
- 全量深度扫描与密钥残留扫描；zod v4 升级修复 GHSA-mrhx-c7xc-m3w5（audit 归零）；`npm ci` 复现验证；隐私说明、依赖许可清单、验收状态矩阵、威胁模型验证状态。
- 区域发行示例（阶段 5 后补充）：大陆向（DeepSeek / 通义 DashScope / 火山方舟，含 CNY/USD 预算边界说明）与国际向（OpenAI + Anthropic，含同厂与跨厂商两种复核工作流）真实形态模板；价格均为假数据、待核验。
- 真实供应商在线联调（2026-11-03）：大陆向跨厂商工作流 `review_then_revise_cn` 全链路通过（DeepSeek 起草 → 通义评审 accept → 豆包按需跳过）。
- 真实 MCP 客户端注册（2026-11-03）：Cherry Studio 注册 bayze 成功，启动即拉起 stdio 进程（Claude Desktop 配置已就绪但因账户不可用暂 parked；ChatGPT 属平台边界——仅支持公网 HTTPS 连接器）。对话级端到端验证同日完成：聊天中经 list_workflows / run_workflow 完成跨厂商复核（runId f0335b98，journal 落账一致）。

### 已知限制（如实）
- 真实供应商在线联调待用户提供密钥（契约级已验证）；示例定价均为假数据（待核验）。
- Linux/Windows 平台未实测（darwin arm64 已验证）。
- 正式二进制签名、校验和与 SBOM 属正式发布阶段（基线 §11）。
