import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDeterministicChecks } from '../../src/domain/evaluation/checks.js';
import { parseReview } from '../../src/domain/evaluation/review.js';

test('non_empty 通过/失败', () => {
  const pass = runDeterministicChecks('content', ['non_empty']);
  assert.equal(pass[0]?.passed, true);
  const fail = runDeterministicChecks('   \n ', ['non_empty']);
  assert.equal(fail[0]?.passed, false);
  assert.ok((fail[0]?.detail ?? '').includes('empty'));
});

test('max_chars 通过/失败并给出实际长度', () => {
  assert.equal(runDeterministicChecks('abc', [{ max_chars: 5 }])[0]?.passed, true);
  const fail = runDeterministicChecks('abcdefgh', [{ max_chars: 5 }])[0];
  assert.equal(fail?.passed, false);
  assert.ok((fail?.detail ?? '').includes('8'));
});

test('parseReview：直接 JSON / 围栏 JSON / 散文包裹', () => {
  for (const content of [
    '{"verdict":"accept","reasons":["ok"]}',
    '```json\n{"verdict":"accept","reasons":["ok"]}\n```',
    'Here is my review:\n{"verdict":"revise","reasons":["needs work"]}\nthanks',
  ]) {
    const r = parseReview(content, ['verdict', 'reasons']);
    assert.ok(r.ok, content);
  }
});

test('parseReview：无 JSON → unparseable（fail-closed）', () => {
  const r = parseReview('I think the draft is fine.', ['verdict', 'reasons']);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'unparseable');
});

test('parseReview：verdict 非法 → invalid_verdict', () => {
  const r = parseReview('{"verdict":"maybe","reasons":[]}', ['verdict', 'reasons']);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'invalid_verdict');
});

test('parseReview：schema 要求 reasons 时缺失/类型不符 → invalid_reasons', () => {
  const missing = parseReview('{"verdict":"accept"}', ['verdict', 'reasons']);
  assert.ok(!missing.ok);
  if (!missing.ok) assert.equal(missing.error.code, 'invalid_reasons');

  const wrongType = parseReview('{"verdict":"accept","reasons":"good"}', ['verdict', 'reasons']);
  assert.ok(!wrongType.ok);

  const notStrings = parseReview('{"verdict":"accept","reasons":[1,2]}', ['verdict', 'reasons']);
  assert.ok(!notStrings.ok);
});

test('parseReview：schema 未要求 reasons 时可缺省', () => {
  const r = parseReview('{"verdict":"accept"}', ['verdict']);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.reasons, []);
});
