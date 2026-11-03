# 验收状态矩阵（基线规范 v0.3 §12）

状态图例：✅ 已验证（附证据）｜🧪 契约级已验证（本地回环模拟，在线联调待用户）｜⏳ 待人工执行｜deferred 基线明示延后到正式发布

## 功能验收

| 条目 | 状态 | 证据 |
|---|---|---|
| 全新环境可按文档安装、启动和注册 MCP server | ✅（darwin arm64） | `npm ci`（lockfile 干净安装）→ `npm run build` → `config check` 通过（阶段 5 复现）；MCP 注册见 `docs/mcp-clients.md` |
| `list_workflows` 不泄露密钥或本地无关信息 | ✅ | `mcp-server.test.ts`：无 api_key_ref / base_url / 端点字符串 |
| 主模型通过校验时不发生意外升级 | ✅ | `orchestrator.test.ts`「accept：draft 1 次、review 1 次、revise 不调用」 |
| `review_then_revise`：reviewer 必经；accept 不修订；revise 恰好一次 | ✅ | 同上 + 「revise：修订恰好一次」（调用计数 3） |
| 升级记录结构化原因 `check_failed:<id>` | ✅ | `orchestrator.test.ts`「长度检查失败：check_failed:max_chars」 |
| 超时/限流/无效凭证/网络断开/空响应/结构错误/取消/预算耗尽/全失败均有明确结果 | ✅ | `orchestrator.test.ts` 对应各用例（9 种 stop_reason 全覆盖） |
| 顺序/传递范围/最大步骤数/预算可配置且边界生效 | ✅ | schema 交叉校验测试 + overrides 收紧/钳制测试 |
| mock 确定性可重复 | ✅ | `mock-provider.test.ts`「确定性：同输入两次调用结果一致」 |
| 配置错误定位到字段；迁移保留备份 | ✅ / deferred | 字段定位：`config check` 负例冒烟（阶段 1）+ schema 测试；迁移：v1 为首个版本，无历史版本可迁移（策略已在基线 §12 注明） |

## 安全与隐私验收

| 条目 | 状态 | 证据 |
|---|---|---|
| 静态检索/日志/异常/MCP 响应无密钥或 Authorization | ✅ | 阶段 5 密钥形态扫描（空）；`openai-adapter.test.ts` 401 伪密钥脱敏；`redact.test.ts` |
| 默认无 prompt/response 持久化、无遥测、无非预期网络目的地 | ✅ | `journal.test.ts`（记录无输出内容）+ 阶段 5 网络出口审计（fetch 仅 `common/http.ts`）+ `src` 无监听端口 |
| 仅允许配置过的域名；重定向/DNS/SSRF/本地端点审查 | ✅ | schema 强校验 http/本地端点 opt-in；`openai-adapter.test.ts` 跨主机重定向拒绝；DNS rebinding 记为已接受风险（威胁模型 T7） |
| 输入/输出/并发/响应体/重试/总时长上限 | ✅ | MAX_INPUT_CHARS（schema+引擎双层）、max_output_tokens、并发 2/队列 4（overloaded 测试）、响应 2MB 上限（测试）、重试上限、total_timeout |
| MCP 工具不可读写文件/执行 shell/访问客户端历史 | ✅ | 工具仅三个（`mcp-server.test.ts` 工具发现），无 fs/shell 相关代码路径（阶段 5 出口审计） |
| cancellation 中止后续步骤；stdio 关闭 5 秒内停止 | ✅ / ⏳ | 取消传播测试 + `McpApp.shutdown` + 4.5s 强退兜底（代码路径）；真实客户端关闭行为待人工在目标客户端核验 |
| 未知价格硬预算 fail-closed；显式放行有警告；超预算不调用 | ✅ | `budget.test.ts` + `orchestrator.test.ts` 三例 |
| 注入伪密钥的供应商错误响应被过滤 | ✅ | `redact.test.ts` + openai 401 脱敏测试 |
| README 可识别数据去向并可清除记录 | ✅ | `docs/privacy.md` + `journal clear/path` |

## 发布验收

| 条目 | 状态 | 证据 |
|---|---|---|
| 支持平台与最低版本明确；安装步骤可重现 | ✅（部分平台） | Node ≥ 22（engines + README + 运行时警告）；darwin arm64 已实测，Linux/Windows 待人工（基线无强制） |
| 安装包/二进制校验和 | deferred | 基线 §11 阶段 5 完成定义明示：正式二进制签名、校验和与 SBOM 在正式发布阶段完成 |
| 开源许可证、依赖许可、隐私说明、威胁模型、贡献规则 | ✅ | MIT（`LICENSE`）；依赖许可 `docs/dependencies.md`；隐私 `docs/privacy.md`；威胁模型 `docs/threat-model.md`；贡献规则 `CONTRIBUTING.md` |
| 无未经验证的表述 | ✅ | 全文档仅声明已验证能力；供应商定价/API 区域均标注待核验 |
| 真实供应商错误映射、用量、能力如实呈现 | ✅ | 契约测试 18 项；**2026-11-03 在线联调通过**：DeepSeek 起草 → 通义 qwen-plus 结构化评审（accept，3 条理由）→ 豆包 revise 正确跳过；用量如实呈现（13/108 + 286/58 tokens），CNY 费用按设计提示无法估算。revise 在线路径未触发（契约级已验，待自然发生） |

## 阶段 5 安全执行记录

- Mimosa 深度扫描（全量，含阶段 3–4）：见最终报告（终扫任务 `scan-job-mvzchyfc`）
- 密钥形态扫描（sk-ant-/ghp_/xox/PRIVATE KEY/长 sk-）：0 命中
- `npm audit`：zod 高危公告（GHSA-mrhx-c7xc-m3w5）→ 已升级 zod v4.6.7 并全量回归（101+2 测试全绿），audit 归零
- `npm ci` 干净安装 + 构建 + config check：通过
