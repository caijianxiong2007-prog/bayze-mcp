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
