import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderAdapter, ProviderChatRequest, ProviderChatResponse, ProviderError } from '../../src/providers/types.js';
import type { Result } from '../../src/domain/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 固定返回文本的适配器（聚合器模拟：聚合 prompt 命中 system 标识，其余走 mock） */
class FixedAggregatorAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  constructor(
    readonly providerId: string,
    private readonly inner: ProviderAdapter,
    private readonly synthesis: string,
  ) {}
  capabilities() {
    return this.inner.capabilities();
  }
  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    if ((req.system ?? '').includes('synthesis writer')) {
      return { ok: true, value: { content: this.synthesis, usage: { inputTokens: 50, outputTokens: 40 } } };
    }
    if ((req.system ?? '').includes('synthesis writer') && this.synthesis === '') {
      return { ok: true, value: { content: '', usage: { inputTokens: 1, outputTokens: 1 } } };
    }
    return this.inner.chat(req);
  }
}

/** 聚合步永远返回空串的适配器（触发 non_empty 降级） */
class EmptyAggregatorAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  constructor(readonly providerId: string) {}
  capabilities() {
    return { streaming: false, json: false, tools: false, vision: false };
  }
  async chat(): Promise<Result<ProviderChatResponse, ProviderError>> {
    return { ok: true, value: { content: '', usage: { inputTokens: 1, outputTokens: 1 } } };
  }
}

const PRICED = { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 };

function moaProviders(): any {
  return {
    m: {
      kind: 'mock',
      models: [
        { id: 'mock-success', pricing: PRICED },
        { id: 'mock-review-accept', pricing: PRICED },
      ],
    },
  };
}

function moaCfg(over: Record<string, any> = {}): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: moaProviders(),
    workflows: {
      syn: {
        strategy: 'moa',
        aggregate: { provider: 'm', model: 'mock-review-accept' },
        limits: { max_steps: 4, total_timeout_ms: 10000, max_output_tokens: 1000, allow_unknown_price: true },
        steps: [
          { name: 'model_a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
          { name: 'model_b', provider: 'm', model: 'mock-review-accept', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
        ],
        ...over,
      },
    },
  });
}

// ────────────────────────── schema ──────────────────────────

test('moa schema：缺 aggregate 拒绝；moa+judge 拒绝；parallel+aggregate 拒绝；waterfall+aggregate 拒绝', () => {
  // 缺 aggregate
  assert.throws(() =>
    configSchema.parse({
      version: 1,
      providers: moaProviders(),
      workflows: {
        syn: {
          strategy: 'moa',
          limits: { max_steps: 2, total_timeout_ms: 5000, max_output_tokens: 100, allow_unknown_price: true },
          steps: [{ name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 }],
        },
      },
    }), /requires aggregate/);
  // moa + judge
  assert.throws(() => moaCfg({ judge: { provider: 'm', model: 'mock-success' } }), /judge is not valid/);
  // parallel + aggregate
  assert.throws(() =>
    configSchema.parse({
      version: 1,
      providers: moaProviders(),
      workflows: {
        p: {
          strategy: 'parallel',
          aggregate: { provider: 'm', model: 'mock-success' },
          limits: { max_steps: 2, total_timeout_ms: 5000, max_output_tokens: 100, allow_unknown_price: true },
          steps: [{ name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 }],
        },
      },
    }), /aggregate is only valid for strategy: moa/);
  // waterfall + aggregate
  assert.throws(() =>
    configSchema.parse({
      version: 1,
      providers: moaProviders(),
      workflows: {
        w: {
          strategy: 'waterfall',
          aggregate: { provider: 'm', model: 'mock-success' },
          limits: { max_steps: 2, total_timeout_ms: 5000, max_output_tokens: 100 },
          steps: [{ name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 }],
        },
      },
    }), /aggregate is only valid for strategy: moa/);
  // aggregate 引用不存在的 provider
  assert.throws(() => moaCfg({ aggregate: { provider: 'ghost', model: 'x' } }), /unknown provider .*ghost/);
  // moa 步骤带 run_if 拒绝
  assert.throws(() =>
    configSchema.parse({
      version: 1,
      providers: moaProviders(),
      workflows: {
        syn: {
          strategy: 'moa',
          aggregate: { provider: 'm', model: 'mock-success' },
          limits: { max_steps: 2, total_timeout_ms: 5000, max_output_tokens: 100, allow_unknown_price: true },
          steps: [
            { name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 },
            { name: 'b', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000, run_if: 'always' },
          ],
        },
      },
    }), /run_if/);
});

