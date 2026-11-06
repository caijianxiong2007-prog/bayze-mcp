import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderAdapter, ProviderChatRequest, ProviderChatResponse, ProviderError } from '../../src/providers/types.js';
import type { Result } from '../../src/domain/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 辩论场景适配器：按 system 标识分流——开场/反驳走 mock-success，裁决返回固定文本 */
class DebateAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  constructor(
    readonly providerId: string,
    private readonly verdict: string,
  ) {}
  capabilities() {
    return { streaming: false, json: true, tools: false, vision: false };
  }
  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    if ((req.system ?? '').includes('impartial arbiter')) {
      return { ok: true, value: { content: this.verdict, usage: { inputTokens: 20, outputTokens: 15 } } };
    }
    const mock = new MockProvider('m');
    return mock.chat({ ...req, modelId: 'mock-success' });
  }
}

const PRICED = { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 };

function debateProviders(): any {
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

function debateCfg(over: Record<string, any> = {}): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: debateProviders(),
    workflows: {
      debate: {
        strategy: 'debate',
        judge: { provider: 'm', model: 'mock-review-accept' },
        limits: { max_steps: 8, total_timeout_ms: 20000, max_output_tokens: 2000, allow_unknown_price: true },
        steps: [
          { name: 'side_a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
          { name: 'side_b', provider: 'm', model: 'mock-review-accept', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
        ],
        ...over,
      },
    },
  });
}

// ────────────────────────── schema ──────────────────────────

test('debate schema：缺 judge / 步数≠2 / rounds 越界 / aggregate 误配 全拒绝', () => {
  // 缺 judge
  assert.throws(() =>
    configSchema.parse({
      version: 1,
      providers: debateProviders(),
      workflows: {
        d: {
          strategy: 'debate',
          limits: { max_steps: 4, total_timeout_ms: 5000, max_output_tokens: 100, allow_unknown_price: true },
          steps: [
            { name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 },
            { name: 'b', provider: 'm', model: 'mock-review-accept', input: 'original', timeout_ms: 1000 },
          ],
        },
      },
    }), /requires judge/);
  // 步数 3
  assert.throws(() =>
    debateCfg({
      steps: [
        { name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 },
        { name: 'b', provider: 'm', model: 'mock-review-accept', input: 'original', timeout_ms: 1000 },
        { name: 'c', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 },
      ],
    }), /exactly 2/);
  // rounds 越界（>3）
  assert.throws(() => debateCfg({ rounds: 4 }), /rounds/);
  // debate + aggregate
  assert.throws(() => debateCfg({ aggregate: { provider: 'm', model: 'mock-success' } }), /aggregate is only valid/);
  // waterfall + rounds
  assert.throws(() =>
    configSchema.parse({
      version: 1,
      providers: debateProviders(),
      workflows: {
        w: {
          strategy: 'waterfall',
          rounds: 2,
          limits: { max_steps: 2, total_timeout_ms: 5000, max_output_tokens: 100 },
          steps: [{ name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 }],
        },
      },
    }), /rounds is only valid/);
  // 合法配置默认 rounds=1；debate 的 judge.evaluate 允许（裁决输出自由文本）
  const c = debateCfg({ judge: { provider: 'm', model: 'mock-review-accept', evaluate: ['non_empty', { max_chars: 500 }] } });
  assert.equal(c.workflows['debate']!.rounds, 1);
});

// ────────────────────────── 引擎 ──────────────────────────

