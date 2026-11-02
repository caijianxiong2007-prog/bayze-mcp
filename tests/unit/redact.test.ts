import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactProviderErrorBody, redactText } from '../../src/logging/redact.js';

test('Authorization 头整体脱敏（含 Bearer 令牌）', () => {
  assert.equal(redactText('Authorization: Bearer abcdef123456'), 'authorization=[REDACTED]');
});

test('正文中的 Bearer 令牌脱敏', () => {
  const out = redactText('header was Bearer sk-abcdef123456789');
  assert.ok(!out.includes('sk-abcdef123456789'));
  assert.ok(out.includes('[REDACTED]'));
});

test('key 形态（sk- 前缀）脱敏', () => {
  const out = redactText('key sk-abcdefgh12345678 expired');
  assert.ok(!out.includes('sk-abcdefgh12345678'));
});

test('供应商错误体：脱敏并截断（基线 §12 伪密钥注入场景）', () => {
  const body = {
    error: {
      message: 'invalid api_key Authorization: Bearer secrettoken123',
      extra: 'x'.repeat(5000),
    },
  };
  const out = redactProviderErrorBody(body);
  assert.ok(!out.includes('secrettoken123'));
  assert.ok(out.length <= 2048);
});
