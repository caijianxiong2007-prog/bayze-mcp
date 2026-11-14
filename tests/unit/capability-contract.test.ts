import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { WorkflowOrchestrator } from '../../src/application/workflows/orchestrator.js';
import { MockProvider } from '../../src/providers/mock/provider.js';
import type { ProviderAdapter } from '../../src/providers/types.js';

/* v1.3.0 能力契约测试：setup 匹配（unsupported 拒启 / unverified 警告 / strict 拒启 / verified 放行） */

function cfgWithCapability(cap: unknown, strict = false): BayzeConfig {
  return configSchema.parse({
    version: 1,
    providers: {
      m: {
        kind: 'mock',
        models: [
          { id: 'mock-success' },
          {
            id: 'mock-review-accept',
            ...(cap !== undefined ? { capabilities: { json_verdict: cap } } : {}),
          },
        ],
      },
    },
    workflows: {
      rtr: {
        strategy: 'waterfall',
        limits: {
          max_steps: 3,
          total_timeout_ms: 5000,
          max_output_tokens: 500,
          max_revisions: 1,
          ...(strict ? { strict_capabilities: true } : {}),
        },
        steps: [
          { name: 'draft', provider: 'm', model: 'mock-success', input: 'original', timeout_ms: 1000, evaluate: ['non_empty'] },
          { name: 'review', provider: 'm', model: 'mock-review-accept', input: 'review_template', timeout_ms: 1000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] },
          { name: 'revise', provider: 'm', model: 'mock-success', input: 'revision_template', timeout_ms: 1000, run_if: 'review_verdict_is_revise' },
        ],
      },
    },
  });
}

import type { Result } from '../../src/domain/errors.js';
import type { RunSetupError } from '../../src/application/workflows/orchestrator.js';
import type { RunResult } from '../../src/domain/types.js';

function runCfg(c: BayzeConfig): Promise<Result<RunResult, RunSetupError>> {
  const orch = new WorkflowOrchestrator(c, new Map([['m', new MockProvider('m')]]));
  return orch.run({ workflowId: 'rtr', input: 'hello' }, { signal: new AbortController().signal });
}

test('契约 schema：json_verdict 接受 verified/unsupported，拒绝其他值', () => {
  const base = {
    version: 1,
    providers: { m: { kind: 'mock', models: [{ id: 'x', capabilities: { json_verdict: 'verified' } }] } },
    workflows: { w: { strategy: 'waterfall', limits: { max_steps: 1, total_timeout_ms: 1000, max_output_tokens: 100 }, steps: [{ name: 'a', provider: 'm', model: 'x', input: 'original', timeout_ms: 500 }] } },
  };
  assert.ok(configSchema.safeParse(base).success);
  assert.ok(!configSchema.safeParse({ ...base, providers: { m: { kind: 'mock', models: [{ id: 'x', capabilities: { json_verdict: 'guessed' } }] } } }).success);
  assert.ok(configSchema.safeParse({ ...base, providers: { m: { kind: 'mock', models: [{ id: 'x' }] } } }).success, '缺省=未验证，合法');
});

test('setup 匹配：unsupported → 拒绝启动（不付费失败）', async () => {
  const c = cfgWithCapability('unsupported');
  const r = await runCfg(c);
  assert.ok(!r.ok, '应返回 setup error');
  if (!r.ok) assert.match(r.error.message, /declared "unsupported"/);
});

test('setup 匹配：unverified/缺省 → 警告放行（向后兼容）', async () => {
  const c = cfgWithCapability(undefined);
  const r = await runCfg(c);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.stopReason, 'completed');
    assert.ok(r.value.warnings.some((w) => w.includes('json_verdict is unverified')), JSON.stringify(r.value.warnings));
  }
});

test('setup 匹配：strict_capabilities=true → 未验证也拒绝启动（用户显式选择）', async () => {
  const c = cfgWithCapability(undefined, true);
  const r = await runCfg(c);
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.error.message, /unverified/);
});

test('setup 匹配：verified → 无能力警告，正常执行', async () => {
  const c = cfgWithCapability('verified');
  const r = await runCfg(c);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.stopReason, 'completed');
    assert.ok(!r.value.warnings.some((w: string) => w.includes('json_verdict')), JSON.stringify(r.value.warnings));
  }
});
