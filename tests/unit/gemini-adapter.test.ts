import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiAdapter } from '../../src/providers/gemini/adapter.js';
import { CredentialStore } from '../../src/credentials/store.js';
import type { GeminiProviderConfig } from '../../src/config/schema.js';
import type { ProviderChatRequest } from '../../src/providers/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

const FAKE_ENV = 'BAYZE_UNIT_FAKE_GEMINI_KEY';
process.env[FAKE_ENV] = 'unit-test-gemini-key'; // 本地假值，非可用凭证

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

function adapterFor(url: string): GeminiAdapter {
  const cfg = {
    kind: 'gemini',
    base_url: url,
    api_key_ref: `env:${FAKE_ENV}`,
    allow_insecure_base_url: true,
    models: [{ id: 'gemini-2.0-flash' }],
  } as unknown as GeminiProviderConfig;
  return new GeminiAdapter('test-gemini', cfg, new CredentialStore());
}

function req(over: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return { modelId: 'gemini-2.0-flash', user: 'hello', maxOutputTokens: 64, timeoutMs: 1500, signal: new AbortController().signal, ...over };
}

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: 'gemini reply' }], role: 'model' } }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 11 },
  modelVersion: 'gemini-2.0-flash-001',
};

test('gemini：成功映射 candidates/usageMetadata；x-goog-api-key 头；:generateContent 路径', async () => {
  await withServer(
    (rq, res, body) => {
      assert.equal(rq.headers['x-goog-api-key'], process.env[FAKE_ENV]);
      assert.equal(rq.method, 'POST');
      assert.equal(rq.url, '/v1beta/models/gemini-2.0-flash:generateContent');
      const parsed = JSON.parse(body) as any;
      assert.deepEqual(parsed.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
      assert.equal(parsed.generationConfig.maxOutputTokens, 64);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK_BODY));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.value.content, 'gemini reply');
        assert.deepEqual(r.value.usage, { inputTokens: 7, outputTokens: 11 });
        assert.equal(r.value.providerModelId, 'gemini-2.0-flash-001');
      }
    },
  );
});

test('gemini：system 走 systemInstruction 顶层字段（协议差异验证）', async () => {
  await withServer(
    (_rq, res, body) => {
      const parsed = JSON.parse(body) as any;
      assert.deepEqual(parsed.systemInstruction, { parts: [{ text: 'be strict' }] });
      assert.equal(parsed.contents.length, 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK_BODY));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req({ system: 'be strict' }));
      assert.ok(r.ok);
    },
  );
});

test('gemini：多 parts 文本拼接', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...OK_BODY, candidates: [{ content: { parts: [{ text: 'a-' }, { text: 'b' }] } }] }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(r.ok);
      if (r.ok) assert.equal(r.value.content, 'a-b');
    },
  );
});

test('gemini：401/403 → auth 不可重试', async () => {
  for (const status of [401, 403]) {
    await withServer(
      (_rq, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: status, message: 'API key not valid' } }));
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
  }
});

test('gemini：429 + retry-after → rate_limit 可重试', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }));
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

test('gemini：400 safety 拦截 → content_blocked；其它 400 → invalid_request', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 400, message: 'Request was blocked by safety filters' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) assert.equal(r.error.code, 'content_blocked');
    },
  );
  await withServer(
    (_rq, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) assert.equal(r.error.code, 'invalid_request');
    },
  );
});

test('gemini：5xx → provider_unavailable 可重试', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 503, message: 'model overloaded' } }));
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

test('gemini：错误信息中泄漏的密钥模式被脱敏', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 400, message: `key sk-abcdef1234567890abcdef rejected` } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) assert.ok(!r.error.message.includes('sk-abcdef1234567890abcdef'), 'error message must be redacted');
    },
  );
});
