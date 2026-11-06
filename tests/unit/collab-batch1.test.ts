import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderAdapter, ProviderChatRequest, ProviderChatResponse, ProviderError } from '../../src/providers/types.js';
import type { Result } from '../../src/domain/errors.js';
import { parseJudgeVerdict } from '../../src/domain/evaluation/judge.js';
import { answerAgreement, tokenSet } from '../../src/domain/evaluation/similarity.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 固定返回裁判 JSON 的适配器（winner 可配） */
class JudgeAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  constructor(
    readonly providerId: string,
    private readonly body: string,
  ) {}
  capabilities() {
    return { streaming: false, json: true, tools: false, vision: false };
  }
  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    void req;
    return { ok: true, value: { content: this.body, usage: { inputTokens: 10, outputTokens: 10 } } };
  }
}

/** 第一次评审 revise、第二次 accept 的适配器（修订循环用）；评审调用以 system 提示中的 reviewer 标识识别 */
class FlipReviewAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  reviewCalls = 0;
  constructor(readonly providerId: string, private readonly inner: ProviderAdapter) {}
  capabilities() {
    return this.inner.capabilities();
  }
  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    const inner = await this.inner.chat(req);
    if (!inner.ok) return inner;
    if (!(req.system ?? '').includes('structured reviewer')) return inner;
    this.reviewCalls++;
    if (this.reviewCalls === 1) {
      return { ok: true, value: { ...inner.value, content: '{"verdict":"revise","reasons":["needs tightening"]}' } };
    }
    return { ok: true, value: { ...inner.value, content: '{"verdict":"accept","reasons":["good after revision"]}' } };
  }
}

/** 永远 revise 的评审适配器 */
class AlwaysReviseAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  constructor(readonly providerId: string, private readonly inner: ProviderAdapter) {}
  capabilities() {
    return this.inner.capabilities();
  }
  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    const inner = await this.inner.chat(req);
    if (!inner.ok) return inner;
    if ((req.system ?? '').includes('structured reviewer')) {
      return { ok: true, value: { ...inner.value, content: '{"verdict":"revise","reasons":["still not there"]}' } };
    }
    return inner;
  }
}

const PRICED = { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 };

function baseProviders(): any {
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

function judgeConfig(over: Record<string, any> = {}): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: baseProviders(),
    workflows: {
      compare: {
        strategy: 'parallel',
        judge: { provider: 'm', model: 'mock-success' },
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

function rtrWorkflow(over: Record<string, any> = {}): any[] {
  return [
    { name: 'draft', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 2000, evaluate: ['non_empty'] },
    { name: 'review', provider: 'm', model: 'mock-review-accept', input: 'review_template', timeout_ms: 2000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] },
    { name: 'revise', provider: 'm', model: 'mock-success', input: 'revision_template', timeout_ms: 2000, run_if: 'review_verdict_is_revise' },
  ];
}

function waterfallCfg(wfOver: Record<string, any> = {}, limitsOver: Record<string, any> = {}): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: baseProviders(),
    workflows: {
      rtr: {
        strategy: 'waterfall',
        limits: { max_steps: 6, total_timeout_ms: 10000, max_output_tokens: 1000, allow_unknown_price: true, ...limitsOver },
        steps: rtrWorkflow(),
        ...wfOver,
      },
    },
  });
}

// ────────────────────────── schema 校验 ──────────────────────────

