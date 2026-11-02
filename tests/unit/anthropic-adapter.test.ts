import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicAdapter } from '../../src/providers/anthropic/adapter.js';
import { CredentialStore } from '../../src/credentials/store.js';
import type { AnthropicProviderConfig } from '../../src/config/schema.js';
import type { ProviderChatRequest } from '../../src/providers/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

const FAKE_ENV = 'BAYZE_UNIT_FAKE_ANTHROPIC_KEY';
process.env[FAKE_ENV] = 'unit-test-anthropic-key'; // 本地假值，非可用凭证

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, chunks: string) => void,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function adapterFor(url: string): AnthropicAdapter {
  const cfg = {
    kind: 'anthropic',
    base_url: url,
    api_key_ref: `env:${FAKE_ENV}`,
    allow_insecure_base_url: true,
    models: [{ id: 'm1' }],
  } as unknown as AnthropicProviderConfig;
  return new AnthropicAdapter('test-anthropic', cfg, new CredentialStore());
}

function req(over: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return { modelId: 'm1', user: 'hello', maxOutputTokens: 64, timeoutMs: 1500, signal: new AbortController().signal, ...over };
}

const OK_BODY = {
  content: [{ type: 'text', text: 'anthropic reply' }],
  usage: { input_tokens: 7, output_tokens: 11 },
  model: 'm1-anthropic',
};

test('anthropic：成功映射 content/usage；x-api-key + version 头；/v1/messages 路径', async () => {
  await withServer(
    (rq, res, body) => {
      assert.equal(rq.headers['x-api-key'], process.env[FAKE_ENV]);
      assert.equal(rq.headers['anthropic-version'], '2023-06-01');
      assert.equal(rq.url, '/v1/messages');
      const parsed = JSON.parse(body) as any;
      assert.equal(parsed.model, 'm1');
      assert.equal(parsed.max_tokens, 64);
      assert.deepEqual(parsed.messages, [{ role: 'user', content: 'hello' }]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK_BODY));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.value.content, 'anthropic reply');
        assert.deepEqual(r.value.usage, { inputTokens: 7, outputTokens: 11 });
        assert.equal(r.value.providerModelId, 'm1-anthropic');
      }
    },
  );
});

test('anthropic：system 为顶层参数（协议差异验证）', async () => {
  await withServer(
    (_rq, res, body) => {
      const parsed = JSON.parse(body) as any;
      assert.equal(parsed.system, 'be strict');
      assert.ok(!parsed.messages.some((m: any) => m.role === 'system'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK_BODY));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req({ system: 'be strict' }));
      assert.ok(r.ok);
    },
  );
});

test('anthropic：authentication_error → auth', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.error.code, 'auth');
        assert.equal(r.error.retryable, false);
      }
    },
  );
});

test('anthropic：rate_limit_error + retry-after → rate_limit 可重试', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.error.code, 'rate_limit');
        assert.equal(r.error.retryable, true);
        assert.equal(r.error.retryAfterMs, 1000);
      }
    },
  );
});

test('anthropic：overloaded_error → provider_unavailable 可重试', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.error.code, 'provider_unavailable');
        assert.equal(r.error.retryable, true);
      }
    },
  );
});

test('anthropic：invalid_request_error → invalid_request；多文本块拼接', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...OK_BODY, content: [{ type: 'text', text: 'part1-' }, { type: 'text', text: 'part2' }] }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(r.ok);
      if (r.ok) assert.equal(r.value.content, 'part1-part2');
    },
  );
  await withServer(
    (_rq, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad max_tokens' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) assert.equal(r.error.code, 'invalid_request');
    },
  );
});
