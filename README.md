# Bayze

本地运行、可审计、可扩展的开源 AI 模型路由核心。通过 MCP stdio 接入支持工具调用的 AI 客户端，首期提供「草稿 → 必经结构化评审 → 按需修订」的 `review_then_revise` 瀑布工作流。

> 状态：**阶段 0（方案核验）已完成**。当前仓库包含实施基线与设计文档，尚无可运行代码。用户自带模型凭证（BYOK）；默认无遥测、无云端组件、无本地监听。

## 文档

- [实施基线规范 v0.3](docs/baseline-spec.md) —— 全部实施约束与验收清单的单一事实来源
- [架构与数据流](docs/architecture.md)
- [威胁模型](docs/threat-model.md)
- [ADR-0001 运行时与工具链](docs/adr/0001-runtime-and-tooling.md)

## 技术栈（ADR-0001）

TypeScript（strict）+ Node.js ≥ 22 LTS · 官方 `@modelcontextprotocol/sdk`（stdio）· YAML + Zod 配置 · 凭证仅环境变量引用 · npm/npx 分发

## 快速开始

待阶段 1–3 交付（配置 schema → 瀑布引擎 → MCP stdio server）。

## 交付阶段

见基线规范 §11：0 方案核验 → 1 核心骨架 → 2 瀑布引擎 → 3 MCP 接入 → 4 真实供应商 → 5 安全与发布。
