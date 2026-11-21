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

test('parseReview：schema 要求 reasons 时缺失/类型不符/空数组 → invalid_reasons（fail-closed）', () => {
  const missing = parseReview('{"verdict":"accept"}', ['verdict', 'reasons']);
  assert.ok(!missing.ok);
  if (!missing.ok) assert.equal(missing.error.code, 'invalid_reasons');

  const wrongType = parseReview('{"verdict":"accept","reasons":"good"}', ['verdict', 'reasons']);
  assert.ok(!wrongType.ok);

  const notStrings = parseReview('{"verdict":"accept","reasons":[1,2]}', ['verdict', 'reasons']);
  assert.ok(!notStrings.ok);

  // dogfood 发现：空数组（橡皮图章）也必须拒绝
  const emptyReasons = parseReview('{"verdict":"accept","reasons":[]}', ['verdict', 'reasons']);
  assert.ok(!emptyReasons.ok);
  if (!emptyReasons.ok) assert.equal(emptyReasons.error.code, 'invalid_reasons');
});

/* ── v1.4.2 claims_checked：逐条 claim 核查清单 ── */

test('parseReview：claims_checked 对象/字符串混合解析（字符串补 unspecified）', () => {
  const r = parseReview(
    JSON.stringify({
      verdict: 'accept',
      reasons: ['ok'],
      claims_checked: [
        { claim: 'claim A', source: 'draft' },
        'claim B',
        { claim: ' claim C ', source: ' NOT_FOUND ' },
      ],
    }),
    ['verdict', 'reasons', 'claims_checked'],
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.value.claimsChecked, [
      { claim: 'claim A', source: 'draft' },
      { claim: 'claim B', source: 'unspecified' },
      { claim: 'claim C', source: 'NOT_FOUND' },
    ]);
  }
});

test('parseReview：claims_checked 缺失不 fail（避免为过闸编造清单）', () => {
  const r = parseReview('{"verdict":"accept","reasons":["ok"]}', ['verdict', 'reasons', 'claims_checked']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.claimsChecked, undefined);
});

test('parseReview：claims_checked 空数组 → 空清单（显式声明无可核查断言）', () => {
  const r = parseReview('{"verdict":"accept","reasons":["ok"],"claims_checked":[]}', ['verdict', 'reasons', 'claims_checked']);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.claimsChecked, []);
});

test('parseReview：claims_checked 类型非法 → invalid_claims_checked（fail-closed）', () => {
  for (const bad of [
    '{"verdict":"accept","reasons":["ok"],"claims_checked":"claim A"}',
    '{"verdict":"accept","reasons":["ok"],"claims_checked":[123]}',
    '{"verdict":"accept","reasons":["ok"],"claims_checked":[{"source":"draft"}]}',
    '{"verdict":"accept","reasons":["ok"],"claims_checked":[""]}',
  ]) {
    const r = parseReview(bad, ['verdict', 'reasons', 'claims_checked']);
    assert.ok(!r.ok, bad);
    if (!r.ok) assert.equal(r.error.code, 'invalid_claims_checked', bad);
  }
});

test('parseReview：未配置 claims_checked 时忽略该字段（向后兼容）', () => {
  const r = parseReview('{"verdict":"accept","reasons":["ok"],"claims_checked":[{"claim":"x","source":"draft"}]}', ['verdict', 'reasons']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.claimsChecked, undefined);
});

test('parseReview：schema 未要求 reasons 时可缺省', () => {
  const r = parseReview('{"verdict":"accept"}', ['verdict']);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.reasons, []);
});
