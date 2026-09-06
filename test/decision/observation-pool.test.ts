import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservationPool } from '../../src/decision/observation-pool.js';

const candidate = (
  id: string,
  score: number,
  route: 'new_launch' | 'revival' | 'continuation' = 'new_launch'
) => ({ id, route, score, completeness: 0.8, evidenceFreshness: 1, active: true });

void test('admits until capacity then only replaces a lower-quality active Episode', () => {
  const pool = new ObservationPool(2, 1);
  assert.equal(pool.admit(candidate('low', 65)).admitted, true);
  assert.equal(pool.admit(candidate('medium', 70, 'revival')).admitted, true);
  assert.deepEqual(pool.admit(candidate('weaker', 64, 'continuation')), { admitted: false });
  assert.deepEqual(pool.admit(candidate('strong', 80, 'continuation')), {
    admitted: true,
    demotedId: 'low'
  });
  assert.deepEqual(pool.active.map((episode) => episode.id).sort(), ['medium', 'strong']);
});

void test('preserves historical demoted Episodes and allows route capacity borrowing', () => {
  const pool = new ObservationPool(3, 1);
  pool.admit(candidate('a', 70));
  pool.admit(candidate('b', 71));
  pool.admit(candidate('c', 72));
  assert.equal(pool.active.length, 3);
  const admission = pool.admit(candidate('d', 90));
  assert.equal(admission.admitted, true);
  assert.equal(pool.active.filter((episode) => episode.route === 'new_launch').length, 3);
  assert.deepEqual(pool.admit(candidate('a', 99)), { admitted: false });
});
