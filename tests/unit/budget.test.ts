import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetGuard } from '../../src/application/workflows/budget.js';
import type { PriceInfo } from '../../src/application/workflows/budget.js';

const book = (p: string, _m: string): PriceInfo | undefined =>
  p === 'priced' ? { inputPer1m: 1, outputPer1m: 2 } : undefined;

test('estimate：已知定价按输入折算 token + 最坏输出预估', () => {
  const g = new BudgetGuard(undefined, false, book);
  // 4000 chars → 1000 input tokens；500 output tokens 上限
  assert.equal(g.estimateCostUsd(4000, 500, 'priced', 'm'), (1000 / 1e6) * 1 + (500 / 1e6) * 2);
  assert.equal(g.estimateCostUsd(4000, 500, 'unknown', 'm'), undefined);
});

test('reserve：已结算 + 预留 + 预估达到硬上限 → budget_exceeded', () => {
  const g = new BudgetGuard(0.001, false, book);
  const r = g.reserve(0.002, 'priced', 'm');
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'budget_exceeded');
});

test('reserve：未知价格 + 硬上限 → 默认 fail-closed，显式放行才通过', () => {
  const closed = new BudgetGuard(1, false, book);
  const denied = closed.reserve(undefined, 'unknown', 'm');
  assert.ok(!denied.ok);
  if (!denied.ok) assert.equal(denied.error.code, 'price_unknown');

  const open = new BudgetGuard(1, true, book);
  const allowed = open.reserve(undefined, 'unknown', 'm');
  assert.ok(allowed.ok);
  if (allowed.ok) assert.equal(allowed.value, 0);
});

test('settle：有 usage 按实际结算；无 usage 按保守预估占用', () => {
  const g = new BudgetGuard(1, false, book);
  const r1 = g.reserve(0.5, 'priced', 'm');
  assert.ok(r1.ok);
  const actual = g.settle(r1.ok ? r1.value : 0, { inputTokens: 1000, outputTokens: 500 }, 'priced', 'm', 4000, 500);
  assert.equal(actual, (1000 / 1e6) * 1 + (500 / 1e6) * 2);
  assert.equal(g.spent, actual);

  const r2 = g.reserve(0.3, 'priced', 'm');
  assert.ok(r2.ok);
  const conservative = g.settle(r2.ok ? r2.value : 0, undefined, 'priced', 'm', 4000, 500);
  assert.equal(conservative, 0.3);
  assert.equal(g.spent, actual + 0.3);
});

test('release：失败调用释放预留且不计费用', () => {
  const g = new BudgetGuard(1, false, book);
  const r = g.reserve(0.4, 'priced', 'm');
  assert.ok(r.ok);
  g.release(r.ok ? r.value : 0);
  assert.equal(g.reserved, 0);
  assert.equal(g.spent, 0);
});

test('settle：价格未知返回 undefined（费用不可估算）', () => {
  const g = new BudgetGuard(undefined, true, book);
  const cost = g.settle(0, { inputTokens: 10, outputTokens: 10 }, 'unknown', 'm', 100, 100);
  assert.equal(cost, undefined);
});
