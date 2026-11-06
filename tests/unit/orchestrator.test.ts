import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderAdapter, ProviderChatRequest, ProviderChatResponse, ProviderError } from '../../src/providers/types.js';
import type { RunResult, UserOverrides } from '../../src/domain/types.js';
import type { Result } from '../../src/domain/errors.js';

class CountingAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  calls = 0;
  constructor(readonly providerId: string, private readonly inner: ProviderAdapter) {}
  capabilities() {
    return this.inner.capabilities();
  }
  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    this.calls++;
    return this.inner.chat(req);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

const ALL_MODELS = [
  'mock-success',
  'mock-review-accept',
  'mock-review-revise',
  'mock-empty',
  'mock-timeout',
  'mock-rate-limit',
  'mock-auth',
  'mock-hang',
];

function mockProviders(pricing = true): any {
  return {
    mockmain: {
      kind: 'mock',
      models: ALL_MODELS.map((id) => ({ id, ...(pricing ? { pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } } : {}) })),
    },
  };
}

function rtr(draftModel = 'mock-success', reviewModel = 'mock-review-accept', reviseModel = 'mock-success'): any[] {
  return [
    { name: 'draft', provider: 'mockmain', model: draftModel, input: 'original', timeout_ms: 1000, evaluate: ['non_empty'] },
    { name: 'review', provider: 'mockmain', model: reviewModel, input: 'review_template', timeout_ms: 1000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] },
    { name: 'revise', provider: 'mockmain', model: reviseModel, input: 'revision_template', timeout_ms: 1000, run_if: 'review_verdict_is_revise' },
  ];
}

function plain(primaryModel: string, fallbackInput = 'original'): any[] {
  return [
    { name: 'primary', provider: 'mockmain', model: primaryModel, input: 'original', timeout_ms: 1000, evaluate: ['non_empty'] },
    { name: 'fallback', provider: 'mockmain', model: 'mock-success', input: fallbackInput, timeout_ms: 1000, run_if: 'on_check_failure' },
  ];
}

function cfg(workflows: Record<string, any>, providers: Record<string, any> = mockProviders()): BayzeConfig {
  const parsed: Record<string, any> = {};
  for (const [id, wf] of Object.entries(workflows)) {
    parsed[id] = { strategy: 'waterfall', limits: { max_steps: wf.steps.length, total_timeout_ms: 5000, max_output_tokens: 1000, ...wf.limits }, steps: wf.steps };
  }
  return configSchema.parse({ version: 1, providers, workflows: parsed });
}

async function run(
  c: BayzeConfig,
  workflowId: string,
  input = 'hello task',
  opts?: { signal?: AbortSignal; overrides?: UserOverrides; counter?: CountingAdapter },
): Promise<RunResult> {
  const adapters = opts?.counter
    ? new Map<string, ProviderAdapter>([['mockmain', opts.counter as unknown as ProviderAdapter]])
    : undefined;
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run(
    { workflowId, input, userOverrides: opts?.overrides },
    { signal: opts?.signal ?? new AbortController().signal },
  );
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
  if (r.ok) return r.value;
  throw new Error('unreachable');
}

test('accept：draft 1 次、review 1 次、revise 不调用；返回草稿与复核摘要', async () => {
  const counter = new CountingAdapter('mockmain', new MockProvider('mockmain'));
  const res = await run(cfg({ w: { steps: rtr() } }), 'w', 'hello', { counter });
  assert.equal(res.status, 'succeeded');
  assert.equal(res.stopReason, 'completed');
  assert.equal(res.reviewSummary?.verdict, 'accept');
  assert.match(res.finalOutput ?? '', /MOCK_OK\[mock-success\]/);
  const byName = new Map(res.steps.map((s) => [s.stepName, s.status]));
  assert.equal(byName.get('draft'), 'succeeded');
  assert.equal(byName.get('review'), 'succeeded');
  assert.equal(byName.get('revise'), 'skipped');
  assert.equal(counter.calls, 2);
  assert.equal(res.steps[0]?.estimatedCost, 0);
});

