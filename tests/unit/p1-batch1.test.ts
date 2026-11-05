import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { makePriceBook } from '../../src/application/workflows/orchestrator.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import { CredentialStore } from '../../src/credentials/store.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ——— P1-① runtime.fx ———

function fxConfig(fx?: any): BayzeConfig {
  return configSchema.parse({
    version: 1,
    runtime: fx ? { fx } : {},
    providers: {
      m: { kind: 'mock', models: [{ id: 'x', pricing: { currency: 'CNY', input_per_1m_tokens: 2.0, output_per_1m_tokens: 8.0 } }] },
    },
    workflows: { w: { strategy: 'waterfall', limits: { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 100, allow_unknown_price: true }, steps: [{ name: 's', provider: 'm', model: 'x', input: 'original', timeout_ms: 1000 }] } },
  });
}

test('runtime.fx：CNY 定价可换算为 USD', () => {
  const c = fxConfig({ rate_to_usd: 0.14, updated_at: '2026-11-05' });
  const book = makePriceBook(c);
  const price = book('m', 'x');
  assert.ok(price);
  assert.ok(Math.abs(price.inputPer1m - 2.0 * 0.14) < 0.001, `input: ${price.inputPer1m}`);
  assert.ok(Math.abs(price.outputPer1m - 8.0 * 0.14) < 0.001, `output: ${price.outputPer1m}`);
});

test('runtime.fx 未配置：CNY 定价仍为价格未知（fail-closed 不变）', () => {
  const c = fxConfig();
  const book = makePriceBook(c);
  assert.equal(book('m', 'x'), undefined);
});

// ——— P1-② keychain ———

test('keychain: 引用格式校验', () => {
  const store = new CredentialStore();
  const valid = store.resolve('keychain:my-key');
  assert.ok(valid.ok || (!valid.ok && valid.error.code !== 'invalid_ref'), 'valid format should not be invalid_ref');
  const invalid = store.resolve('keychain:bad key with spaces!');
  assert.ok(!invalid.ok);
  if (!invalid.ok) assert.equal(invalid.error.code, 'invalid_ref');
});

test('keychain: macOS 上可读取（或返回 keychain_error 而非 invalid_ref）', () => {
  if (process.platform !== 'darwin') return;
  const store = new CredentialStore();
  const r = store.resolve('keychain:nonexistent-test');
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'keychain_error');
});

// ——— P1-④ per-run max_chars override ———

function charConfig(maxChars?: number): { c: BayzeConfig; orch: WorkflowOrchestrator } {
  const c = configSchema.parse({
    version: 1,
    providers: { m: { kind: 'mock', models: [{ id: 'mock-success' }] } },
    workflows: {
      w: {
        strategy: 'waterfall',
        limits: { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 1000 },
        steps: [{ name: 's', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 3000, evaluate: ['non_empty', { max_chars: 10000 }] }],
      },
    },
  });
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', new MockProvider('m')]]));
  return { c, orch };
}

test('max_chars override：收紧到 10 → mock 输出 ~60 字被拦截', async () => {
  const { orch } = charConfig();
  const r = await orch.run(
    { workflowId: 'w', input: 'test', userOverrides: { maxChars: 10 } },
    { signal: new AbortController().signal },
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.status, 'failed');
    assert.equal(r.value.triggerReason, 'check_failed:max_chars');
  }
});

test('max_chars override：不传 → 原始阈值 10000 生效，不被拦截', async () => {
  const { orch } = charConfig();
  const r = await orch.run({ workflowId: 'w', input: 'test' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.status, 'succeeded');
});
