# Bayze 推广文案包

四份按渠道定制的发帖文案，直接复制使用。

---

## ① Reddit r/MCP

**标题：**
```
Show r/MCP: bayze-mcp — Local-first multi-vendor AI model router with structured cross-review (draft → review → revise)
```

**正文：**

Hey r/MCP 👋

I've been building a local-first MCP server that routes tasks across multiple AI vendors with a mandatory structured review step. It's now on npm as `bayze-mcp` (MIT, 120 tests).

**The idea:** Instead of manually copy-pasting between ChatGPT, Claude, and DeepSeek to cross-check answers, you define a workflow once and your AI client calls it as a tool. One model drafts, a second model reviews with JSON verdict (accept/revise + reasons), a third model revises only when rejected.

**What it looks like in practice** (in Cherry Studio):

```
✓ draft   deepseek-chat    2.1s  ~$0.001
✓ review  qwen-plus        2.7s  ~$0.001
    verdict: revise — "missing TLS handshake details"
✓ revise  doubao-lite       3.6s
  → Final output incorporates reviewer's corrections
```

**Key features:**
- **Dual access mode**: BYOK (bring your own keys — DeepSeek, OpenAI-compatible, Anthropic) or unified API via a hosted gateway
- **Structured review gate**: reviewer must return JSON `{"verdict":"accept|revise","reasons":[...]}` — empty reasons fail closed (no rubber-stamping)
- **Budget guard**: conservative pre-call estimation, atomic reservation, fail-closed on unknown prices
- **Auditable**: every step records mode, provider, model, trigger reason, usage, cost; local journal (summaries only, never prompts)
- **Privacy**: keys from env vars only, no telemetry, no cloud components, no listening ports

**Cross-vendor workflows included:**
- `quick_answer` — single model, cheapest (~$0.001/run)
- `review_then_revise_cn` — DeepSeek → Qwen → Doubao (mainland China vendors)
- `review_then_revise_cross_intl` — DeepSeek → Claude → Doubao (cross-border review)

**Install:**
```bash
npx -y bayze-mcp mcp --config your-config.yaml
```

**Links:**
- GitHub: https://github.com/caijianxiong2007-prog/bayze-mcp
- npm: https://www.npmjs.com/package/bayze-mcp
- Works with Cherry Studio, Claude Desktop, Cursor (any MCP stdio client)

Happy to answer questions or take feature requests!

---

## ② V2EX

**标题：**
```
开源了一个本地 MCP 路由工具：让 Cherry Studio / Cursor 里的 AI 助理能调度多家模型交叉复核
```

**正文：**

大家好，分享一个最近在做的开源项目 **bayze-mcp**。

**解决什么问题：** 用 AI 助理的时候，经常想让「DeepSeek 写的答案让 Claude 帮忙把关一下」，但手动复制粘贴太麻烦。这个工具把「多模型交叉复核」做成了一条 MCP 工具调用，在 Cherry Studio / Cursor / Claude Desktop 里一句话触发。

**核心设计：**
- 一个模型起草 → 第二个模型评审（必须返回结构化 JSON 结论，空理由直接拒绝）→ 第三个模型按需修订
- 每一步都可审计：哪个模型、多少 token、什么费用、为什么升级
- 预算守卫：调用前保守预估，未知价格 fail-closed
- 隐私：密钥只从环境变量读，不记录 prompt/response，无遥测

**支持的供应商：** DeepSeek / 通义千问 / 豆包 / OpenAI / Anthropic / Bayze 统一 API（六家任选组合）

**安装（一行命令）：**
```
npx -y bayze-mcp mcp --config your-config.yaml
```

**链接：**
- GitHub: https://github.com/caijianxiong2007-prog/bayze-mcp
- npm: https://www.npmjs.com/package/bayze-mcp
- Gitee 镜像: https://gitee.com/collection-master/bayze-mcp
- MIT 开源，120 项测试，CI 三平台

欢迎试用和提 issue。目前已在 Cherry Studio 上实测了 15 次真实跨厂商复核（包括评审打回 → 修订的完整闭环）。

---

## ③ Cherry Studio 社区 / 群

**标题：**
```
[分享] bayze-mcp：一个让 Cherry Studio 支持「多家 AI 交叉复核」的 MCP 插件
```

**正文：**

如果你在 Cherry Studio 里用 AI 助理，想让「DeepSeek 写的答案让 Claude 帮忙检查一下」，可以试试这个开源工具。

**使用方式：** 在 Cherry Studio 的 MCP 设置里添加 bayze-mcp，然后在聊天里说：

> 用 review_then_revise_cn 处理：[你的任务]

DeepSeek 会起草，通义千问评审（给出结构化结论），豆包按需修订。每一步都能看到用了哪个模型、花了多少钱。

**配置很简单：**
1. 安装 Node.js ≥ 22
2. `npm install -g bayze-mcp`
3. 设置环境变量（API Key）
4. Cherry Studio → 设置 → MCP 服务器 → 添加

详细教程：https://github.com/caijianxiong2007-prog/bayze-mcp/blob/main/docs/mcp-clients.md

有配置问题欢迎在群里问，或者到 GitHub 提 issue。

---

## ④ glama.ai MCP 目录

访问 [glama.ai/mcp/servers](https://glama.ai/mcp/servers) 搜索 "bayze-mcp"。

如果未收录，到 [glama.ai/mcp/servers/add](https://glama.ai/mcp/servers/add) 提交：

| 字段 | 填入值 |
|---|---|
| GitHub URL | `https://github.com/caijianxiong2007-prog/bayze-mcp` |
| Name | bayze-mcp |
| Description | Local-first AI model-routing core: waterfall workflows with structured cross-vendor review (draft → review → revise). BYOK or unified API. |
| Categories | ai-tools, developer-tools, aggregators |
| Install | `npx -y bayze-mcp mcp --config your-config.yaml` |
