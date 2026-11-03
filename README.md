# Bayze

本地运行、可审计、可扩展的开源 AI 模型路由核心。通过 MCP stdio 接入支持工具调用的 AI 客户端，首期提供「草稿 → 必经结构化评审 → 按需修订」的 `review_then_revise` 瀑布工作流。

> 状态：**P0 全部阶段（0–5）完成** —— 103 项测试全绿；`npm audit` 0 漏洞；`npm ci` 干净安装复现通过；真实供应商在线联调已于 2026-11-03 通过（大陆向跨厂商）。待人工项见[验收状态矩阵](docs/acceptance-status.md)（真实客户端注册核验、Linux/Windows 平台实测）。许可证 MIT。用户自带模型凭证（BYOK）；默认无遥测、无云端组件、无本地监听。

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

# 启动 MCP stdio server（接入 AI 客户端；每客户端一个子进程，无监听端口）
node dist/src/cli.js mcp --config examples/config.example.yaml

# 运行摘要 journal：查看 / 清除（默认仅摘要，7 天 / 10MB，不含输入与输出内容）
node dist/src/cli.js journal tail 5
node dist/src/cli.js journal clear

# 查看默认配置路径（OS 用户配置目录；Bayze 只读取，不写入）
node dist/src/cli.js config path
```

**接入 AI 客户端**（Claude Desktop / Cursor / Cherry Studio 等支持 MCP 的客户端）：见 [docs/mcp-clients.md](docs/mcp-clients.md)。三工具：`list_workflows`、`run_workflow`（长任务带步骤级进度通知，可取消）、`get_run_summary`。

**接入真实供应商**（BYOK，密钥只放环境变量）：在配置中声明 `kind: openai-compatible`（如 DeepSeek/通义/火山方舟等 OpenAI 兼容端点）或 `kind: anthropic`，设置 `api_key_ref: env:你的变量名`，并从官方价格页核实模型定价（示例中的价格均为假数据）。参考发行示例：

- **大陆向**：[examples/config.cn.example.yaml](examples/config.cn.example.yaml) —— DeepSeek 起草 → 通义 DashScope 评审 → 火山方舟（豆包）修订的跨厂商工作流；含 CNY 定价与 USD 预算（`allow_unknown_price`）的边界说明
- **国际向**：[examples/config.intl.example.yaml](examples/config.intl.example.yaml) —— OpenAI（同厂分级复核：gpt-4o-mini → gpt-4o）+ Anthropic（跨厂商复核：OpenAI 起草 → Claude 评审）；USD 定价下硬预算直接生效
- 通用形态（含 Anthropic 与本地端点 opt-in）：[examples/config.example.yaml](examples/config.example.yaml)

```bash
export BAYZE_DEEPSEEK_API_KEY=... 等      # 密钥只进环境变量
node dist/src/cli.js config check --config <你的配置> --strict
node dist/src/cli.js run --workflow <你的工作流> --config <你的配置> --input "任务"
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
npm test   # 101 项：配置 schema、凭证、mock 确定性、脱敏、模板、评审解析、预算、状态机全分支、调度、journal、MCP 三工具（含真实 stdio 端到端）、OpenAI/Anthropic 适配器契约（本地回环 HTTP）
```

## 文档

- [实施基线规范 v0.3](docs/baseline-spec.md) —— 全部实施约束与验收清单的单一事实来源
- [架构与数据流](docs/architecture.md) · [隐私说明](docs/privacy.md) · [威胁模型](docs/threat-model.md)
- [依赖许可清单](docs/dependencies.md) · [验收状态矩阵](docs/acceptance-status.md) · [Changelog](CHANGELOG.md)
- [ADR-0001 运行时与工具链](docs/adr/0001-runtime-and-tooling.md)
- [MCP 客户端接入](docs/mcp-clients.md)
- 许可证 [MIT](LICENSE) · [贡献指南](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) —— 仓库工作规则

## 技术栈（ADR-0001）

TypeScript（strict）+ Node.js ≥ 22 LTS · 官方 `@modelcontextprotocol/sdk`（阶段 3 引入，stdio）· YAML + Zod 配置 · 凭证仅环境变量引用 · npm/npx 分发

## 交付阶段

见基线规范 §11：**0 方案核验 ✓** → **1 核心骨架 ✓** → **2 瀑布引擎 ✓** → **3 MCP 接入 ✓** → **4 真实供应商 ✓（契约级）** → **5 安全与发布 ✓**