test('revise：reviewer 拒绝 → 修订恰好一次，返回修订稿', async () => {
  const counter = new CountingAdapter('mockmain', new MockProvider('mockmain'));
  const res = await run(cfg({ w: { steps: rtr('mock-success', 'mock-review-revise') } }), 'w', 'hello', { counter });
  assert.equal(res.status, 'succeeded');
  assert.equal(res.reviewSummary?.verdict, 'revise');
  assert.equal(res.steps.find((s) => s.stepName === 'revise')?.status, 'succeeded');
  assert.match(res.finalOutput ?? '', /MOCK_OK/);
  assert.equal(counter.calls, 3);
});

test('draft 空输出：draft_check_failed，review/revise 跳过', async () => {
  const res = await run(cfg({ w: { steps: rtr('mock-empty') } }), 'w');
  assert.equal(res.status, 'failed');
  assert.equal(res.stopReason, 'draft_check_failed');
  assert.equal(res.steps.filter((s) => s.status === 'skipped').length, 2);
  assert.equal(res.finalOutput, undefined);
});

test('长度检查失败：trigger 记录 check_failed:max_chars', async () => {
  const steps = rtr();
  (steps[0] as any).evaluate = [{ max_chars: 5 }];
  const res = await run(cfg({ w: { steps } }), 'w');
  assert.equal(res.stopReason, 'draft_check_failed');
  assert.equal(res.triggerReason, 'check_failed:max_chars');
});

test('auth 错误：立即停止不升级，fallback 跳过', async () => {
  const counter = new CountingAdapter('mockmain', new MockProvider('mockmain'));
  const res = await run(cfg({ w: { steps: plain('mock-auth') } }), 'w', 'x', { counter });
  assert.equal(res.status, 'failed');
  assert.equal(res.stopReason, 'workflow_exhausted');
  assert.equal(res.steps.find((s) => s.stepName === 'fallback')?.status, 'skipped');
  assert.equal(res.steps[0]?.errorCode, 'auth');
  assert.equal(counter.calls, 1);
});

test('超时：provider_timeout 触发升级，fallback 成功', async () => {
  const res = await run(cfg({ w: { steps: plain('mock-timeout') } }), 'w');
  assert.equal(res.status, 'succeeded');
  assert.equal(res.triggerReason, 'provider_timeout');
  assert.ok(res.finalOutput !== undefined);
});

test('限流：重试一次后升级；调用计数 2（主）+ 1（fallback）', async () => {
  const counter = new CountingAdapter('mockmain', new MockProvider('mockmain'));
  const res = await run(cfg({ w: { steps: plain('mock-rate-limit'), limits: { max_retries_per_step: 1 } } }), 'w', 'x', { counter });
  assert.equal(res.status, 'succeeded');
  assert.equal(res.triggerReason, 'rate_limit');
  assert.equal(counter.calls, 3);
});

test('预算：保守预估达硬上限 → 调用前拒绝，0 次调用', async () => {
  const providers = {
    pricey: {
      kind: 'mock',
      models: [{ id: 'mock-success', pricing: { currency: 'USD', input_per_1m_tokens: 1000, output_per_1m_tokens: 1000 } }],
    },
  };
  const counter = new CountingAdapter('pricey', new MockProvider('pricey'));
  const c = cfg({ w: { steps: [{ name: 'draft', provider: 'pricey', model: 'mock-success', input: 'original', timeout_ms: 1000, evaluate: ['non_empty'] }], limits: { max_cost_usd: 0.000001 } } }, providers);
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['pricey', counter]]));
  const r = await orch.run({ workflowId: 'w', input: 'some input' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.status, 'budget_exceeded');
    assert.equal(r.value.stopReason, 'budget_exceeded');
    assert.equal(counter.calls, 0);
    assert.ok(r.value.warnings.some((w) => /hard limit/.test(w)));
  }
});

