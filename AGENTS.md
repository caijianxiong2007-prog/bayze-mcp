# AGENTS.md — Bayze 仓库工作规则

本仓库的实施约束以 `docs/baseline-spec.md`（v0.3 实施基线）为单一事实来源；架构决策见 `docs/adr/`。编码前必读。

## 硬性规则

- 按基线 §11 阶段推进；每阶段一次汇报（改动 / 未完成 / 风险 / 运行方式）与一次 git 提交。
- 密钥：只允许 `env:` 引用；源码、示例、测试中不得出现可用凭证字面量（基线 §8）。
- 依赖：新增直接运行时依赖需说明理由并保持最小集（ADR-0001）；必须提交 lockfile。
- 错误处理：adapter / credentials / config 边界一律返回 `Result`，不跨界抛异常。
- import 必须带 `.js` 后缀（NodeNext ESM）；TypeScript strict。
- 安全默认：fail-closed；`base_url` 默认仅 HTTPS，本地/明文端点需显式 `allow_insecure_base_url: true`。
- 未实现的能力不得声称支持（基线 §10.7）；不确定的供应商 API / 价格 / 区域可用性标为待核验。

## 常用命令

```bash
npm run build
npm test
node dist/src/cli.js config check --config examples/config.example.yaml
```
