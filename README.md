# Bayze

本地运行、可审计、可扩展的开源 AI 模型路由核心。通过 MCP stdio 接入支持工具调用的 AI 客户端，首期提供「草稿 → 必经结构化评审 → 按需修订」的 `review_then_revise` 瀑布工作流。

> 状态：**阶段 2（瀑布引擎）已完成** —— 配置校验、瀑布状态机（升级/停止/重试/预算/超时/取消）、结构化评审门、运行摘要 journal 均可用（mock 供应商全路径演练）；MCP server 见阶段 3。用户自带模型凭证（BYOK）；默认无遥测、无云端组件、无本地监听。

## 环境要求

- Node.js ≥ 22 LTS

## 快速开始（阶段 1：配置校验，只读）

```bash
npm install
npm run build

# 校验自带 mock 示例（无需任何密钥）
node dist/src/cli.js config check --config examples/config.example.yaml

# 严格模式：同时验证所有 env: 引用可解析（只报变量名，不报值）
BAYZE_EXAMPLE_API_KEY=dummy node dist/src/cli.js config check --config examples/config.example.yaml --strict

# 运行首发工作流（草稿 → 必经结构化评审 → 按需修订）；返回结构化 JSON
node dist/src/cli.js run --workflow review_then_revise_mock --config examples/config.example.yaml --input "用一句话解释 MCP 协议"

# 运行摘要 journal：查看 / 清除（默认仅摘要，7 天 / 10MB，不含输入与输出内容）
node dist/src/cli.js journal tail 5
node dist/src/cli.js journal clear

# 查看默认配置路径（OS 用户配置目录；Bayze 只读取，不写入）
node dist/src/cli.js config path
```

示例配置使用 mock provider 演练全部路径（成功 / 空输出 / 超时 / 限流 / 挂起中止等）；`example-remote` 为假数据的 OpenAI 兼容供应商样例——密钥仅允许 `env:` 引用。真实供应商适配器在阶段 4 交付。

配置错误会定位到具体字段，例如：

```text
config check failed (invalid): /path/to/config.yaml
  providers.bad-remote.base_url: scheme "http" is not https; set allow_insecure_base_url: true ...
  workflows.w.steps.0.provider: unknown provider "ghost" (configured: bad-remote)
```

## 测试

```bash
npm test   # 73 项：配置 schema、凭证、mock 确定性、脱敏、模板、评审解析、预算、状态机全分支、调度、journal
```

## 文档

- [实施基线规范 v0.3](docs/baseline-spec.md) —— 全部实施约束与验收清单的单一事实来源
- [架构与数据流](docs/architecture.md)
- [威胁模型](docs/threat-model.md)
- [ADR-0001 运行时与工具链](docs/adr/0001-runtime-and-tooling.md)
- [AGENTS.md](AGENTS.md) —— 仓库工作规则

## 技术栈（ADR-0001）

TypeScript（strict）+ Node.js ≥ 22 LTS · 官方 `@modelcontextprotocol/sdk`（阶段 3 引入，stdio）· YAML + Zod 配置 · 凭证仅环境变量引用 · npm/npx 分发

## 交付阶段

见基线规范 §11：**0 方案核验 ✓** → **1 核心骨架 ✓** → **2 瀑布引擎 ✓** → 3 MCP 接入 → 4 真实供应商 → 5 安全与发布
