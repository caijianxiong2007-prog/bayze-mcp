import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BayzeConfig } from '../../config/schema.js';
import type { McpApp } from '../../transport/mcp/app.js';
import type { RunResult, StepResult } from '../../domain/types.js';

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
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
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
        reply(400, { error: { message: 'Streaming is not supported yet.' } });
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