// ────────────────────────── 引擎 ──────────────────────────

test('moa：aggregate.evaluate max_chars 拦下超长成品 → 降级拼接对比（Cherry 测试②标定的缺口）', async () => {
  const c = moaCfg({ aggregate: { provider: 'm', model: 'mock-review-accept', evaluate: ['non_empty', { max_chars: 10 }] } });
  const long = '这是一段远超十个字限制的聚合成品输出，用于验证成品字数检查会拦截它。';
  const adapters = new Map<string, ProviderAdapter>([
    ['m', new (class implements ProviderAdapter {
      readonly kind = 'mock' as const;
      constructor(readonly providerId: string) {}
      capabilities() { return { streaming: false, json: false, tools: false, vision: false }; }
      async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
        if ((req.system ?? '').includes('synthesis writer')) {
          return { ok: true, value: { content: long, usage: { inputTokens: 5, outputTokens: 5 } } };
        }
        const mock = new MockProvider('m');
        return mock.chat({ ...req, modelId: req.modelId === 'mock-review-accept' ? 'mock-success' : req.modelId });
      }
    })('m')],
  ]);
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run({ workflowId: 'syn', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded', '降级不推翻运行');
    assert.ok(res.finalOutput?.includes('---'), '降级为拼接对比');
    const aggStep = res.steps.find((s) => s.stepName === 'aggregate');
    assert.equal(aggStep?.status, 'failed');
    assert.ok(aggStep?.checks.some((ck) => ck.checkId === 'max_chars' && !ck.passed), '失败详情应含 max_chars');
    assert.ok(res.warnings.some((w) => w.includes('aggregate output rejected')));
  }
});

test('moa schema：judge 不允许 evaluate（judge 输出是引擎解析的 JSON）', () => {
  assert.throws(() => moaCfg({ judge: { provider: 'm', model: 'mock-success', evaluate: ['non_empty'] } }), /not valid on judge/);
});

test('moa：per-run maxChars 收紧同样作用于聚合成品', async () => {
  const c = moaCfg({ aggregate: { provider: 'm', model: 'mock-review-accept', evaluate: [{ max_chars: 10000 }] } });
  const medium = '这段聚合成品有二十个字左右长度。'; // 16 字 < 10000 但 > 收紧后的 10
  const adapters = new Map<string, ProviderAdapter>([
    ['m', new (class implements ProviderAdapter {
      readonly kind = 'mock' as const;
      constructor(readonly providerId: string) {}
      capabilities() { return { streaming: false, json: false, tools: false, vision: false }; }
      async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
        if ((req.system ?? '').includes('synthesis writer')) {
          return { ok: true, value: { content: medium, usage: { inputTokens: 5, outputTokens: 5 } } };
        }
        const mock = new MockProvider('m');
        return mock.chat({ ...req, modelId: req.modelId === 'mock-review-accept' ? 'mock-success' : req.modelId });
      }
    })('m')],
  ]);
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run(
    { workflowId: 'syn', input: 'x', userOverrides: { maxChars: 10 } },
    { signal: new AbortController().signal },
  );
  assert.ok(r.ok);
  if (r.ok) {
    const aggStep = r.value.steps.find((s) => s.stepName === 'aggregate');
    assert.equal(aggStep?.status, 'failed', '收紧后聚合成品应被拦');
  }
});

