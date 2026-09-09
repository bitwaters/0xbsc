import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskGroup } from '../../src/runtime/task-group.js';

void test('shutdown drain waits for pending work and tasks spawned by its completion hook', async () => {
  const group = new TaskGroup();
  const first = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>();
  void group.track(
    first.promise.then(() => {
      void group.track(second.promise);
    })
  );
  let drained = false;
  const waiting = group.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  second.resolve();
  await waiting;
  assert.equal(drained, true);
});

void test('a handled task failure does not prevent other tasks from draining', async () => {
  const group = new TaskGroup();
  const pending = Promise.withResolvers<void>();
  const rejected = group.track(Promise.reject(new Error('fixture')));
  void group.track(pending.promise);
  await assert.rejects(rejected, /fixture/);
  let drained = false;
  const waiting = group.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  pending.resolve();
  await waiting;
});