test('ADR-0006 schema：judge 仅 parallel；escalate_to 仅 waterfall；rubric 仅 gate；max_revisions ≥1', () => {
  assert.throws(() => waterfallCfg({ judge: { provider: 'm', model: 'mock-success' } }), /judge is only valid/);
  assert.throws(() => judgeConfig({ escalate_to: { provider: 'm', model: 'mock-success' } }), /escalate_to is only valid/);
  assert.throws(() =>
    configSchema.parse({
      version: 1,
      providers: baseProviders(),
      workflows: {
        w: {
          strategy: 'waterfall',
          limits: { max_steps: 2, total_timeout_ms: 5000, max_output_tokens: 100, max_revisions: 0 },
          steps: [
            { name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000 },
            { name: 'r', provider: 'm', model: 'mock-review-accept', input: 'review_template', timeout_ms: 1000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict'], rubric: ['x'] },
          ],
        },
      },
    }), /max_revisions/);
  // rubric 在非 gate 步骤上 → 拒绝
  assert.throws(() =>
    configSchema.parse({
      version: 1,
      providers: baseProviders(),
      workflows: {
        w: {
          strategy: 'waterfall',
          limits: { max_steps: 2, total_timeout_ms: 5000, max_output_tokens: 100 },
          steps: [{ name: 'a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000, rubric: ['x'] }],
        },
      },
    }), /rubric is only valid/);
  // judge 引用不存在的 provider/model → 根级交叉校验拒绝（ZodError 序列化会转义引号，用宽容正则）
  assert.throws(() => judgeConfig({ judge: { provider: 'ghost', model: 'x' } }), /unknown provider .*ghost/);
  assert.throws(() => judgeConfig({ judge: { provider: 'm', model: 'ghost-model' } }), /has no model .*ghost-model/);
  // 合法配置可解析，且 max_revisions 默认 1
  const c = judgeConfig();
  const wf = c.workflows['compare']!;
  assert.equal(wf.limits.max_revisions, 1);
});

// ────────────────────────── judge 解析器 ──────────────────────────

test('parseJudgeVerdict：合法/非 JSON/winner 越界/空 reason 全覆盖', () => {
  const ok1 = parseJudgeVerdict('{"winner":"model_a","reason":"more complete"}', ['model_a', 'model_b']);
  assert.ok(ok1.ok && ok1.value.winner === 'model_a');
  assert.ok(!parseJudgeVerdict('no json', ['a']).ok);
  assert.ok(!parseJudgeVerdict('{"winner":"ghost","reason":"x"}', ['a', 'b']).ok);
  assert.ok(!parseJudgeVerdict('{"winner":"a","reason":"  "}', ['a']).ok);
  // 代码围栏包裹的 JSON 也要能解
  const fenced = parseJudgeVerdict('```json\n{"winner":"b","reason":"r"}\n```', ['a', 'b']);
  assert.ok(fenced.ok && fenced.value.winner === 'b');
});

// ────────────────────────── 一致性信号 ──────────────────────────

test('answerAgreement：相同=1 / 不可比=0 / 少于 2 份=undefined', () => {
  assert.equal(answerAgreement(['hello world foo', 'hello world foo']), 1);
  assert.equal(answerAgreement(['alpha beta', 'gamma delta']), 0);
  assert.equal(answerAgreement(['only one']), undefined);
  assert.equal(answerAgreement([]), undefined);
  // 中文按二元组：相同文本相似度 1
  assert.equal(answerAgreement(['今天天气很好', '今天天气很好']), 1);
  const partial = answerAgreement(['the cat sat', 'the cat ran']);
  assert.ok(partial !== undefined && partial > 0 && partial < 1, `partial=${partial}`);
  // tokenSet：拉丁词 + CJK 二元组
  const ts = tokenSet('你好世界 hello');
  assert.ok(ts.has('hello') && ts.has('你好') && ts.has('好世') && ts.has('世界'));
});

// ────────────────────────── parallel + judge ──────────────────────────

test('parallel+judge：评委选优成功 → finalOutput=胜者内容 + judgeSummary + agreement + candidates', async () => {
  const c = judgeConfig();
  const judgeBody = '{"winner":"model_b","reason":"model_b covers edge cases model_a misses"}';
  const adapters = new Map<string, ProviderAdapter>([['m', new JudgeAdapter('m', judgeBody)]]);
  const orch = new WorkflowOrchestrator(c, adapters);
  const r = await orch.run({ workflowId: 'compare', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.ok(res.judgeSummary, 'judgeSummary 应存在');
    assert.equal(res.judgeSummary!.winnerStep, 'model_b');
    assert.equal(res.judgeSummary!.reason, 'model_b covers edge cases model_a misses');
    // finalOutput 是胜者内容（不再是拼接对比）
    assert.ok(!res.finalOutput?.includes('---'), 'finalOutput 不应再是拼接对比');
    const judgeStep = res.steps.find((s) => s.stepName === 'judge');
    assert.equal(judgeStep?.status, 'succeeded');
    assert.match(judgeStep?.checks[0]?.detail ?? '', /winner=model_b/);
    assert.ok(res.agreement !== undefined && res.agreement >= 0 && res.agreement <= 1);
    // 0.12.1：评委选优时附全部候选（可核对评委裁决）
    assert.ok(res.candidates && res.candidates.length === 2, 'candidates 应含两份候选');
    assert.ok(res.candidates!.some((c) => c.stepName === 'model_b'));
    assert.ok(res.warnings.some((w) => w.includes('judge selected "model_b"')));
  }
});

test('parallel+judge：评委输出非法 → 降级拼接对比 + warning + 失败步骤透明记录', async () => {
  const c = judgeConfig();
  const badJudge = new JudgeAdapter('m', 'I think model_b is better (no JSON)');
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', badJudge]]));
  const r = await orch.run({ workflowId: 'compare', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.ok(!res.judgeSummary, '非法评委不应产生 judgeSummary');
    assert.ok(res.finalOutput?.includes('---'), '降级为拼接对比');
    assert.ok(res.warnings.some((w) => w.includes('falling back')));
    assert.equal(res.steps.find((s) => s.stepName === 'judge')?.status, 'failed');
    assert.ok(!res.candidates, '评委失败时不附 candidates');
  }
});

test('parallel 无 judge：agreement 仍报告（零调用信号）', async () => {
  const c = configSchema.parse({
    version: 1,
    providers: baseProviders(),
    workflows: {
      compare: {
        strategy: 'parallel',
        limits: { max_steps: 3, total_timeout_ms: 10000, max_output_tokens: 1000, allow_unknown_price: true },
        steps: [
          { name: 'model_a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
          { name: 'model_b', provider: 'm', model: 'mock-review-accept', input: 'original', timeout_ms: 3000, evaluate: ['non_empty'] },
        ],
      },
    },
  });
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', new MockProvider('m')]]));
  const r = await orch.run({ workflowId: 'compare', input: 'x' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.agreement !== undefined);
    assert.ok(r.value.judgeSummary === undefined);
  }
});

test('parallel：per-run max_chars 收紧覆盖生效（0.12.1 修复——此前仅 waterfall 应用）', async () => {
  const c = configSchema.parse({
    version: 1,
    providers: baseProviders(),
    workflows: {
      compare: {
        strategy: 'parallel',
        limits: { max_steps: 3, total_timeout_ms: 10000, max_output_tokens: 1000, allow_unknown_price: true },
        steps: [
          // mock-success 输出约 60 字；配置阈值 10000，靠 override 收紧到 10 才会拦
          { name: 'model_a', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 3000, evaluate: ['non_empty', { max_chars: 10000 }] },
        ],
      },
    },
  });
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', new MockProvider('m')]]));
  const r = await orch.run(
    { workflowId: 'compare', input: 'x', userOverrides: { maxChars: 10 } },
    { signal: new AbortController().signal },
  );
  assert.ok(r.ok);
  if (r.ok) {
    // mock-success 输出远超 10 字 → 收紧后该步检查失败
    assert.equal(r.value.steps[0]?.status, 'failed');
    assert.ok(r.value.steps[0]?.checks.some((ck) => ck.checkId === 'max_chars' && !ck.passed));
    assert.ok(r.value.finalOutput === undefined);
  }
});

// ────────────────────────── waterfall 修订循环 ──────────────────────────

test('修订循环：第 2 轮评审 accept → 收敛完成，评审执行 2 次', async () => {
  const c = waterfallCfg({}, { max_revisions: 2 });
  const flip = new FlipReviewAdapter('m', new MockProvider('m'));
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', flip]]));
  const r = await orch.run({ workflowId: 'rtr', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.equal(res.stopReason, 'completed');
    assert.equal(res.reviewSummary?.verdict, 'accept');
    const reviews = res.steps.filter((s) => s.stepName === 'review');
    const revises = res.steps.filter((s) => s.stepName === 'revise' && s.status === 'succeeded');
    assert.equal(reviews.length, 2, '评审应执行两轮');
    assert.equal(revises.length, 1, '修订执行一次后第二轮评审通过');
    assert.ok(res.warnings.some((w) => w.includes('revision loop')));
  }
});

test('修订循环：永远 revise → 次数用尽后交付最后一次修订 + 如实警告', async () => {
  const c = waterfallCfg({}, { max_revisions: 2 });
  const always = new AlwaysReviseAdapter('m', new MockProvider('m'));
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', always]]));
  const r = await orch.run({ workflowId: 'rtr', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    assert.equal(res.reviewSummary?.verdict, 'revise');
    const revises = res.steps.filter((s) => s.stepName === 'revise' && s.status === 'succeeded');
    assert.equal(revises.length, 2, '修订恰好执行 max_revisions 次');
    assert.ok(res.warnings.some((w) => w.includes('max_revisions=2 reached')));
  }
});

test('修订循环：默认 max_revisions=1 → 与旧行为一致（单次修订，无循环）', async () => {
  const c = waterfallCfg({}, {});
  const always = new AlwaysReviseAdapter('m', new MockProvider('m'));
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', always]]));
  const r = await orch.run({ workflowId: 'rtr', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    const reviews = res.steps.filter((s) => s.stepName === 'review');
    const revises = res.steps.filter((s) => s.stepName === 'revise' && s.status === 'succeeded');
    assert.equal(reviews.length, 1);
    assert.equal(revises.length, 1);
    assert.equal(res.stopReason, 'completed');
    // 默认单次不打 max_revisions 噪音警告
    assert.ok(!res.warnings.some((w) => w.includes('max_revisions=1 reached')));
  }
});

test('升级（escalate_to）：循环用尽仍 revise → 换模型最后一次修订并标注', async () => {
  const c = waterfallCfg({ escalate_to: { provider: 'm', model: 'mock-review-accept' } }, { max_revisions: 1 });
  const always = new AlwaysReviseAdapter('m', new MockProvider('m'));
  const orch = new WorkflowOrchestrator(c, new Map<string, ProviderAdapter>([['m', always]]));
  const r = await orch.run({ workflowId: 'rtr', input: '任务' }, { signal: new AbortController().signal });
  assert.ok(r.ok);
  if (r.ok) {
    const res = r.value;
    assert.equal(res.status, 'succeeded');
    const esc = res.steps.find((s) => s.stepName === 'escalate');
    assert.equal(esc?.status, 'succeeded');
    assert.equal(esc?.modelId, 'mock-review-accept');
    assert.ok(res.warnings.some((w) => w.includes('escalated final revision')));
    assert.ok(res.finalOutput);
  }
});
