import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { BayzeConfig } from '../../config/schema.js';
import type { McpApp } from '../../transport/mcp/app.js';
import type { RunResult, StepResult } from '../../domain/types.js';

const require_ = createRequire(import.meta.url);
/** 运行时从 package.json 读取（dist/src/transport/http → 上 4 级到包根） */
const VERSION = (require_('../../../../package.json') as { version: string }).version;

/**
 * localhost OpenAI 兼容 API（ADR-0004）：
 * - 仅绑定 127.0.0.1，显式启动（`bayze serve`）
 * - Bearer token 鉴权（`BAYZE_SERVE_TOKEN` 环境变量）
 * - POST /v1/chat/completions → 工作流执行 → OpenAI 格式 JSON 响应
 * - 请求体 ≤1MB，HTTP 超时 180s
 * - 所有响应均为 application/json（不渲染 HTML，无 XSS 面）
 */

const MAX_BODY_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 180_000;
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
}

export function startServeApp(cfg: BayzeConfig, app: McpApp, port: number, token: string): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const reply = (status: number, payload: unknown): void => {
      res.writeHead(status, SECURITY_HEADERS);
      res.end(sanitizeJson(payload));
    };
    try {
      // 路由按 pathname 匹配（忽略 query——Web UI 依赖 ?token= 传鉴权，2026-11-05 修复）
      const pathname = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`).pathname;

      // Web UI 仪表板（P2-③）：GET / 返回配置界面（带 ?token= 也能命中）
      if (req.method === 'GET' && (pathname === '/' || pathname === '/ui')) {
        const html = getWebUI();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end(html);
        return;
      }

      // API：GET /api/workflows 返回配置摘要（需鉴权）
      if (req.method === 'GET' && pathname === '/api/workflows') {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${token}`) {
          reply(401, { error: { message: 'Unauthorized' } });
          return;
        }
        const summary = toConfigSummary(cfg);
        reply(200, summary);
        return;
      }

      if (req.method !== 'POST' || pathname !== '/v1/chat/completions') {
        reply(404, { error: { message: 'Not found. Only POST /v1/chat/completions is supported.' } });
        return;
      }

      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${token}`) {
        reply(401, { error: { message: 'Invalid or missing Authorization header. Set BAYZE_SERVE_TOKEN env var.' } });
        return;
      }

      const body = await readBody(req);
      const parsed = JSON.parse(body) as ChatCompletionRequest;

      if (parsed.stream) {
        await handleStreamRequest(req, res, app, parsed, reply);
        return;
      }

      const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user');
      const input = lastUser?.content ?? '';
      const workflowId = parsed.model ?? '';

      if (!workflowId || !input) {
        reply(400, { error: { message: 'Both "model" (workflow id) and a user message are required.' } });
        return;
      }

      const result = await app.run(
        { workflowId, input },
        { signal: new AbortController().signal },
      );

      if (!result.ok) {
        reply(200, toOpenAIResponse(workflowId, undefined, `Error: ${result.error.code}`));
        logRequest(req, res, started);
        return;
      }

      reply(200, toOpenAIResponse(workflowId, result.value));
      logRequest(req, res, started);
    } catch (e) {
      reply(500, { error: { message: 'Internal error' } });
      logRequest(req, res, started);
    }
  });

  server.listen(port, '127.0.0.1');
  server.timeout = HTTP_TIMEOUT_MS;
  return server;
}

function toOpenAIResponse(workflowId: string, run: RunResult | undefined, errorCode?: string): Record<string, unknown> {
  const content = errorCode ?? run?.finalOutput ?? '';
  const succeeded = !errorCode && run?.status === 'succeeded';
  return {
    id: run ? `chatcmpl-${run.runId}` : 'chatcmpl-error',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: workflowId,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: succeeded ? 'stop' : 'length' }],
    usage: {
      prompt_tokens: run?.steps.reduce((n: number, s: StepResult) => n + (s.usage?.inputTokens ?? 0), 0) ?? 0,
      completion_tokens: run?.steps.reduce((n: number, s: StepResult) => n + (s.usage?.outputTokens ?? 0), 0) ?? 0,
      total_tokens: run?.steps.reduce((n: number, s: StepResult) => n + (s.usage?.inputTokens ?? 0) + (s.usage?.outputTokens ?? 0), 0) ?? 0,
    },
  };
}

/** JSON 序列化并转义可能的控制字符 */
function sanitizeJson(payload: unknown): string {
  return JSON.stringify(payload).replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function logRequest(req: IncomingMessage, res: ServerResponse, started: number): void {
  process.stderr.write(`[bayze serve] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms\n`);
}

/** 加载 Web UI HTML（P2-③） */
let webUICache: string | undefined;
function getWebUI(): string {
  if (webUICache) return webUICache;
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    webUICache = readFileSync(join(moduleDir, 'webui.html'), 'utf8');
  } catch {
    webUICache = '<!DOCTYPE html><html><body><h1>Bayze</h1><p>Web UI not available. Use MCP tools or CLI.</p></body></html>';
  }
  return webUICache;
}

/** 配置摘要（供 Web UI / API） */
function toConfigSummary(cfg: BayzeConfig): Record<string, unknown> {
  const workflows = Object.entries(cfg.workflows).map(([id, wf]) => ({
    id,
    strategy: wf.strategy,
    profile: wf.profile,
    steps: wf.steps.map((s) => ({ name: s.name, provider: s.provider, model: s.model })),
    limits: { maxSteps: wf.limits.max_steps, totalTimeoutMs: wf.limits.total_timeout_ms, maxCostUsd: wf.limits.max_cost_usd },
  }));
  const providers = Object.entries(cfg.providers).map(([id, p]) => ({
    id,
    kind: p.kind,
    mode: p.kind !== 'mock' ? p.mode : undefined,
    models: p.models.map((m) => m.id),
  }));
  return { version: VERSION, workflows, providers, runtime: cfg.runtime };
}

/** SSE 流式响应（P2 / ADR-0004 流式扩展）：兼容 OpenAI stream 格式 */
async function handleStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  app: McpApp,
  parsed: ChatCompletionRequest,
  reply: (status: number, payload: unknown) => void,
): Promise<void> {
  const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user');
  const input = lastUser?.content ?? '';
  const workflowId = parsed.model ?? '';
  if (!workflowId || !input) {
    reply(400, { error: { message: 'Both "model" and a user message are required.' } });
    return;
  }

  // SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  const id = `chatcmpl-${Date.now()}`;
  const send = (data: unknown): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 发送 role chunk
  send({ id, object: 'chat.completion.chunk', model: workflowId, choices: [{ index: 0, delta: { role: 'assistant' } }] });

  // 执行工作流，进度作为 SSE 注释（不影响内容）
  const result = await app.run(
    { workflowId, input },
    {
      signal: new AbortController().signal,
      onProgress: (p) => {
        res.write(`: [bayze] step ${p.step}: ${p.status}\n\n`);
      },
    },
  );

  if (!result.ok) {
    // 错误也以内容形式发送
    send({ id, object: 'chat.completion.chunk', model: workflowId, choices: [{ index: 0, delta: { content: `Error: ${result.error.code}` } }] });
    send({ id, object: 'chat.completion.chunk', model: workflowId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const run = result.value;
  const content = run.finalOutput ?? '';
  // 按段落分块发送（模拟流式）
  const chunks = content.length > 200 ? content.match(/[\s\S]{1,200}/g) ?? [content] : [content];
  for (const chunk of chunks) {
    send({ id, object: 'chat.completion.chunk', model: workflowId, choices: [{ index: 0, delta: { content: chunk } }] });
  }
  send({ id, object: 'chat.completion.chunk', model: workflowId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}