test('debate：开场×2 + 反驳×2 + 裁决 → finalOutput=裁决文本，agreement 报告', async () => {
  const c = debateCfg();
  const adapters = new Map<string, ProviderAdapter>([
    ['m', new DebateAdapter('m', 'Side B is more convincing: it survived the cost challenge. 最终答案：应当采用 B 方案并压缩预算。')],
  ]);
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run({ workflowId: 'debate', input: '评估方案A与方案B' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.equal(res.finalOutput, 'Side B is more convincing: it survived the cost challenge. 最终答案：应当采用 B 方案并压缩预算。');
    // 步骤：开场×2 + 反驳×2（round1）+ 裁决 = 5
    assert.equal(res.steps.length, 5, JSON.stringify(res.steps.map((s) => s.stepId)));
    const arbiter = res.steps.find((s) => s.stepName === 'arbiter');
    assert.equal(arbiter?.status, 'succeeded');
    const rebuttals = res.steps.filter((s) => /-r1$/.test(s.stepId));
    assert.equal(rebuttals.length, 2);
    assert.ok(res.agreement !== undefined, '终局立场一致性应报告');
    assert.ok(res.warnings.some((w) => w.includes('arbiter verdict delivered')));
  }
});

test('debate：rounds=0 → 仅开场+裁决（3 步）', async () => {
  const c = debateCfg({ rounds: 0 });
  const adapters = new Map<string, ProviderAdapter>([['m', new DebateAdapter('m', '裁决：直接给出最终答案。')]]);
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run({ workflowId: 'debate', input: '评估' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.steps.length, 3);
    assert.ok(!r.value.steps.some((s) => /-r\d/.test(s.stepId)));
  }
});

test('debate：裁决超长被 evaluate 拦截 → 降级辩论记录拼接', async () => {
  const longVerdict = '这是很长很长的裁决文本，超过十个字的限制很多很多，用于验证裁决成品检查会拦截它。';
  const c = debateCfg({ judge: { provider: 'm', model: 'mock-review-accept', evaluate: [{ max_chars: 10 }] } });
  const adapters = new Map<string, ProviderAdapter>([['m', new DebateAdapter('m', longVerdict)]]);
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run({ workflowId: 'debate', input: '评估' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded', '降级不推翻运行');
    assert.ok(res.finalOutput?.includes('---'), '降级为辩论记录拼接');
    assert.ok(res.finalOutput?.includes('opening'), '拼接含开场记录');
    assert.equal(res.steps.find((s) => s.stepName === 'arbiter')?.status, 'failed');
    assert.ok(res.warnings.some((w) => w.includes('still over limit') || w.includes('arbiter output rejected')), '降级警告应在');
  }
});

/** 捕获 prompt 的适配器：验证 context 是否注入任务文本（0.13.1 修复） */
class CaptureAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  lastUser = '';
  constructor(readonly providerId: string) {}
  capabilities() { return { streaming: false, json: false, tools: false, vision: false }; }
  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    this.lastUser = req.user;
    const mock = new MockProvider('m');
    const r = await mock.chat({ ...req, modelId: 'mock-success' });
    return r;
  }
}

test('debate：context 注入任务文本（0.13.1 修复——此前 MCP 层接收但编排器丢弃）', async () => {
  const c = debateCfg();
  const cap = new CaptureAdapter('m');
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', cap]]));
  const r = await orch.run(
    { workflowId: 'debate', input: '评估方案', context: '每段发言不超过 300 字' },
    { signal: new AbortController().signal },
  );
  assert.ok(r.ok);
  assert.ok(cap.lastUser.includes('每段发言不超过 300 字'), 'context 必须出现在开场 prompt');
  assert.ok(cap.lastUser.includes('CONTEXT (supplementary requirements'));
});

test('debate：双方开场全挂（max_chars）→ 零立场快速失败，不跑裁决不撒谎（0.13.1）', async () => {
  const c = debateCfg({
    steps: [
      // mock-success 输出约 60 字，max_chars=5 必挂
      { name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 2000, evaluate: ['non_empty', { max_chars: 5 }] },
      { name: 'b', provider: 'm', model: 'mock-review-accept', input: 'original', timeout_ms: 2000, evaluate: ['non_empty', { max_chars: 5 }] },
    ],
  });
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', new MockProvider('m')]]));
  const r = await orch.run({ workflowId: 'debate', input: '评估' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'failed');
    assert.equal(res.steps.length, 2, '只有两个开场步，不应有 arbiter');
    assert.ok(!res.steps.some((s) => s.stepName === 'arbiter'), '零立场不得跑裁决');
    assert.ok(res.warnings.some((w) => w.includes('nothing to arbitrate')));
    assert.ok(res.finalOutput === undefined);
  }
});

