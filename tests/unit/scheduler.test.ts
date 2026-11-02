import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunScheduler } from '../../src/application/workflows/scheduler.js';

test('并发满且队列空：立即 overloaded', async () => {
  const s = new RunScheduler(1, 0);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const first = s.submit(() => gate.then(() => 1));
  assert.ok(first.ok);
  assert.equal(s.inFlight, 1);

  const second = s.submit(() => Promise.resolve(2));
  assert.ok(!second.ok);
  if (!second.ok) assert.equal(second.error.code, 'overloaded');

  release();
  if (first.ok) assert.equal(await first.value, 1);
});

test('排队：释放首个后依次执行', async () => {
  const s = new RunScheduler(1, 1);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const a = s.submit(() => gate.then(() => 'a'));
  const b = s.submit(() => Promise.resolve('b'));
  assert.ok(b.ok);
  release();
  if (a.ok) assert.equal(await a.value, 'a');
  if (b.ok) assert.equal(await b.value, 'b');
  assert.equal(s.inFlight, 0);
});
