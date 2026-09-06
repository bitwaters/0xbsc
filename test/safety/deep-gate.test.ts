import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateDeepSafety,
  fetchAndEvaluateDeepSafety,
  type DeepSafetyData,
  type DeepSafetyThresholds
} from '../../src/safety/deep-gate.js';

const thresholds: DeepSafetyThresholds = {
  maxBuyTax: 0.05,
  maxSellTax: 0.05,
  maxTop10Percent: 0.5,
  maxTeamPercent: 0.1,
  maxEntrapmentPercent: 0.2,
  maxBundlerPercent: 0.2,
  maxSniperPercent: 0.2,
  fatalFlags: ['honeypot', 'blacklist', 'non_open_source']
};
const safe: DeepSafetyData = {
  info: { buyTax: '5', sellTax: 0.05 },
  security: {
    top10Percent: '50',
    teamPercent: 0.1,
    entrapmentPercent: 0.2,
    bundlerPercent: 0.2,
    sniperPercent: 0.2,
    flags: []
  },
  pool: { sellable: true }
};
const mappedFlags = new Set(['honeypot', 'blacklist', 'non_open_source', 'verified_safe_flag']);

void test('fails closed for every deep safety hard condition', () => {
  assert.equal(evaluateDeepSafety(safe, thresholds, mappedFlags).allowed, true);
  assert.equal(
    evaluateDeepSafety({ ...safe, info: { ...safe.info, buyTax: 0.051 } }, thresholds, mappedFlags)
      .reason,
    'buy_tax_limit'
  );
  assert.equal(
    evaluateDeepSafety(
      { ...safe, security: { ...safe.security, flags: ['new_gmgn_flag'] } },
      thresholds,
      mappedFlags
    ).reason,
    'unmapped_security_flag'
  );
  assert.equal(
    evaluateDeepSafety(
      { ...safe, security: { ...safe.security, flags: ['honeypot'] } },
      thresholds,
      mappedFlags
    ).reason,
    'fatal_flag:honeypot'
  );
  assert.equal(
    evaluateDeepSafety({ ...safe, pool: { sellable: false } }, thresholds, mappedFlags).reason,
    'unsellable'
  );
  assert.equal(
    evaluateDeepSafety({ ...safe, pool: {} }, thresholds, mappedFlags).reason,
    'unsellable'
  );
  assert.equal(
    evaluateDeepSafety(
      { ...safe, security: { ...safe.security, isShowAlert: true } },
      thresholds,
      mappedFlags
    ).reason,
    'unmapped_security_alert'
  );
});

void test('fetches Info, Security and Pool in parallel and retries only missing critical fields', async () => {
  let calls = 0;
  const result = await fetchAndEvaluateDeepSafety(
    {
      info: () => Promise.resolve({ ...safe.info }),
      security: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? { ...safe.security, top10Percent: undefined } : safe.security
        );
      },
      pool: () => Promise.resolve({ ...safe.pool })
    },
    thresholds,
    mappedFlags
  );
  assert.deepEqual(result, { allowed: true, reason: null, attempts: 2, data: safe });
  assert.equal(calls, 2);
});