test('debate 0.13.2：开场带「只写己方立场」system（防单方开场=整场迷你辩论）；裁决 token 上限从字符闸推导', async () => {
  const c = debateCfg({ judge: { provider: 'm', model: 'mock-review-accept', evaluate: [{ max_chars: 800 }] } });
  const seen: Array<{ system: string; user: string; maxOutputTokens: number }> = [];
  class ProbeAdapter implements ProviderAdapter {
    readonly kind = 'mock' as const;
    constructor(readonly providerId: string) {}
    capabilities() { return { streaming: false, json: false, tools: false, vision: false }; }
    async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
      seen.push({ system: req.system ?? '', user: req.user, maxOutputTokens: req.maxOutputTokens });
      const mock = new MockProvider('m');
      return mock.chat({ ...req, modelId: req.modelId === 'mock-review-accept' ? 'mock-success' : req.modelId });
    }
  }
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', new ProbeAdapter('m')]]));
  const r = await orch.run({ workflowId: 'debate', input: '评估任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  // 开场：system 含立场限定
  const openings = seen.filter((x) => x.system.includes('ONE side'));
  assert.ok(openings.length >= 2);
  assert.ok(openings.every((x) => x.system.includes('ONE side')), '开场 system 应限定只写己方立场');
  assert.ok(openings.every((x) => x.system.includes('Do NOT simulate')), '开场应禁止模拟整场辩论');
  // 裁决：maxOutputTokens 从 max_chars 800 推导 = ceil(800/1.4)=572，且 < 工作流上限 2000
  const arbiter = seen.find((x) => x.system.includes('impartial arbiter'));
  assert.ok(arbiter, '应有裁决调用');
  assert.equal(arbiter!.maxOutputTokens, 364, 'token 上限应从字符闸推导（ceil(800/2.2)）');
  // 裁决 system 含「折扣不可验证量化论据」
  assert.ok(arbiter!.system.includes('Discount quantitative claims'), '裁决应折扣编造类论据');
});

/** 首次裁决超长、压缩重试收敛的适配器（0.13.3 自校准重试） */
class RetryArbiterAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  arbiterCalls = 0;
  constructor(readonly providerId: string) {}
  capabilities() { return { streaming: false, json: false, tools: false, vision: false }; }
  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    if ((req.system ?? '').includes('impartial arbiter')) {
      this.arbiterCalls++;
      const isRetry = req.user.includes('HARD LIMIT');
      const content = isRetry ? 'B 方更有说服力：成本论证被证伪。最终答案：分项迁移。' : '这是第一次裁决，写得非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长，远超十个字的限制，一定会被字符闸拒绝。';
      return { ok: true, value: { content, usage: { inputTokens: 30, outputTokens: Math.max(1, Math.floor(content.length / 2)) } } };
    }
    const mock = new MockProvider('m');
    return mock.chat({ ...req, modelId: req.modelId === 'mock-review-accept' ? 'mock-success' : req.modelId });
  }
}

test('debate 0.13.3：裁决超闸 → 自校准压缩重试成功交付（不再整段丢弃）', async () => {
  const c = debateCfg({ judge: { provider: 'm', model: 'mock-review-accept', evaluate: [{ max_chars: 40 }] } });
  const adapter = new RetryArbiterAdapter('m');
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', adapter]]));
  const r = await orch.run({ workflowId: 'debate', input: '评估' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(adapter.arbiterCalls, 2, '裁决应调用两次（首发+压缩重试）');
    assert.ok(res.finalOutput?.includes('分项迁移'), 'finalOutput 应为压缩后的裁决');
    const first = res.steps.find((s) => s.stepId === 'arbiter');
    const retry = res.steps.find((s) => s.stepId === 'arbiter-retry');
    assert.equal(first?.status, 'failed', '首发超闸记 failed');
    assert.equal(retry?.status, 'succeeded', '压缩重试成功');
    assert.ok(res.warnings.some((w) => w.includes('compress-retry delivered')));
  }
});
