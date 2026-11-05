import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderAdapter } from '../../src/providers/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function parallelConfig(): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: {
      m: {
        kind: 'mock',
        models: [
          { id: 'mock-success', pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } },
          { id: 'mock-empty' },
          { id: 'mock-review-accept', pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } },
        ],
      },
    },
    workflows: {
      compare: {
        strategy: 'parallel',
        limits: { max_steps: 3, total_timeout_ms: 10000, max_output_tokens: 1000, allow_unknown_price: true },
        steps: [
          { name: 'model_a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
          { name: 'model_b', provider: 'm', model: 'mock-review-accept', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
          { name: 'model_c', provider: 'm', model: 'mock-empty', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
        ],
      },
    },
  });
}

test('parallel：三模型并发，2 成功 1 失败（mock-empty），finalOutput 含对比', async () => {
  const c = parallelConfig();
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', new MockProvider('m')]]));
  const r = await orch.run({ workflowId: 'compare', input: 'test input' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.equal(res.stopReason, 'completed');
    assert.equal(res.steps.length, 3);
    // model_a 和 model_b 成功，model_c（mock-empty）检查失败
    const byName = new Map(res.steps.map((s) => [s.stepName, s.status]));
    assert.equal(byName.get('model_a'), 'succeeded');
    assert.equal(byName.get('model_b'), 'succeeded');
    assert.equal(byName.get('model_c'), 'failed');
    // finalOutput 含两个成功结果的拼接
    assert.ok(res.finalOutput?.includes('model_a/mock-success'));
    assert.ok(res.finalOutput?.includes('model_b/mock-review-accept'));
    assert.ok(res.finalOutput?.includes('---'));
    // 警告含并行统计
    assert.ok(res.warnings.some((w) => /parallel.*2\/3/.test(w)));
  }
});

test('parallel schema：不允许 run_if', () => {
  assert.throws(() => {
    configSchema.parse({
      version: 1,
      providers: { m: { kind: 'mock', models: [{ id: 'x' }] } },
      workflows: {
        w: {
          strategy: 'parallel',
          limits: { max_steps: 2, total_timeout_ms: 5000, max_output_tokens: 100 },
          steps: [
            { name: 'a', provider: 'm', model: 'x', input: 'original', timeout_ms: 1000 },
            { name: 'b', provider: 'm', model: 'x', input: 'original', timeout_ms: 1000, run_if: 'always' },
          ],
        },
      },
    });
  });
});

test('parallel schema：不允许 gate', () => {
  assert.throws(() => {
    configSchema.parse({
      version: 1,
      providers: { m: { kind: 'mock', models: [{ id: 'x' }] } },
      workflows: {
        w: {
          strategy: 'parallel',
          limits: { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 100 },
          steps: [
            { name: 'a', provider: 'm', model: 'x', input: 'original', timeout_ms: 1000, gate: 'structured_review' },
          ],
        },
      },
    });
  });
});

test('parallel：每步带 mode 属性', async () => {
  const c = parallelConfig();
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', new MockProvider('m')]]));
  const r = await orch.run({ workflowId: 'compare', input: 'test' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.steps.every((s) => s.mode === 'byok'));
  }
});
