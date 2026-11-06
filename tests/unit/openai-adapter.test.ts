import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible/adapter.js';
import { CredentialStore } from '../../src/credentials/store.js';
import type { RemoteProviderConfig } from '../../src/config/schema.js';
import type { ProviderChatRequest } from '../../src/providers/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

const FAKE_ENV = 'BAYZE_UNIT_FAKE_PROVIDER_KEY';

process.env[FAKE_ENV] = 'unit-test-key-value'; // 本地假值，非可用凭证

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

function adapterFor(url: string): OpenAICompatibleAdapter {
  const cfg = {
    kind: 'openai-compatible',
    base_url: url,
    api_key_ref: `env:${FAKE_ENV}`,
    allow_insecure_base_url: true,
    models: [{ id: 'm1' }],
  } as unknown as RemoteProviderConfig;
  return new OpenAICompatibleAdapter('test-provider', cfg, new CredentialStore());
}

function req(over: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return { modelId: 'm1', user: 'hello', maxOutputTokens: 64, timeoutMs: 1500, signal: new AbortController().signal, ...over };
}

const OK_BODY = {
  choices: [{ message: { role: 'assistant', content: 'provider reply' } }],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
  model: 'm1@2026-11-01',
};

test('openai：成功映射 content/usage/providerModelId，携带 Bearer 头', async () => {
  await withServer(
    (rq, res, body) => {
      assert.equal(rq.headers['authorization'], `Bearer ${process.env[FAKE_ENV]}`);
      assert.equal(rq.url, '/chat/completions');
      const parsed = JSON.parse(body) as any;
      assert.equal(parsed.model, 'm1');
      assert.equal(parsed.stream, false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK_BODY));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.value.content, 'provider reply');
        assert.deepEqual(r.value.usage, { inputTokens: 12, outputTokens: 34 });
        assert.equal(r.value.providerModelId, 'm1@2026-11-01');
      }
    },
  );
});

test('openai：system 提示作为首条 message', async () => {
  await withServer(
    (rq, res, body) => {
      const parsed = JSON.parse(body) as any;
      assert.deepEqual(parsed.messages, [
        { role: 'system', content: 'be strict' },
        { role: 'user', content: 'hello' },
      ]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK_BODY));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req({ system: 'be strict' }));
      assert.ok(r.ok);
    },
  );
});

test('openai：401 → auth 不可重试，错误体脱敏', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key, sent as Bearer sk-fakefakefake12 by caller' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.error.code, 'auth');
        assert.equal(r.error.retryable, false);
        assert.ok(!r.error.message.includes('sk-fakefakefake12'));
        // byok 模式：不附加 Bayze API 注册引导
        assert.ok(!r.error.message.includes('lanwealth'));
      }
    },
  );
});

test('openai：bayze_api 模式 401 → 错误信息附注册入口（转化断点修复）', async () => {
  const cfg = {
    kind: 'openai-compatible',
    base_url: 'https://app.lanwealth.com/v1',
    mode: 'bayze_api',
    api_key_ref: `env:${FAKE_ENV}`,
    allow_insecure_base_url: false,
    models: [{ id: 'm1' }],
  } as unknown as RemoteProviderConfig;
  const adapter = new OpenAICompatibleAdapter('bayze', cfg, new CredentialStore());
  // 直接打真实主机会依赖网络——此处复用 mapProviderStatus 之上的 chat 组装逻辑，
  // 用本地回环 + 显式 opt-in 模拟同一错误路径
  await withServer(
    (_rq, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    },
    async (url) => {
      const local = new OpenAICompatibleAdapter(
        'bayze',
        { ...cfg, base_url: url, allow_insecure_base_url: true } as unknown as RemoteProviderConfig,
        new CredentialStore(),
      );
      void adapter;
      const r = await local.chat(req());
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.error.code, 'auth');
        assert.ok(r.error.message.includes('https://app.lanwealth.com/auth/login'), 'error must carry the signup URL');
        assert.ok(r.error.message.includes('1,200 free points'));
      }
    },
  );
});

test('openai：429 + Retry-After → rate_limit 可重试并带 retryAfterMs', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.error.code, 'rate_limit');
        assert.equal(r.error.retryable, true);
        assert.equal(r.error.retryAfterMs, 2000);
      }
    },
  );
});

test('openai：5xx → provider_unavailable 可重试；400 → invalid_request', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream down' } }));
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
  await withServer(
    (_rq, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'max_tokens invalid' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.error.code, 'invalid_request');
        assert.equal(r.error.retryable, false);
      }
    },
  );
});

test('openai：400 且错误体含 content/policy → content_blocked', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'content_policy_violation', message: 'flagged' } }));
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) assert.equal(r.error.code, 'content_blocked');
    },
  );
});

test('openai：步骤超时 → timeout（供应商延迟超过 timeoutMs）', async () => {
  await withServer(
    (_rq, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(OK_BODY));
      }, 800);
    },
    async (url) => {
      const r = await adapterFor(url).chat(req({ timeoutMs: 60 }));
      assert.ok(!r.ok);
      if (!r.ok) assert.equal(r.error.code, 'timeout');
    },
  );
});

test('openai：外部取消信号 → 立即返回错误', async () => {
  await withServer(
    (_rq, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end(JSON.stringify(OK_BODY));
      }, 800);
    },
    async (url) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15);
      try {
        const r = await adapterFor(url).chat(req({ signal: ac.signal, timeoutMs: 5000 }));
        assert.ok(!r.ok);
      } finally {
        clearTimeout(t);
      }
    },
  );
});

test('openai：连接拒绝 → network 可重试', async () => {
  // 占一个端口再关掉，保证连接被拒
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((r) => server.close(() => r()));
  const r = await adapterFor(`http://127.0.0.1:${port}`).chat(req({ timeoutMs: 800 }));
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'network');
});

test('openai：跨主机重定向被拒绝（不跟随）', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(302, { location: 'https://attacker.example/v1/chat/completions' });
      res.end();
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.error.code, 'unknown');
        assert.match(r.error.message, /redirect policy/);
      }
    },
  );
});

test('openai：声明超限的响应体被拒绝', async () => {
  await withServer(
    (_rq, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999999' });
      res.end();
    },
    async (url) => {
      const r = await adapterFor(url).chat(req());
      assert.ok(!r.ok);
      if (!r.ok) assert.match(r.error.message, /byte cap/);
    },
  );
});

test('openai：凭证环境变量缺失 → auth 结构化错误', async () => {
  const saved = process.env[FAKE_ENV];
  delete process.env[FAKE_ENV];
  try {
    const cfg = {
      kind: 'openai-compatible',
      base_url: 'https://provider.example/v1',
      api_key_ref: `env:${FAKE_ENV}`,
      models: [{ id: 'm1' }],
    } as unknown as RemoteProviderConfig;
    const r = await new OpenAICompatibleAdapter('p', cfg, new CredentialStore()).chat(req());
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.error.code, 'auth');
      assert.match(r.error.message, /is not set/);
    }
  } finally {
    if (saved !== undefined) process.env[FAKE_ENV] = saved;
  }
});
