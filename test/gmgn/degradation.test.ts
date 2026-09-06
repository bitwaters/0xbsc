import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseBudgetAction } from '../../src/gmgn/degradation.js';

void test('degrades result work before low-score observation and protects formal safety/Quote', () => {
  assert.deepEqual(chooseBudgetAction({ kind: 'result', nowMs: 1, utilization: 0.9 }), {
    action: 'postpone',
    reevaluationMultiplier: 1
  });
  assert.deepEqual(
    chooseBudgetAction({ kind: 'observation', score: 60, nowMs: 1, utilization: 0.9 }),
    { action: 'run', reevaluationMultiplier: 2 }
  );
  assert.deepEqual(
    chooseBudgetAction({ kind: 'formal_safety_quote', nowMs: 1, utilization: 0.99 }),
    { action: 'run', reevaluationMultiplier: 1 }
  );
});

void test('expires stale realtime work rather than keeping it in a later queue', () => {
  assert.deepEqual(
    chooseBudgetAction({ kind: 'discovery', nowMs: 11, deadlineMs: 10, utilization: 0.1 }),
    { action: 'expire', reevaluationMultiplier: 1 }
  );
});