test('未知价格 + 硬预算：默认 fail-closed 拒绝', async () => {
  const counter = new CountingAdapter('mockmain', new MockProvider('mockmain'));
  const c = cfg({ w: { steps: rtr(), limits: { max_cost_usd: 0.05 } } }, mockProviders(false));
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['mockmain', counter]]));
  const r = await orch.run({ workflowId: 'w', input: 'x' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.stopReason, 'budget_exceeded');
    assert.equal(counter.calls, 0);
    assert.ok(r.value.warnings.some((w) => /is unknown/.test(w)));
  }
});

test('未知价格 + 显式放行：可运行但费用不可估算', async () => {
  const c = cfg({ w: { steps: rtr(), limits: { max_cost_usd: 0.05, allow_unknown_price: true } } }, mockProviders(false));
  const res = await run(c, 'w');
  assert.equal(res.status, 'succeeded');
  assert.equal(res.steps[0]?.estimatedCost, undefined);
  assert.ok(res.warnings.some((w) => /could not be estimated/.test(w)));
});

test('reviewer 输出不可解析：review_failed，不默认 accept，草稿随失败返回', async () => {
  const res = await run(cfg({ w: { steps: rtr('mock-success', 'mock-success') } }), 'w');
  assert.equal(res.status, 'failed');
  assert.equal(res.stopReason, 'review_failed');
  assert.equal(res.steps.find((s) => s.stepName === 'revise')?.status, 'skipped');
  assert.ok(res.finalOutput !== undefined);
  assert.ok(res.warnings.some((w) => /failing closed/.test(w)));
});

test('reviewer 超时：review_failed', async () => {
  const res = await run(cfg({ w: { steps: rtr('mock-success', 'mock-timeout') } }), 'w');
  assert.equal(res.status, 'failed');
  assert.equal(res.stopReason, 'review_failed');
});

test('取消：挂起步骤被中止，状态 cancelled', async () => {
  const c = cfg({
    w: {
      steps: [{ name: 'draft', provider: 'mockmain', model: 'mock-hang', input: 'original', timeout_ms: 30000 }],
      limits: { total_timeout_ms: 60000 },
    },
  });
  const ac = new AbortController();
  const orch = new WorkflowOrchestrator(c);
  const p = orch.run({ workflowId: 'w', input: 'x' }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 15);
  const r = await p;
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.status, 'cancelled');
    assert.equal(r.value.stopReason, 'cancelled');
  }
});

test('整体超时：timed_out', async () => {
  const c = cfg({
    w: {
      steps: [{ name: 'draft', provider: 'mockmain', model: 'mock-hang', input: 'original', timeout_ms: 40 }],
      limits: { total_timeout_ms: 40 },
    },
  });
  const res = await run(c, 'w');
  assert.equal(res.status, 'timed_out');
  assert.equal(res.stopReason, 'timed_out');
});

test('original_and_previous 缺前序成功输出：missing_required_input', async () => {
  const res = await run(cfg({ w: { steps: plain('mock-timeout', 'original_and_previous') } }), 'w');
  assert.equal(res.status, 'failed');
  assert.equal(res.stopReason, 'missing_required_input');
});

test('maxSteps 收紧：截断后续步骤并告警', async () => {
  const res = await run(cfg({ w: { steps: rtr() } }), 'w', 'x', { overrides: { maxSteps: 1 } });
  assert.equal(res.status, 'succeeded');
  assert.ok(res.finalOutput !== undefined);
  assert.equal(res.steps.filter((s) => s.status === 'skipped').length, 2);
  assert.ok(res.warnings.some((w) => /truncated/.test(w)));
});

test('放宽型 override 被钳制并告警', async () => {
  const res = await run(cfg({ w: { steps: rtr() } }), 'w', 'x', { overrides: { maxSteps: 99, totalTimeoutMs: 999999 } });
  assert.ok(res.warnings.some((w) => /clamped/.test(w)));
  assert.equal(res.status, 'succeeded');
});

