import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import { workflowsSummary } from '../../src/transport/mcp/server.js';
import type { BayzeConfig } from '../../src/config/schema.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

function cfgWithProfile(profile?: any): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: { m: { kind: 'mock', models: [{ id: 'x' }] } },
    workflows: {
      w: {
        strategy: 'waterfall',
        ...(profile ? { profile } : {}),
        limits: { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 100 },
        steps: [{ name: 's', provider: 'm', model: 'x', input: 'original', timeout_ms: 1000 }],
      },
    },
  });
}

test('带 profile 的工作流通过校验', () => {
  const c = cfgWithProfile({ category: 'translation', quality_tier: 'fast', description: '快速翻译' });
  const wf = c.workflows['w'];
  assert.ok(wf?.profile);
  assert.equal(wf.profile.category, 'translation');
  assert.equal(wf.profile.quality_tier, 'fast');
});

test('无 profile 的工作流兼容（可选字段）', () => {
  const c = cfgWithProfile();
  assert.equal(c.workflows['w']?.profile, undefined);
});

test('profile 非法 quality_tier 被拒绝', () => {
  assert.throws(() => cfgWithProfile({ category: 'x', quality_tier: 'ultra' }));
});

test('profile 未知字段被拒绝（strict）', () => {
  assert.throws(() => cfgWithProfile({ category: 'x', quality_tier: 'fast', evil: true }));
});

test('workflowsSummary 携带 profile（供 AI 客户端选择）', () => {
  const c = cfgWithProfile({ category: 'coding', quality_tier: 'high', description: '代码复核' });
  const summary = workflowsSummary(c) as Array<{ id: string; profile?: { category: string; quality_tier: string } }>;
  assert.equal(summary[0]?.profile?.category, 'coding');
  assert.equal(summary[0]?.profile?.quality_tier, 'high');
});

test('workflowsSummary 无 profile 时不携带空对象', () => {
  const c = cfgWithProfile();
  const summary = workflowsSummary(c) as Array<{ id: string; profile?: unknown }>;
  assert.equal(summary[0]?.profile, undefined);
});

/* ── v1.4.1 自然语言触发：无 profile 时按策略推导 usageHint ── */

function cfgWithWorkflow(wf: Record<string, unknown>): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: { m: { kind: 'mock', models: [{ id: 'x' }] } },
    workflows: { w: wf },
  });
}

const baseLimits = { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 100 };
const step = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 's',
  provider: 'm',
  model: 'x',
  input: 'original',
  timeout_ms: 1000,
  ...over,
});

test('单步 waterfall 推导 Single-step 提示', () => {
  const c = cfgWithWorkflow({ strategy: 'waterfall', limits: baseLimits, steps: [step()] });
  const summary = workflowsSummary(c) as Array<{ usageHint?: string }>;
  assert.match(summary[0]?.usageHint ?? '', /Single-step/);
});

test('带评审门的 waterfall 推导 cross-check 提示', () => {
  const c = cfgWithWorkflow({
    strategy: 'waterfall',
    limits: { ...baseLimits, max_steps: 3 },
    steps: [
      step({ name: 'draft' }),
      step({ name: 'review', input: 'review_template', run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] }),
      step({ name: 'revise', run_if: 'review_verdict_is_revise' }),
    ],
  });
  const summary = workflowsSummary(c) as Array<{ usageHint?: string }>;
  assert.match(summary[0]?.usageHint ?? '', /cross-check or second opinion/);
});

test('带 escalate_to 的 waterfall 推导升级提示', () => {
  const c = cfgWithWorkflow({
    strategy: 'waterfall',
    limits: baseLimits,
    steps: [step()],
    escalate_to: { provider: 'm', model: 'x' },
  });
  const summary = workflowsSummary(c) as Array<{ usageHint?: string }>;
  assert.match(summary[0]?.usageHint ?? '', /escalates to a stronger model/);
});

test('parallel + judge 推导选优提示', () => {
  const c = cfgWithWorkflow({
    strategy: 'parallel',
    judge: { provider: 'm', model: 'x' },
    limits: { ...baseLimits, max_steps: 2 },
    steps: [step(), step({ name: 's2' })],
  });
  const summary = workflowsSummary(c) as Array<{ usageHint?: string }>;
  assert.match(summary[0]?.usageHint ?? '', /judge model picks the winner/);
});

test('无 judge 的 parallel 推导对比提示', () => {
  const c = cfgWithWorkflow({
    strategy: 'parallel',
    limits: { ...baseLimits, max_steps: 2 },
    steps: [step(), step({ name: 's2' })],
  });
  const summary = workflowsSummary(c) as Array<{ usageHint?: string }>;
  assert.match(summary[0]?.usageHint ?? '', /compare competing answers/);
});

test('moa 推导聚合提示', () => {
  const c = cfgWithWorkflow({
    strategy: 'moa',
    aggregate: { provider: 'm', model: 'x' },
    limits: { ...baseLimits, max_steps: 2 },
    steps: [step(), step({ name: 's2' })],
  });
  const summary = workflowsSummary(c) as Array<{ usageHint?: string }>;
  assert.match(summary[0]?.usageHint ?? '', /synthesizer merges/);
});

test('debate 推导裁决提示', () => {
  const c = cfgWithWorkflow({
    strategy: 'debate',
    judge: { provider: 'm', model: 'x' },
    rounds: 1,
    limits: { ...baseLimits, max_steps: 2 },
    steps: [step(), step({ name: 's2' })],
  });
  const summary = workflowsSummary(c) as Array<{ usageHint?: string }>;
  assert.match(summary[0]?.usageHint ?? '', /arbiter judges/);
});

test('有 profile 时不含 usageHint（互斥）', () => {
  const c = cfgWithProfile({ category: 'coding', quality_tier: 'high', description: '代码复核' });
  const summary = workflowsSummary(c) as Array<{ usageHint?: string }>;
  assert.equal(summary[0]?.usageHint, undefined);
});
