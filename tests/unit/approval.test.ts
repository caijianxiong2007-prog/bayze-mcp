import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import type { RunResult } from '../../src/domain/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

/** 有价格的 mock 供应商：1 USD/1M tokens（输入+输出），保证估算为正 */
function pricedProviders(): any {
  return {
    mockmain: {
      kind: 'mock',
      models: [
        {
          id: 'mock-success',
          pricing: { currency: 'USD', input_per_1m_tokens: 1, output_per_1m_tokens: 1 },
        },
      ],
    },
  };
}

function unpricedProviders(): any {
  return {
    mockmain: { kind: 'mock', models: [{ id: 'mock-success' }] },
  };
}

function approvalCfg(threshold: number | undefined, providers: any): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers,
    workflows: {
      wf: {
        strategy: 'waterfall',
        limits: {
          max_steps: 1,
          total_timeout_ms: 5000,
          max_output_tokens: 2000,
          ...(threshold !== undefined ? { approval_threshold_usd: threshold } : {}),
        },
        steps: [{ name: 'draft', provider: 'mockmain', model: 'mock-success', input: 'original', timeout_ms: 1000, evaluate: ['non_empty'] }],
      },
    },
  });
}

test('approval：预估超过门槛且未批准 → pending_approval，不产生任何步骤', async () => {
  // 估算 = (inputChars/4 + 2000 tokens)/1e6 * 1 USD ≈ 0.002+ → 超过 0.001 门槛
  const c = approvalCfg(0.001, pricedProviders());
  const r = await new WorkflowOrchestrator(c).run({ workflowId: 'wf', input: 'hello task' }, { signal: new AbortController().signal });
  const res = r as { ok: true; value: RunResult };
  assert.ok(res.ok);
  assert.equal(res.value.status, 'skipped');
  assert.equal(res.value.stopReason, 'pending_approval');
  assert.equal(res.value.steps.length, 0);
  assert.ok(res.value.warnings.some((w) => w.includes('approval threshold')));
  assert.ok(res.value.warnings.some((w) => w.includes('approved=true')));
});

test('approval：user_overrides.approved=true → 放行执行', async () => {
  const c = approvalCfg(0.001, pricedProviders());
  const r = await new WorkflowOrchestrator(c).run({
    workflowId: 'wf',
    input: 'hello task',
    userOverrides: { approved: true },
  }, { signal: new AbortController().signal });
  const res = r as { ok: true; value: RunResult };
  assert.ok(res.ok);
  assert.equal(res.value.stopReason, 'completed');
  assert.equal(res.value.steps.length, 1);
});

test('approval：预估低于门槛 → 无需批准直接执行', async () => {
  const c = approvalCfg(100, pricedProviders());
  const r = await new WorkflowOrchestrator(c).run({ workflowId: 'wf', input: 'hello task' }, { signal: new AbortController().signal });
  const res = r as { ok: true; value: RunResult };
  assert.ok(res.ok);
  assert.equal(res.value.stopReason, 'completed');
  assert.equal(res.value.steps.length, 1);
});

test('approval：价格未知（无法估算）→ 不触发门槛，正常执行', async () => {
  // fail-open 语义仅限批准节点本身：无法估算时不阻塞，预算护栏另有 fail-closed 规则
  const c = approvalCfg(0.001, unpricedProviders());
  const r = await new WorkflowOrchestrator(c).run({ workflowId: 'wf', input: 'hello task' }, { signal: new AbortController().signal });
  const res = r as { ok: true; value: RunResult };
  assert.ok(res.ok);
  assert.equal(res.value.stopReason, 'completed');
  assert.equal(res.value.steps.length, 1);
});

test('approval：未配置 approval_threshold_usd → 行为与之前完全一致', async () => {
  const c = approvalCfg(undefined, pricedProviders());
  const r = await new WorkflowOrchestrator(c).run({ workflowId: 'wf', input: 'hello task' }, { signal: new AbortController().signal });
  const res = r as { ok: true; value: RunResult };
  assert.ok(res.ok);
  assert.equal(res.value.stopReason, 'completed');
});

test('approval：threshold=0 → 任何可估算费用都需批准', async () => {
  const c = approvalCfg(0, pricedProviders());
  const r = await new WorkflowOrchestrator(c).run({ workflowId: 'wf', input: 'x' }, { signal: new AbortController().signal });
  const res = r as { ok: true; value: RunResult };
  assert.ok(res.ok);
  assert.equal(res.value.stopReason, 'pending_approval');
});
