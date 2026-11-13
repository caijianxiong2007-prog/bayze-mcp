import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync, writeFileSync } from 'node:fs';
import {
  PROVIDER_PRESETS,
  renderConfigYaml,
  renderDotEnv,
  renderCherryJson,
  loadDotEnv,
} from '../../src/config/init.js';
import { configSchema } from '../../src/config/schema.js';
import { parse as parseYaml } from 'yaml';

const answers = {
  providers: [
    { id: 'deepseek', apiKey: 'sk-test-1', envVar: 'BAYZE_DEEPSEEK_API_KEY', models: [], baseUrl: undefined },
    { id: 'dashscope', apiKey: 'sk-test-2', envVar: 'BAYZE_DASHSCOPE_API_KEY', models: [], baseUrl: undefined },
    { id: 'ark', apiKey: 'sk-test-3', envVar: 'BAYZE_ARK_API_KEY', models: [], baseUrl: undefined },
  ],
  defaultWorkflow: 'review_then_revise' as const,
  maxCostUsd: 0.15,
  targetDir: '/tmp/bayze-init-x',
};

test('init：renderConfigYaml 产出通过 configSchema 校验', () => {
  const yaml = renderConfigYaml(answers);
  const raw = parseYaml(yaml);
  const parsed = configSchema.safeParse(raw);
  assert.ok(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues));
  assert.equal(parsed.success && parsed.data.version, 1);
});

test('init：生成的工作流含 quick_answer + review_then_revise，引用全部所选供应商', () => {
  const yaml = renderConfigYaml(answers);
  assert.ok(yaml.includes('quick_answer'));
  assert.ok(yaml.includes('review_then_revise'));
  assert.ok(yaml.includes('deepseek:'));
  assert.ok(yaml.includes('dashscope:'));
  assert.ok(yaml.includes('ark:'));
  assert.ok(yaml.includes('env:BAYZE_DEEPSEEK_API_KEY'));
});

test('init：renderDotEnv 输出 KEY=VALUE 且与 env: 引用一一对应', () => {
  const env = renderDotEnv(answers);
  assert.ok(env.includes('BAYZE_DEEPSEEK_API_KEY=sk-test-1'));
  assert.ok(env.includes('BAYZE_DASHSCOPE_API_KEY=sk-test-2'));
  assert.ok(env.includes('BAYZE_ARK_API_KEY=sk-test-3'));
});

test('init：renderCherryJson 含 command/args/config 路径', () => {
  const j = renderCherryJson(answers);
  const parsed = JSON.parse(j);
  assert.equal(parsed.mcpServers.bayze.command, 'npx');
  assert.deepEqual(parsed.mcpServers.bayze.args, ['-y', 'bayze-mcp', 'mcp', '--config', '/tmp/bayze-init-x/config.yaml']);
});

test('init：loadDotEnv 注入 process.env 且不覆盖已有值', () => {
  const key = 'BAYZE_TEST_DOTENV_A';
  const saved = process.env[key];
  process.env[key] = 'pre-existing';
  const file = '/tmp/bayze-dotenv-test.env';
  writeFileSync(file, `${key}=should-not-overwrite\nBAYZE_TEST_DOTENV_NEW=fresh\n`, 'utf8');
  const n = loadDotEnv(file);
  assert.equal(n, 1, '只有新 key 被注入（已有的不覆盖）');
  assert.equal(process.env[key], 'pre-existing', '已有值不被覆盖');
  assert.equal(process.env['BAYZE_TEST_DOTENV_NEW'], 'fresh');
  rmSync(file);
  if (saved !== undefined) process.env[key] = saved;
  else delete process.env[key];
  delete process.env['BAYZE_TEST_DOTENV_NEW'];
});

test('init：PROVIDER_PRESETS 覆盖六大主流供应商且 URL 均为 https', () => {
  for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
    assert.ok(id.length > 0);
    assert.ok(p.baseUrl.startsWith('https://'), `${id} base_url must be https`);
    assert.ok(p.signupUrl.startsWith('https://'));
    assert.ok(p.models.length >= 1);
  }
});
