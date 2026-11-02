# Changelog

本项目遵循基线规范 v0.3（`docs/baseline-spec.md`）的阶段交付。

## 0.1.0（2026-11-02）

首个完整 P0 交付（阶段 0–5）。

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

### 已知限制（如实）
- 真实供应商在线联调待用户提供密钥（契约级已验证）；示例定价均为假数据（待核验）。
- Linux/Windows 平台未实测（darwin arm64 已验证）。
- 正式二进制签名、校验和与 SBOM 属正式发布阶段（基线 §11）。
