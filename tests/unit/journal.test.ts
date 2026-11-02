import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunJournal } from '../../src/journal/journal.js';
import type { JournalRecord } from '../../src/journal/journal.js';

function tmpJournalPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'bayze-journal-')), 'journal.jsonl');
}

function rec(over: Partial<JournalRecord> = {}): JournalRecord {
  return {
    v: 1,
    ts: new Date().toISOString(),
    runId: 'r1',
    workflowId: 'w',
    status: 'succeeded',
    stopReason: 'completed',
    durationMs: 5,
    steps: [],
    warnings: [],
    ...over,
  };
}

test('append + tail；记录不含输出内容', () => {
  const p = tmpJournalPath();
  try {
    const j = new RunJournal(p);
    assert.equal(j.append(rec()).ok, true);
    const recs = j.tail(10);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.runId, 'r1');
    assert.ok(!('finalOutput' in (recs[0] as object)));
    const raw = readFileSync(p, 'utf8');
    assert.ok(!raw.includes('prompt'));
    assert.ok(!raw.includes('response'));
  } finally {
    rmSync(dirname(p), { recursive: true, force: true });
  }
});

test('clear：删除 journal 及伴生文件', () => {
  const p = tmpJournalPath();
  try {
    const j = new RunJournal(p);
    j.append(rec());
    assert.ok(existsSync(p));
    assert.equal(j.clear().ok, true);
    assert.ok(!existsSync(p));
  } finally {
    rmSync(dirname(p), { recursive: true, force: true });
  }
});

test('保留期：过期记录在下次 append 时清除', () => {
  const p = tmpJournalPath();
  try {
    const j = new RunJournal(p, { retentionMs: 1000 });
    const old = rec({ runId: 'old', ts: new Date(Date.now() - 60_000).toISOString() });
    writeFileSync(p, `${JSON.stringify(old)}\n`, 'utf8');
    j.append(rec({ runId: 'fresh' }));
    const recs = j.tail(10);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.runId, 'fresh');
  } finally {
    rmSync(dirname(p), { recursive: true, force: true });
  }
});

test('体积上限：超限时丢弃最旧记录', () => {
  const p = tmpJournalPath();
  try {
    const j = new RunJournal(p, { maxBytes: 300 });
    j.append(rec({ runId: 'a' }));
    j.append(rec({ runId: 'b' }));
    j.append(rec({ runId: 'c' }));
    const recs = j.tail(10);
    assert.ok(recs.length >= 1 && recs.length < 3, `expected truncation, got ${recs.length}`);
    assert.equal(recs[recs.length - 1]?.runId, 'c');
    assert.ok(!recs.some((r) => r.runId === 'a'));
  } finally {
    rmSync(dirname(p), { recursive: true, force: true });
  }
});

test('禁用（null 路径）：不产生任何文件', () => {
  const j = new RunJournal(null);
  assert.equal(j.enabled, false);
  assert.equal(j.append(rec()).ok, true);
  assert.deepEqual(j.tail(), []);
});