test('bayze_api 模式：每步带 mode=bayze_api + 账单警告（种子 mock，零网络）', async () => {
  const bayze = {
    kind: 'openai-compatible',
    mode: 'bayze_api',
    base_url: 'https://app.lanwealth.com/v1',
    api_key_ref: 'env:BAYZE_API_KEY',
    models: [
      { id: 'mock-success', pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } },
      { id: 'mock-review-accept', pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } },
    ],
  };
  const c = cfg(
    { w: { steps: [
      { name: 'draft', provider: 'bayze', model: 'mock-success', input: 'original', timeout_ms: 1000, evaluate: ['non_empty'] },
      { name: 'review', provider: 'bayze', model: 'mock-review-accept', input: 'review_template', timeout_ms: 1000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] },
      { name: 'revise', provider: 'bayze', model: 'mock-success', input: 'revision_template', timeout_ms: 1000, run_if: 'review_verdict_is_revise' },
    ] } },
    { mockmain: { kind: 'mock', models: [{ id: 'mock-success' }] }, bayze },
  );
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['bayze', new MockProvider('bayze')]]));
  const r = await orch.run({ workflowId: 'w', input: 'hello' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.ok(res.steps.every((s) => s.mode === 'bayze_api'), '每步 mode=bayze_api');
    assert.ok(
      res.warnings.some((w) => /app\.lanwealth\.com\/dashboard\/billing/.test(w)),
      `警告应含充值/账单直链: ${JSON.stringify(res.warnings)}`,
    );
  }
});

test('byok 模式（默认）：无账单警告', async () => {
  const res = await run(cfg({ w: { steps: rtr() } }), 'w');
  assert.equal(res.status, 'succeeded');
  assert.ok(res.steps.every((s) => s.mode === 'byok'));
  assert.ok(!res.warnings.some((w) => /账单为准/.test(w)));
});

test('dogfood 修复：revise 失败时顶层必须报 failed（不能静默 succeeded）', async () => {
  // 构造：draft 成功 → review 打回 → revise 超时失败（非 auth，不走短路路径）
  const c = cfg({
    w: {
      steps: [
        { name: 'draft', provider: 'mockmain', model: 'mock-success', input: 'original', timeout_ms: 1000, evaluate: ['non_empty'] },
        { name: 'review', provider: 'mockmain', model: 'mock-review-revise', input: 'review_template', timeout_ms: 1000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] },
        { name: 'revise', provider: 'mockmain', model: 'mock-timeout', input: 'revision_template', timeout_ms: 1000, run_if: 'review_verdict_is_revise' },
      ],
    },
  });
  const r = await run(c, 'w', 'test');
  assert.equal(r.reviewSummary?.verdict, 'revise');
  assert.equal(r.steps[2]?.status, 'failed');
  assert.equal(r.steps[2]?.errorCode, 'timeout');
  // 关键断言：不能报 succeeded
  assert.equal(r.status, 'failed', `expected failed but got ${r.status}`);
  assert.equal(r.stopReason, 'workflow_exhausted');
  assert.ok(r.warnings.some((w) => /did not deliver/.test(w)), JSON.stringify(r.warnings));
  // finalOutput 仍然是草稿（返回可用内容但不伪报成功）
  assert.ok(r.finalOutput !== undefined);
});

test('未知工作流：结构化 setup 错误', async () => {
  const orch = new WorkflowOrchestrator(cfg({ w: { steps: rtr() } }));
  const r = await orch.run({ workflowId: 'ghost', input: 'x' }, { signal: new AbortController().signal });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'unknown_workflow');
});

test('输入超限：input_too_large', async () => {
  const orch = new WorkflowOrchestrator(cfg({ w: { steps: rtr() } }));
  const r = await orch.run({ workflowId: 'w', input: 'x'.repeat(100_001) }, { signal: new AbortController().signal });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'input_too_large');
});
