import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedWorkQueue } from '../../src/discovery/work-queue.js';
void test('bounds pending work and coalesces without blocking the producer', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const values: number[] = [];
  const queue = new BoundedWorkQueue<number>(
    1,
    1,
    async (value) => {
      values.push(value);
      await gate;
    },
    () => {}
  );
  assert.equal(queue.enqueue('running', 1), true);
  assert.equal(queue.enqueue('next', 2), true);
  assert.equal(queue.enqueue('next', 3), true);
  assert.equal(queue.enqueue('overflow', 4), false);
  assert.deepEqual(values, [1]);
  release();
  await queue.drain();
  assert.deepEqual(values, [1, 3]);
});
