import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { startServeApp } from '../../src/transport/http/server.js';
import { McpApp } from '../../src/transport/mcp/app.js';
import { RunJournal } from '../../src/journal/journal.js';

const TOKEN = 'unit-test-serve-token';

function testCfg(): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: {
      mockmain: { kind: 'mock', models: [{ id: 'mock-success' }] },
    },
    workflows: {
      quick: {
        strategy: 'waterfall',
        limits: { max_steps: 1, total_timeout_ms: 3000, max_output_tokens: 500 },
        steps: [{ name: 'answer', provider: 'mockmain', model: 'mock-success', input: 'original', timeout_ms: 2000, evaluate: ['non_empty'] }],
      },
    },
  });
}

async function withServe(fn: (port: number) => Promise<void>): Promise<void> {
  const cfg = testCfg();
  const app = new McpApp(cfg, new RunJournal(null));
  const server = startServeApp(cfg, app, 0, TOKEN);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('serve：GET / 返回 Web UI HTML', async () => {
  await withServe(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const body = await res.text();
    assert.match(body, /<html/);
  });
});

test('serve（回归）：GET /?token=xxx 带 query 也必须命中 Web UI，不得 404', async () => {
  await withServe(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const body = await res.text();
    assert.match(body, /<html/);
    assert.ok(!body.includes('Not found'), 'must not fall through to JSON 404');
  });
});

test('serve（回归）：GET /ui?anything=1 同样命中', async () => {
  await withServe(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ui?anything=1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  });
});

test('serve：GET /api/workflows 鉴权——无 token 401，Bearer 通过并返回摘要', async () => {
  await withServe(async (port) => {
    const denied = await fetch(`http://127.0.0.1:${port}/api/workflows`);
    assert.equal(denied.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(ok.status, 200);
    const data = (await ok.json()) as { version?: string; workflows?: Array<{ id: string }> };
    assert.ok(data.version && /^\d+\.\d+\.\d+/.test(data.version), 'version should come from package.json');
    assert.ok(data.workflows?.some((w) => w.id === 'quick'));
  });
});

test('serve：POST /v1/chat/completions 用 mock 工作流跑通', async () => {
  await withServe(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'quick', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    assert.ok(typeof data.choices?.[0]?.message?.content === 'string');
  });
});

test('serve：未知路径 404 JSON', async () => {
  await withServe(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 404);
    const data = (await res.json()) as { error?: { message?: string } };
    assert.match(data.error?.message ?? '', /Not found/);
  });
});
