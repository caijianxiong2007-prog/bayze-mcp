import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CredentialStore } from '../../src/credentials/store.js';

const store = new CredentialStore();

test('解析已设置的环境变量', () => {
  process.env['BAYZE_UNIT_TEST_KEY'] = 'unit-test-value';
  try {
    const r = store.resolve('env:BAYZE_UNIT_TEST_KEY');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 'unit-test-value');
  } finally {
    delete process.env['BAYZE_UNIT_TEST_KEY'];
  }
});

test('缺失的环境变量：报变量名，不含值', () => {
  delete process.env['BAYZE_UNIT_MISSING_KEY'];
  const r = store.resolve('env:BAYZE_UNIT_MISSING_KEY');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'missing_env');
    if (r.error.code === 'missing_env') {
      assert.equal(r.error.envName, 'BAYZE_UNIT_MISSING_KEY');
      assert.match(r.error.message, /BAYZE_UNIT_MISSING_KEY/);
    }
  }
});

test('非法引用格式：invalid_ref，且错误文本不含输入值', () => {
  const r = store.resolve('raw-secret-value');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'invalid_ref');
    assert.ok(!JSON.stringify(r.error).includes('raw-secret-value'));
  }
});
