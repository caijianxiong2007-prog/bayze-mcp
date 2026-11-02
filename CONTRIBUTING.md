# 贡献指南

感谢关注 Bayze——本地运行、可审计的开源 AI 模型路由核心。

## 参与前请阅读

1. `docs/baseline-spec.md`（实施基线）——所有行为约束的单一事实来源，特别是 §7（瀑布语义）、§8（安全/隐私）与 §12（验收清单）。
2. `AGENTS.md`——仓库硬性规则（密钥、依赖、fail-closed、Result 错误边界等）。
3. `docs/threat-model.md`——改动涉及信任边界（网络、日志、凭证、模板）时必须先对照威胁条目。

## 硬性要求

- **密钥**：任何 PR 不得引入可用凭证字面量；凭证只允许 `env:` 引用。
- **依赖**：新增直接运行时依赖需在 PR 中说明理由；保持最小集；更新 lockfile。
- **测试**：涉及策略分支、错误映射、脱敏、预算的改动必须带测试；`npm test` 全绿是合入前提（当前 103 项）。
- **文档**：改变用户可见行为（工具返回、CLI、配置 schema、journal）时同步更新 README 与 `docs/`。
- **不做的**：遥测、云端组件、公网监听、聊天记录抓取——这些是产品边界，不是待办。

## 开发流程

```bash
npm install
npm run build
npm test
node dist/src/cli.js config check --config examples/config.example.yaml
node dist/src/cli.js run --workflow review_then_revise_mock --config examples/config.example.yaml --input "测试任务"
```

提交信息沿用 `stage-N: ...` 或 `area: 描述` 风格；许可证为 MIT（见 LICENSE），提交即表示同意以 MIT 许可发布你的贡献。
