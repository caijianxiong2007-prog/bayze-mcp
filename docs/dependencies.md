# 依赖清单与许可

版本：0.1.0 · 生成于阶段 5（2026-11-02）· 完整传递依赖以 `package-lock.json` 为准（锁定、可复现）

## 直接运行时依赖（3 个）

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.32 | MIT | MCP 协议（stdio server / Client、进度、取消） |
| `yaml` | ^2.6 | ISC | 配置文件解析 |
| `zod` | ^4.6 | MIT | 配置 schema 与 MCP 工具入参校验（v4.6.7 修复 GHSA-mrhx-c7xc-m3w5） |

## 开发依赖（2 个）

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| `typescript` | ^5.6 | Apache-2.0 | strict 编译 |
| `@types/node` | ^22 | MIT | Node 类型 |

## 供应链措施

- 依赖集刻意最小（直接运行时依赖 3 个）；无 postinstall 脚本类依赖
- `package-lock.json` 提交入库；`npm ci` 干净安装已在阶段 5 复现验证
- `npm audit`：0 漏洞（2026-11-02）
- 正式发布阶段补充：SBOM/依赖清单导出、二进制签名与校验和（基线 §11）
