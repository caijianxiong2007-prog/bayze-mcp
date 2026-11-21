import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderStepPrompt } from '../../src/application/workflows/templates.js';

const ctx = (over: Partial<Parameters<typeof renderStepPrompt>[1]> = {}) => ({
  original: 'TASK-TEXT',
  reviewSchemaFields: ['verdict', 'reasons'],
  ...over,
});

test('original：直传任务文本', () => {
  const r = renderStepPrompt('original', ctx());
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.user, 'TASK-TEXT');
    assert.equal(r.value.system, undefined);
  }
});

test('original_and_previous：缺前序成功输出 → missing_required_input', () => {
  const r = renderStepPrompt('original_and_previous', ctx());
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'missing_required_input');
});

test('original_and_previous：含不可信标记与前序输出', () => {
  const r = renderStepPrompt('original_and_previous', ctx({ previousOutput: 'PREV-OUT' }));
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.user.includes('=== ORIGINAL TASK'));
    assert.ok(r.value.user.includes('PREV-OUT'));
    assert.ok(r.value.user.includes('UNTRUSTED'));
  }
});

test('review_template：缺草稿报错；有草稿时含评审指令与不可信标记', () => {
  const bad = renderStepPrompt('review_template', ctx());
  assert.ok(!bad.ok);
  if (!bad.ok) assert.equal(bad.error.code, 'missing_required_input');

  const r = renderStepPrompt('review_template', ctx({ previousOutput: 'DRAFT-1' }));
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.system !== undefined && r.value.system.includes('JSON'));
    assert.ok(r.value.user.includes('DRAFT-1'));
    assert.ok(r.value.user.includes('UNTRUSTED'));
    assert.ok(r.value.user.includes('verdict, reasons'));
  }
});

test('revision_template：缺评审意见报错；完整时含意见 JSON', () => {
  const bad = renderStepPrompt('revision_template', ctx({ previousOutput: 'DRAFT-1' }));
  assert.ok(!bad.ok);
  if (!bad.ok) assert.equal(bad.error.code, 'missing_required_input');

  const r = renderStepPrompt('revision_template', ctx({ previousOutput: 'DRAFT-1', reviewFeedback: { verdict: 'revise', reasons: ['r1'] } }));
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.user.includes('"verdict":"revise"'));
    assert.ok(r.value.user.includes('UNTRUSTED'));
  }
});

test('review_template：schema 含 claims_checked 时提示逐条核查清单', () => {
  const r = renderStepPrompt(
    'review_template',
    ctx({ previousOutput: 'DRAFT-1', reviewSchemaFields: ['verdict', 'reasons', 'claims_checked'] }),
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.system !== undefined);
    assert.ok(r.value.system.includes('claims_checked'));
    assert.ok(r.value.system.includes('NOT_FOUND'));
    assert.ok(r.value.user.includes('claims_checked'));
    // 未配置时不出现（向后兼容）
    const plain = renderStepPrompt('review_template', ctx({ previousOutput: 'DRAFT-1' }));
    assert.ok(plain.ok);
    if (plain.ok) assert.ok(!plain.value.system?.includes('claims_checked'));
  }
});

test('revision_template：带 claimsChecked 的评审意见透传给修订模型', () => {
  const r = renderStepPrompt(
    'revision_template',
    ctx({
      previousOutput: 'DRAFT-1',
      reviewFeedback: {
        verdict: 'revise',
        reasons: ['r1'],
        claimsChecked: [{ claim: 'unsupported number', source: 'NOT_FOUND' }],
      },
    }),
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.user.includes('claimsChecked'));
    assert.ok(r.value.user.includes('NOT_FOUND'));
  }
});
