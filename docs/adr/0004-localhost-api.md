# ADR-0004：localhost OpenAI 兼容 API（P1 第二批）

状态：已接受（2026-11-05）
依据：实施基线规范 v0.4.1 §5 P1 + 待定 #6 安全边界

## 决策

Bayze 新增 `bayze serve` CLI 子命令，启动本地 HTTP 服务器，暴露 OpenAI 兼容的 `/v1/chat/completions` 端点。

## 安全边界（待定 #6 的回答）

| 约束 | 实现 |
|---|---|
| **默认不启动** | 仅当用户显式执行 `bayze serve` 时启动；MCP stdio 模式不受影响 |
| **仅绑定 127.0.0.1** | `listen(127.0.0.1, port)`；不可通过 CLI 参数绑定 0.0.0.0（基线 §8 禁止公网监听） |
| **鉴权 token** | 启动时要求 `BAYZE_SERVE_TOKEN` 环境变量；所有请求必须携带 `Authorization: Bearer <token>`；无 token 或错误 token 返回 401 |
| **端口** | 默认 3470（不与常用端口冲突）；可通过 `--port` 覆盖，范围 1024-65535 |
| **请求体限制** | 最大 1 MB；超出返回 413 |
| **超时** | 请求超时继承工作流的 `total_timeout_ms`；HTTP 层额外 180 秒硬超时 |
| **并发** | 复用 runtime 的 `max_concurrency`/`max_queue_size`；超出返回 429 |
| **无 CORS** | 不设置 CORS 头（同源 localhost 工具不受影响；跨域浏览器请求被拒绝） |
| **日志** | 仅记录请求路径、状态码、耗时；不记录请求体或响应体 |

## 端点设计

### POST /v1/chat/completions

**请求**（OpenAI 兼容格式）：
```json
{
  "model": "review_then_revise_cn",
  "messages": [{"role": "user", "content": "你的任务"}],
  "max_tokens": 5000,
  "temperature": 0.7
}
```

**映射规则**：
- `model` → `workflow_id`（用工作流名当模型名）
- `messages` 中最后一条 `user` 消息 → `input`
- `max_tokens` → 覆盖 `max_output_tokens`（收紧-only）
- 其他 OpenAI 参数（`temperature` 等）忽略（Bayze 路由不透传采样参数）

**响应**（OpenAI 兼容格式）：
```json
{
  "id": "run-uuid",
  "object": "chat.completion",
  "model": "review_then_revise_cn",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "最终输出"}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 42, "completion_tokens": 167, "total_tokens": 209}
}
```

- `finish_reason`: `"stop"`（succeeded）或 `"length"`（超时/预算/失败时仍返回已有内容）
- 失败时 `choices[0].message.content` 包含错误摘要；HTTP 状态仍 200（OpenAI 兼容工具期望 200）

## 不做的事

- 不支持 `stream: true`（P2 候选）
- 不支持 `/v1/models`（用 `bayze models` CLI 代替）
- 不支持 CORS/preflight
- 不做 HTTPS（localhost 不需要）
