import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDeterministicChecks } from '../../src/domain/evaluation/checks.js';

test('max_words：空白分词计数（dogfood 四次证实模型报数不可信，词数约束交给引擎）', () => {
  // 14 词的译文（测试③ Cherry 逐词数的同款）
  const t = 'Our service enables SMEs to use large language models without hiring a technical team.';
  const ok = runDeterministicChecks(t, [{ max_words: 30 }]);
  assert.equal(ok[0]?.passed, true);

  const over = runDeterministicChecks(t, [{ max_words: 13 }]);
  assert.equal(over[0]?.passed, false);
  assert.match(over[0]?.detail ?? '', /word count 14 exceeds max_words 13/);
});

test('max_words：空串计 0 词；多空白/换行归一', () => {
  assert.equal(runDeterministicChecks('   ', [{ max_words: 5 }])[0]?.passed, true);
  const messy = runDeterministicChecks('a\n\n  b\t c', [{ max_words: 3 }]);
  assert.equal(messy[0]?.passed, true, '连续空白只算一个分隔');
  assert.equal(runDeterministicChecks('a b c d', [{ max_words: 3 }])[0]?.passed, false);
});

test('max_words 与 max_chars/non_empty 混合使用互不干扰', () => {
  const specs = ['non_empty' as const, { max_chars: 100 }, { max_words: 10 }];
  const r = runDeterministicChecks('one two three four five', specs);
  assert.deepEqual(r.map((x) => x.checkId), ['non_empty', 'max_chars', 'max_words']);
  assert.ok(r.every((x) => x.passed));
});
