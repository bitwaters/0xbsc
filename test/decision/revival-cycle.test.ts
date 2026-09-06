import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeRevivalCycle, observeRevivalDormancy } from '../../src/decision/revival-cycle.js';

void test('requires completed dormancy before first revival and re-dormancy before another one', () => {
  const initial = { dormantSinceLastRevival: false };
  assert.equal(consumeRevivalCycle(initial, true, true).eligible, false);
  const dormant = observeRevivalDormancy(initial, true);
  const first = consumeRevivalCycle(dormant, true, true);
  assert.equal(first.eligible, true);
  assert.equal(first.next.dormantSinceLastRevival, false);
  assert.equal(consumeRevivalCycle(first.next, true, true).eligible, false);
  assert.equal(
    consumeRevivalCycle(observeRevivalDormancy(first.next, true), false, true).eligible,
    false
  );
});
