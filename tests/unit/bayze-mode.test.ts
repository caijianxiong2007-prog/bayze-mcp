import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, BAYZE_API_ALLOWED_HOSTS } from '../../src/config/schema.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

function baseWithProvider(provider: any): any {
  return {
    version: 1,
    providers: { mockmain: { kind: 'mock', models: [{ id: 'mock-success' }] }, ...provider },
    workflows: {
      w: {
        strategy: 'waterfall',
        limits: { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 100 },
        steps: [{ name: 'draft', provider: 'mockmain', model: 'mock-success', input: 'original', timeout_ms: 1000 }],
      },
    },
  };
}

const bayzeProvider = (over: Record<string, unknown> = {}): any => ({
  mode: 'bayze_api',
  kind: 'openai-compatible',
  base_url: 'https://app.lanwealth.com/v1',
  api_key_ref: 'env:BAYZE_API_KEY',
  models: [{ id: 'bayze-model' }],
  ...over,
});

function issues(result: ReturnType<typeof configSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

test('mode 默认 byok（向后兼容，无迁移）', () => {
  const parsed = configSchema.parse(baseWithProvider({ remote: { kind: 'openai-compatible', base_url: 'https://api.example/v1', api_key_ref: 'env:X_KEY', models: [{ id: 'm1' }] } }));
  assert.equal(parsed.providers['remote']?.kind, 'openai-compatible');
  if (parsed.providers['remote']?.kind === 'openai-compatible') {
    assert.equal(parsed.providers['remote'].mode, 'byok');
  }
});

test('bayze_api + 正确主机：通过校验', () => {
  const r = configSchema.safeParse(baseWithProvider({ bayze: bayzeProvider() }));
  assert.equal(r.success, true, JSON.stringify(issues(r)));
});

test('bayze_api + 错误主机：schema 定位到 base_url 并给出 allowlist 提示', () => {
  const r = configSchema.safeParse(baseWithProvider({ bayze: bayzeProvider({ base_url: 'https://api.other-host.com/v1' }) }));
  const list = issues(r);
  assert.ok(list.some((m) => m.startsWith('providers.bayze.base_url') && /allowlist/.test(m)), JSON.stringify(list));
});

test('bayze_api + anthropic kind：拒绝（协议不匹配）', () => {
  const r = configSchema.safeParse(baseWithProvider({ bayze: bayzeProvider({ kind: 'anthropic' }) }));
  const list = issues(r);
  assert.ok(list.some((m) => m.startsWith('providers.bayze.kind') && /openai-compatible/.test(m)), JSON.stringify(list));
});

test('bayze_api + 明文主机：同时触发 allowlist 与 insecure 校验', () => {
  const r = configSchema.safeParse(baseWithProvider({ bayze: bayzeProvider({ base_url: 'http://app.lanwealth.com/v1' }) }));
  const list = issues(r);
  assert.ok(list.some((m) => m.startsWith('providers.bayze.base_url')));
});

test('allowlist 常量导出且当前为 app.lanwealth.com', () => {
  assert.deepEqual([...BAYZE_API_ALLOWED_HOSTS], ['app.lanwealth.com']);
});
