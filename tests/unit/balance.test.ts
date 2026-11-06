import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBalanceResponse, formatBalanceLines } from '../../src/application/balance.js';

test('balance：200 + balance 字段 → 解析余额/套餐桶', () => {
  const r = parseBalanceResponse(200, { balance: 1234.5, allowance: 200, allowance_expires_at: '2026-12-01T00:00:00Z' });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.info.balance, 1234.5);
    assert.equal(r.info.allowance, 200);
    assert.equal(r.info.allowanceExpiresAt, '2026-12-01T00:00:00Z');
  }
});

test('balance：200 + points_balance 别名 / 无套餐 → null', () => {
  const r = parseBalanceResponse(200, { points_balance: 88 });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.info.balance, 88);
    assert.equal(r.info.allowance, null);
    assert.equal(r.info.allowanceExpiresAt, null);
  }
});

test('balance：200 但缺余额字段 → unexpected（fail-closed，不猜数字）', () => {
  const r = parseBalanceResponse(200, { foo: 1 });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.code, 'unexpected');
});

test('balance：401 → invalid_key；404 → endpoint_unavailable', () => {
  assert.equal(parseBalanceResponse(401, { error: 'bad key' }).ok ? '' : 'x', 'x');
  const a = parseBalanceResponse(401, { error: { message: 'Missing API key' } });
  assert.ok(!a.ok && a.code === 'invalid_key');
  const b = parseBalanceResponse(404, { error: 'Not Found' });
  assert.ok(!b.ok && b.code === 'endpoint_unavailable');
});

test('balance：非 200/401/404 → unexpected', () => {
  const r = parseBalanceResponse(500, { error: 'boom' });
  assert.ok(!r.ok && r.code === 'unexpected');
});

test('balance：成功展示行含充值直链', () => {
  const lines = formatBalanceLines({ ok: true, info: { balance: 42, allowance: null, allowanceExpiresAt: null } }, 'env:BAYZE_API_KEY');
  assert.ok(lines.some((l) => l.includes('42 points')));
  assert.ok(lines.some((l) => l.includes('https://app.lanwealth.com/dashboard/billing')));
});

test('balance：端点未上线降级文案 → 指向控制台钱包', () => {
  const lines = formatBalanceLines({ ok: false, code: 'endpoint_unavailable', message: '' }, 'env:BAYZE_API_KEY');
  assert.ok(lines.join('\n').includes('not available yet'));
  assert.ok(lines.join('\n').includes('dashboard/billing'));
});

test('balance：无效 key 文案含密钥引用与控制台', () => {
  const lines = formatBalanceLines({ ok: false, code: 'invalid_key', message: 'x' }, 'env:BAYZE_API_KEY');
  const joined = lines.join('\n');
  assert.ok(joined.includes('env:BAYZE_API_KEY'));
  assert.ok(joined.includes('dashboard/billing'));
});
