# ADR-0002：Bayze 统一 API 接入模式（基线 v0.4.1）

状态：已接受（2026-11-04）
依据：实施基线规范 v0.4.1（`docs/baseline-spec.md`）

## 背景

项目方提出双接入模式：在本地 BYOK 之外，允许用户选择「Bayze 统一 API」——用 app.lanwealth.com 生成的 API Key 经 Bayez 服务端代理调用模型，按平台账单扣费。路由引擎、预算与安全层保持本机运行不变。

## 决策

| # | 决策点 | 选择 |
|---|---|---|
| D1 | 协议与适配器 | 复用 `openai-compatible` 适配器（Bearer + `/v1`）；不新增适配器类型 |
| D2 | 配置标识 | provider 新增可选字段 `mode: byok \| bayze_api`（缺省 `byok`；mock provider 无此字段）；配置 `version` 保持 1，向后兼容、无迁移 |
| D3 | 主机 allowlist（基线 §6 v0.4.1/B） | `mode: bayze_api` 时：`kind` 必须为 `openai-compatible`，`base_url` 主机必须等于 `app.lanwealth.com`（P0 固定单主机白名单，写进 schema 校验）；自定义镜像/区域端点留 P1 |
| D4 | 凭证存储（基线 §1 v0.4.1/C） | P0 沿用环境变量引用（`env:BAYZE_API_KEY`）+ 安装说明披露；系统钥匙串集成归 P1（延续 ADR-0001 D4）。绝不收集/保存网站登录密码 |
| D5 | 逐步模式展示（基线 §6 v0.4.1/A） | `StepResult` 与 journal 步骤摘要新增 `mode?`（byok/bayze_api，由 provider 配置派生）；`list_workflows` 的步骤清单同步展示。引擎静态加载配置，结构性不存在运行中切换模式（§7 禁止悄悄换模型），"禁止无提示切换"由展示满足 |
| D6 | 费用口径 | bayze_api 步骤的本地 pricing 仅作估算/预算提示；凡 run 中含 bayze_api 步骤，结果常驻警告「实际扣费以 app.lanwealth.com 账单为准」；预算 fail-closed 语义不变 |
| D7 | 模型目录 | 模型 id 须来自平台开放目录；本地无法校验成员资格，示例与文档标注**待核验**；`bayze models` 探测命令列为 P1 候选 |
| D8 | 发版 | 代码增量作为 0.2.0 发布（npm + GitHub）；阶段 0 新增的「Bayez API 流程核验」（网站注册/充值/Key 生成与撤销/模型目录/真实调用与扣费核对）单列为**阶段 4b**，需项目方账号与少量真实扣费配合 |

## 理由

- 协议复用使增量收敛在 schema、类型、展示与文档层，策略引擎/适配器/HTTP 安全层零改动；
- 固定主机白名单防止「挂着 bayze_api 名义指向任意主机」造成账单口径误导；
- 文档红线（§8）：Bayze API 模式不得宣称「请求只在本机处理」或「Bayze 不接触提示词」——隐私说明以双路径数据流如实呈现。

## 后果

- 现有 v0.3 配置全部继续有效（`mode` 缺省）；npm 0.1.0 用户无感知；
- 大陆开放该模式前的合规评估仍是独立决策（待定 #7），本 ADR 不做任何合规推定。
