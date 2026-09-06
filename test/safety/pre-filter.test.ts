import assert from 'node:assert/strict';
import test from 'node:test';
import { preFilter } from '../../src/safety/pre-filter.js';

const thresholds = { maxBuyTax: 0.05, maxSellTax: 0.05, maxTop10Percent: 0.5, maxTeamPercent: 0.1 };

void test('rejects known discovery safety failures before deep analysis', () => {
  assert.deepEqual(preFilter({ isHoneypot: true }, thresholds, 0), {
    allowed: false,
    reason: 'honeypot',
    usedCache: false
  });
  assert.deepEqual(preFilter({ buyTax: '6' }, thresholds, 0), {
    allowed: false,
    reason: 'buy_tax_limit',
    usedCache: false
  });
  assert.deepEqual(preFilter({ teamPercent: 'unknown' }, thresholds, 0), {
    allowed: false,
    reason: 'team_invalid',
    usedCache: false
  });
});

void test('uses fresh cached safety without allowing it to override a fresh hard veto', () => {
  assert.deepEqual(
    preFilter({ isHoneypot: true }, thresholds, 0, { expiresAtMs: 1, accepted: true }),
    { allowed: false, reason: 'honeypot', usedCache: false }
  );
  assert.deepEqual(preFilter({}, thresholds, 0, { expiresAtMs: 1, accepted: true }), {
    allowed: true,
    reason: null,
    usedCache: true
  });
  assert.deepEqual(preFilter({}, thresholds, 1, { expiresAtMs: 1, accepted: false }), {
    allowed: true,
    reason: null,
    usedCache: false
  });
});
