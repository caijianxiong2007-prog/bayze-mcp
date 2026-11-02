import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardRuntimeEnv } from '../../src/cli-guard.js';

test('NODE_TLS_REJECT_UNAUTHORIZED=0 → 返回拒绝原因（CLI main 据此以退出码 1 拒启）', () => {
  const saved = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  try {
    const problem = guardRuntimeEnv();
    assert.ok(problem !== null);
    assert.match(problem, /refusing to start/);
  } finally {
    if (saved === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = saved;
  }
});

test('正常环境 → 无问题', () => {
  const saved = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  try {
    assert.equal(guardRuntimeEnv(), null);
  } finally {
    if (saved !== undefined) process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = saved;
  }
});