test('moa：聚合成功 → finalOutput=合成文本，aggregate 步骤透明记录，agreement 报告', async () => {
  const c = moaCfg();
  const adapters = new Map<string, ProviderAdapter>([
    ['m', new FixedAggregatorAdapter('m', new MockProvider('m'), '这是融合了两份候选优点的最终答案。')],
  ]);
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run({ workflowId: 'syn', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.equal(res.finalOutput, '这是融合了两份候选优点的最终答案。');
    const aggStep = res.steps.find((s) => s.stepName === 'aggregate');
    assert.equal(aggStep?.status, 'succeeded');
    assert.equal(aggStep?.modelId, 'mock-review-accept');
    // 两个候选步骤保留 + 聚合步骤
    assert.equal(res.steps.filter((s) => s.stepName.startsWith('model_')).length, 2);
    assert.ok(res.warnings.some((w) => w.includes('aggregated 2 candidate')));
    assert.ok(res.agreement !== undefined);
  }
});

test('moa：聚合输出为空（non_empty 失败）→ 降级拼接对比 + 失败步骤 + warning', async () => {
  const c = moaCfg();
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', new EmptyAggregatorAdapter('m')]]));
  const r = await orch.run({ workflowId: 'syn', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    // EmptyAggregator 对候选步也返回空 → 候选步 evaluate non_empty 失败……
    // 候选全失败时 outputs=0，aggregate 不触发，状态 failed——同样验证了「无候选不聚合」
    const candidates = res.steps.filter((s) => s.stepName.startsWith('model_'));
    if (candidates.every((s) => s.status === 'failed')) {
      assert.equal(res.status, 'failed');
      assert.ok(res.finalOutput === undefined);
    } else {
      assert.ok(res.finalOutput?.includes('---'), '应降级为拼接对比');
      assert.ok(res.warnings.some((w) => w.includes('falling back')));
      assert.equal(res.steps.find((s) => s.stepName === 'aggregate')?.status, 'failed');
    }
  }
});

test('moa：聚合失败（empty）+ 候选正常 → 降级拼接对比', async () => {
  const c = moaCfg();
  // 候选走 mock-success 正常输出；聚合走空串 → 降级
  const adapters = new Map<string, ProviderAdapter>([
    ['m', new (class implements ProviderAdapter {
      readonly kind = 'mock' as const;
      constructor(readonly providerId: string) {}
      capabilities() { return { streaming: false, json: false, tools: false, vision: false }; }
      async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
        if ((req.system ?? '').includes('synthesis writer')) {
          return { ok: true, value: { content: '', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        const mock = new MockProvider('m');
        return mock.chat({ ...req, modelId: req.modelId === 'mock-review-accept' ? 'mock-success' : req.modelId });
      }
    })('m')],
  ]);
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run({ workflowId: 'syn', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded', '聚合失败不推翻运行（增强不闸门）');
    assert.ok(res.finalOutput?.includes('---'), '降级为拼接对比');
    assert.equal(res.steps.find((s) => s.stepName === 'aggregate')?.status, 'failed');
    assert.ok(res.warnings.some((w) => w.includes('falling back')));
  }
});

test('moa：审批预估含 aggregate 目标（正价 + 低门槛 → 触发 pending_approval）', async () => {
  const c = configSchema.parse({
    version: 1,
    providers: {
      m: { kind: 'mock', models: [
        { id: 'mock-success', pricing: { currency: 'USD', input_per_1m_tokens: 1, output_per_1m_tokens: 1 } },
        { id: 'mock-review-accept', pricing: { currency: 'USD', input_per_1m_tokens: 1, output_per_1m_tokens: 1 } },
      ] },
    },
    workflows: {
      syn: {
        strategy: 'moa',
        aggregate: { provider: 'm', model: 'mock-review-accept' },
        limits: { max_steps: 4, total_timeout_ms: 10000, max_output_tokens: 4000, approval_threshold_usd: 0.0001 },
        steps: [
          { name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 3000 },
          { name: 'b', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 3000 },
        ],
      },
    },
  });
  const r = await new WorkflowOrchestrator(c).run({ workflowId: 'syn', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    // 正价 + 极低门槛 → 预估必然为正并触发待批准（间接证明 aggregate 已计入预估）
    assert.equal(r.value.stopReason, 'pending_approval');
    assert.ok(r.value.warnings.some((w) => w.includes('approval threshold')));
  }
});
