import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderChatRequest } from '../../src/providers/types.js';

function req(modelId: string, overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    modelId,
    user: 'task text for mock',
    maxOutputTokens: 100,
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('mock 不发起任何网络请求', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('network must not be used by mock adapter');
  }) as typeof fetch;
  try {
    const r = await new MockProvider('p').chat(req('mock-success'));
    assert.equal(r.ok, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('确定性：同输入两次调用结果一致', async () => {
  const p = new MockProvider('p');
  const a = await p.chat(req('mock-success'));
  const b = await p.chat(req('mock-success'));
  assert.deepEqual(a, b);
});

test('成功场景返回 usage 与 providerModelId', async () => {
  const r = await new MockProvider('p').chat(req('mock-success'));
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.usage);
    assert.equal(r.value.providerModelId, 'mock-success');
  }
});

test('评审场景返回可解析 JSON verdict', async () => {
  const accept = await new MockProvider('p').chat(req('mock-review-accept'));
  assert.ok(accept.ok);
  if (accept.ok) {
    assert.equal((JSON.parse(accept.value.content) as { verdict: string }).verdict, 'accept');
  }
  const revise = await new MockProvider('p').chat(req('mock-review-revise'));
  assert.ok(revise.ok);
  if (revise.ok) {
    assert.equal((JSON.parse(revise.value.content) as { verdict: string }).verdict, 'revise');
  }
});

test('限流场景：可重试并带 retryAfterMs', async () => {
  const r = await new MockProvider('p').chat(req('mock-rate-limit'));
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.error.code, 'rate_limit');
    assert.equal(r.error.retryable, true);
    assert.equal(typeof r.error.retryAfterMs, 'number');
  }
});

test('auth 场景：不可重试', async () => {
  const r = await new MockProvider('p').chat(req('mock-auth'));
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.error.code, 'auth');
    assert.equal(r.error.retryable, false);
  }
});

test('空输出场景：成功响应但内容为空（供 non_empty 检查）', async () => {
  const r = await new MockProvider('p').chat(req('mock-empty'));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.content, '');
});

test('挂起场景：中止信号提前返回 timeout 错误', async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10);
  try {
    const r = await new MockProvider('p').chat(req('mock-hang', { timeoutMs: 30000, signal: ac.signal }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, 'timeout');
  } finally {
    clearTimeout(timer);
  }
});
