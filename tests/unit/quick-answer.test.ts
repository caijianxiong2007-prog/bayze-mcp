import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderAdapter } from '../../src/providers/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

function quickAnswerConfig(): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: {
      mockmain: {
        kind: 'mock',
        models: [
          { id: 'mock-success', pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } },
          { id: 'mock-empty' },
        ],
      },
    },
    workflows: {
      quick: {
        strategy: 'waterfall',
        limits: { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 1000, max_cost_usd: 0.01, allow_unknown_price: true },
        steps: [
          { name: 'answer', provider: 'mockmain', model: 'mock-success', input: 'original', timeout_ms: 3000, evaluate: ['non_empty', { max_chars: 5000 }] },
        ],
      },
      quick_empty: {
        strategy: 'waterfall',
        limits: { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 1000, allow_unknown_price: true },
        steps: [
          { name: 'answer', provider: 'mockmain', model: 'mock-empty', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
        ],
      },
    },
  });
}

test('quick_answer：单步成功，无评审无升级', async () => {
  const c = quickAnswerConfig();
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['mockmain', new MockProvider('mockmain')]]));
  const r = await orch.run({ workflowId: 'quick', input: '什么是 HTTPS' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.equal(res.stopReason, 'completed');
    assert.equal(res.steps.length, 1);
    assert.equal(res.steps[0]?.stepName, 'answer');
    assert.equal(res.steps[0]?.status, 'succeeded');
    assert.equal(res.steps[0]?.mode, 'byok');
    assert.ok(res.finalOutput !== undefined);
    assert.equal(res.reviewSummary, undefined);
    assert.equal(res.triggerReason, undefined);
  }
});

test('quick_answer 空输出：draft_check_failed（不升级因为没有下一步）', async () => {
  const c = quickAnswerConfig();
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['mockmain', new MockProvider('mockmain')]]));
  const r = await orch.run({ workflowId: 'quick_empty', input: 'test' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.status, 'failed');
    assert.equal(r.value.stopReason, 'draft_check_failed');
    assert.equal(r.value.triggerReason, 'check_failed:non_empty');
    assert.equal(r.value.steps.length, 1);
  }
});
