# ADR-0001：运行时、工具链与仓库决策

状态：已接受（阶段 0）
日期：2026-11-02
依据：实施基线规范 v0.3（`docs/baseline-spec.md`）§10.2

## 决策

| # | 决策点 | 选择 |
|---|---|---|
| D1 | 语言/运行时 | TypeScript（strict 模式）+ Node.js ≥ 22 LTS，ESM |
| D2 | MCP SDK | `@modelcontextprotocol/sdk`（官方 TypeScript SDK，stdio transport） |
| D3 | 配置格式 | YAML + Zod schema 校验；`version: 1`；默认位于 OS 用户配置目录，`--config` 可覆盖；提供独立校验子命令 |
| D4 | 凭证存储 | P0 仅支持 `env:VAR` 引用，运行时解析、仅存于内存；`CredentialStore` 接口为 P1 系统钥匙串预留 |
| D5 | HTTP 客户端 | Node 内置 fetch（undici）+ AbortController；`redirect: "manual"` 逐跳校验；不引入 axios 等重依赖 |
| D6 | 测试 | Node 内置 `node:test`；契约测试基于本地 fixture 与 mock adapter；mock adapter 永不发起网络请求 |
| D7 | 打包分发 | npm 包 + CLI bin（客户端以 `npx` 拉起）；二进制、校验和与 SBOM 属正式发布阶段（基线 §11 阶段 5） |
| D8 | 仓库 | 当前工作区确认为空（无既有代码、无 AGENTS.md、非 git 仓库），按基线 §10.1 在本仓库新建独立项目 |

## 理由

- **D1/D2**：Bayze 的第一集成面是 MCP 协议本身。官方 TS SDK 是协议参考实现，stdio transport、工具注册、progress notification、cancellation 均为一等能力，协议演进跟踪最快。目标用户（MCP 客户端用户）生态以 Node 为主，`npx` 拉起 server 是社区惯例，无需额外安装步骤。
- **D1/D3**：Zod 同时覆盖配置 schema 与 MCP 工具入参校验（TS SDK 内部即使用 Zod），一套校验故事；strict TS 保障 `RunRequest` / `StepResult` 等内部契约的类型安全。
- **D5**：预算/超时/取消语义要求精确控制请求生命周期（AbortController、手动重定向、响应体大小上限），内置 fetch 足够且依赖最小。
- **D6**：基线要求「依赖应精简、锁定版本并可复现构建」，`node:test` 零额外依赖即可覆盖单元与契约测试。
- **D7**：npm/npx 已满足阶段 5 完成定义中的「npm/包管理器安装步骤可复现」。

## 备选方案与否决理由

| 备选 | 否决理由 |
|---|---|
| Python + 官方 `mcp` SDK | SDK 能力对等，但跨平台分发（解释器/venv/打包）对非 Python 用户摩擦大；依赖锁定与可复现构建弱于 npm lockfile |
| Go + Go MCP SDK | 单二进制与最小供应链有吸引力，但 SDK 生态与协议跟踪速度落后于 TS 参考实现；契约测试成本更高 |
| Bun / Deno 单可执行打包 | 运行时较新，生态兼容与长期维护风险不足；免装 Node 的收益不足以抵消 |

## 后果与风险

- 供应链风险来自 npm：以最小直接运行时依赖集（目标：`@modelcontextprotocol/sdk`、`zod`、`yaml`）、锁定版本、提交 lockfile、`npm audit` 与发布前密钥扫描缓解。
- 目标机器需 Node ≥ 22；README 必须写明最低版本。
- TS 引入构建步骤（tsc → dist），以 npm scripts 固化，保证可复现。

## 待阶段 1 落实的衍生项

- 汇率配置：基线 §6 要求非 USD 定价可换算但未给配置位置；阶段 1 schema 设计时补 `runtime.fx`（币种 → 汇率 + 更新时间），或约定 P0 仅接受 USD 定价。
