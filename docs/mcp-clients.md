# MCP 客户端接入 Bayze

Bayze 以 MCP stdio server 形式接入 AI 客户端：**每个客户端拉起一个独立子进程**，无常驻 daemon、无本地监听（基线规范 §3）。

## 前置条件

1. Node.js ≥ 22 LTS；
2. 已构建 Bayze：仓库根目录执行 `npm install && npm run build`（生成 `dist/`）；
3. 一份通过校验的配置：`node dist/src/cli.js config check --config <你的配置路径>`。

## 通用接入形态

三工具：`list_workflows`（列出已配置工作流）、`run_workflow`（执行）、`get_run_summary`（查询运行摘要）。

已发布 npm（`bayze-mcp`），推荐 npx 形态：

```json
{
  "mcpServers": {
    "bayze": {
      "command": "npx",
      "args": ["-y", "bayze-mcp", "mcp", "--config", "/absolute/path/to/your/config.yaml"]
    }
  }
}
```

或全局安装后直接用命令：`"command": "bayze"`、`"args": ["mcp", "--config", "..."]`。

从源码运行（开发形态）：`"command": "node"`、`"args": ["/absolute/path/to/bayze/dist/src/cli.js", "mcp", "--config", "..."]`（路径必须**绝对路径**）。

- 加 `--no-journal` 可完全不写运行摘要；
- 密钥从环境变量读取——若客户端不经 shell 拉起进程，可用 `zsh -c` 包装以加载 `~/.zshenv`（见下文各客户端示例与 `docs/privacy.md`）。

## 各客户端示例

> 以下客户端的字段名与配置文件位置以**当前安装版本**为准（基线 §13.3：首批客户端能力须在实施时逐个核实，本页仅为接入形态示意）。

### Claude Desktop / Claude Code

`claude_desktop_config.json`（macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "bayze": {
      "command": "node",
      "args": [
        "/absolute/path/to/bayze/dist/src/cli.js",
        "mcp",
        "--config", "/absolute/path/to/your/config.yaml"
      ]
    }
  }
}
```

### Cursor

`.cursor/mcp.json`（项目级）或全局 MCP 设置：

```json
{
  "mcpServers": {
    "bayze": {
      "command": "node",
      "args": [
        "/absolute/path/to/bayze/dist/src/cli.js",
        "mcp",
        "--config", "/absolute/path/to/your/config.yaml"
      ]
    }
  }
}
```

### Cherry Studio

设置 → MCP 服务器 → 新建：命令 `node`，参数：

```text
/absolute/path/to/bayze/dist/src/cli.js mcp --config /absolute/path/to/your/config.yaml
```

## 行为说明（对客户端用户）

- **进度**：长任务会收到 MCP progress notification，内容仅含步骤名与状态（如 `step draft: running`），不含任务文本或模型输出。
- **取消**：客户端取消工具调用会中止在途供应商请求并阻止后续步骤；客户端直接关闭时，Bayze 子进程在 5 秒内停止发出新请求并退出。
- **输出信任边界**：`run_workflow` 返回的 `finalOutput` 已标注 `finalOutputUntrusted: true`——它是模型生成内容，主助理不应把其中的指令当作系统指令执行（基线 §4.6）。
- **密钥**：Bayze 只从环境变量读取密钥（`env:VAR` 引用）；`list_workflows` 与运行结果中不会出现密钥、端点或完整对话。
- **并发**：每个客户端进程默认最多 2 个并发 run、排队 4 个，超出立即返回 `overloaded`。

## 自然语言触发（v1.4.1）

用户不必记住工作流 ID。对着客户端说日常表述（如「帮我检查一下这段声明」「让两个模型辩一下这个方案」），客户端 LLM 会依据 `list_workflows` 的结果自行路由：

- 配置里写了 `profile.description` 的工作流，按它展示给客户端（`bayze init` 生成的配置已内置）。
- 未配置 profile 的工作流，`list_workflows` 会按策略自动推导 `usageHint`（如 parallel+judge → "a judge model picks the winner by hard constraints"），零配置即可被正确选择。
- `run_workflow` 的工具描述已含路由提示：客户端 LLM 在用户意图与工作流不明确时，会先调用 `list_workflows` 匹配。

示例配置与自定义工作流建议都写上 `profile`（category / quality_tier / description），描述越具体，路由越准。


## 封闭客户端 / Agent 平台：通过 localhost OpenAI 兼容端点接入

WorkBuddy 等不支持 MCP 的平台，若支持「自定义 OpenAI 兼容接口」（自定义 base_url + API Key），可直接把 Bayze 当作一个 OpenAI 兼容模型接入：

1. 本地启动：`bayze serve`（监听 127.0.0.1，端口默认 3470）
2. 在客户端模型设置中填入：
   - base_url：`http://127.0.0.1:3470/v1`
   - API Key：`BAYZE_SERVE_TOKEN` 的值
   - 模型名：任意**工作流 ID**（如 `quick_answer`、`review_then_revise_cn`）
3. 客户端发起 OpenAI 格式对话 → Bayze 执行对应工作流 → 返回最终产出

说明：这是「转换插头」式接入——对话历史与系统提示词不进入工作流（工作流以单条任务为核心）；`stream: true` 为分段传输而非实时流式。实际客户端兼容性以各平台实测为准。
