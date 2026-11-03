import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../../src/config/schema.js';
import { loadConfig } from '../../src/config/loader.js';

type ParseResult = ReturnType<typeof configSchema.safeParse>;

function expectIssues(result: ParseResult): Array<{ path: string; message: string }> {
  assert.equal(result.success, false, 'expected config to be invalid');
  if (result.success) throw new Error('unreachable');
  return result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function expectValid(result: ParseResult): void {
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

function validWorkflow(): any {
  return {
    strategy: 'waterfall',
    limits: {
      max_steps: 3,
      total_timeout_ms: 90000,
      max_output_tokens: 5000,
      max_cost_usd: 0.05,
      allow_unknown_price: false,
      max_retries_per_step: 1,
    },
    steps: [
      { name: 'draft', provider: 'mockmain', model: 'mock-success', input: 'original', timeout_ms: 30000, evaluate: ['non_empty'] },
      { name: 'review', provider: 'mockmain', model: 'mock-review-accept', input: 'review_template', timeout_ms: 30000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] },
      { name: 'revise', provider: 'mockmain', model: 'mock-success', input: 'revision_template', timeout_ms: 30000, run_if: 'review_verdict_is_revise' },
    ],
  };
}

function baseValid(): any {
  return {
    version: 1,
    providers: {
      mockmain: { kind: 'mock', models: [{ id: 'mock-success' }, { id: 'mock-review-accept' }] },
    },
    workflows: { w1: validWorkflow() },
  };
}

test('examples/config.example.yaml 通过校验', () => {
  const examplePath = fileURLToPath(new URL('../../../examples/config.example.yaml', import.meta.url));
  const loaded = loadConfig(examplePath);
  assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
});

test('合法最小配置通过校验', () => {
  expectValid(configSchema.safeParse(baseValid()));
});

test('版本号不符给出可读错误', () => {
  const cfg = baseValid();
  cfg.version = 2;
  const issues = expectIssues(configSchema.safeParse(cfg));
  const v = issues.find((i) => i.path === 'version');
  assert.ok(v);
  assert.match(v.message, /unsupported config version/);
});

test('http base_url 默认拒绝', () => {
  const cfg = baseValid();
  cfg.providers['remote1'] = { kind: 'openai-compatible', base_url: 'http://api.example/v1', api_key_ref: 'env:EXAMPLE_KEY', models: [{ id: 'm1' }] };
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'providers.remote1.base_url'));
});

test('本地私有主机默认拒绝，显式 opt-in 后放行', () => {
  const cfg = baseValid();
  cfg.providers['remote1'] = { kind: 'openai-compatible', base_url: 'http://127.0.0.1:11434/v1', api_key_ref: 'env:EXAMPLE_KEY', models: [{ id: 'm1' }] };
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'providers.remote1.base_url'));

  const cfg2 = baseValid();
  cfg2.providers['remote1'] = { kind: 'openai-compatible', base_url: 'http://127.0.0.1:11434/v1', api_key_ref: 'env:EXAMPLE_KEY', allow_insecure_base_url: true, models: [{ id: 'm1' }] };
  expectValid(configSchema.safeParse(cfg2));
});

test('步骤引用未配置的 provider / model 可定位到字段', () => {
  const cfg = baseValid();
  cfg.workflows['w1'].steps[0].provider = 'ghost';
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'workflows.w1.steps.0.provider' && /unknown provider/.test(i.message)));

  const cfg2 = baseValid();
  cfg2.workflows['w1'].steps[0].model = 'ghost-model';
  assert.ok(expectIssues(configSchema.safeParse(cfg2)).some((i) => i.path === 'workflows.w1.steps.0.model'));
});

test('steps 数超过 max_steps 报错', () => {
  const cfg = baseValid();
  cfg.workflows['w1'].limits.max_steps = 2;
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'workflows.w1.steps'));
});

test('首步不允许 run_if；后续步骤必须显式 run_if', () => {
  const cfg = baseValid();
  cfg.workflows['w1'].steps[0].run_if = 'always';
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'workflows.w1.steps.0.run_if'));

  const cfg2 = baseValid();
  delete cfg2.workflows['w1'].steps[1].run_if;
  assert.ok(expectIssues(configSchema.safeParse(cfg2)).some((i) => i.path === 'workflows.w1.steps.1.run_if'));
});

test('首步 input 必须为 original', () => {
  const cfg = baseValid();
  cfg.workflows['w1'].steps[0].input = 'review_template';
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'workflows.w1.steps.0.input'));
});

test('structured_review 门约束：review_template + review_schema 含 verdict', () => {
  const cfg = baseValid();
  delete cfg.workflows['w1'].steps[1].review_schema;
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'workflows.w1.steps.1.review_schema'));

  const cfg2 = baseValid();
  cfg2.workflows['w1'].steps[1].review_schema = ['reasons'];
  assert.ok(expectIssues(configSchema.safeParse(cfg2)).some((i) => i.path === 'workflows.w1.steps.1.review_schema'));

  const cfg3 = baseValid();
  cfg3.workflows['w1'].steps[1].input = 'original';
  assert.ok(expectIssues(configSchema.safeParse(cfg3)).some((i) => i.path === 'workflows.w1.steps.1.input'));
});

test('review_verdict_is_revise 需要更早的评审门', () => {
  const cfg = baseValid();
  delete cfg.workflows['w1'].steps[1].gate;
  delete cfg.workflows['w1'].steps[1].review_schema;
  cfg.workflows['w1'].steps[1].input = 'original';
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'workflows.w1.steps.2.run_if'));
});

test('步骤超时不得超过整体超时', () => {
  const cfg = baseValid();
  cfg.workflows['w1'].steps[0].timeout_ms = 95000;
  assert.ok(expectIssues(configSchema.safeParse(cfg)).some((i) => i.path === 'workflows.w1.steps.0.timeout_ms'));
});

test('YAML 解析失败返回 parse_failed', () => {
  const tmp = join(tmpdir(), `bayze-unit-${process.pid}-bad.yaml`);
  writeFileSync(tmp, 'providers: [unclosed', 'utf8');
  try {
    const loaded = loadConfig(tmp);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.equal(loaded.error.kind, 'parse_failed');
  } finally {
    rmSync(tmp);
  }
});

test('配置文件不存在返回 not_found', () => {
  const loaded = loadConfig(join(tmpdir(), 'bayze-unit-definitely-missing.yaml'));
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.error.kind, 'not_found');
});
