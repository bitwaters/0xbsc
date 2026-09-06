import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessCandidateSafety,
  type CandidateSafetyInput
} from '../../src/safety/candidate-admission.js';

const input: CandidateSafetyInput = {
  discovery: {},
  nowMs: 1_000,
  preFilterThresholds: {
    maxBuyTax: 0.05,
    maxSellTax: 0.05,
    maxTop10Percent: 0.5,
    maxTeamPercent: 0.1
  },
  deepThresholds: {
    maxBuyTax: 0.05,
    maxSellTax: 0.05,
    maxTop10Percent: 0.5,
    maxTeamPercent: 0.1,
    maxEntrapmentPercent: 0.2,
    maxBundlerPercent: 0.2,
    maxSniperPercent: 0.2,
    fatalFlags: []
  },
  deepFetchers: {
    info: () => Promise.resolve({ buyTax: 0.01, sellTax: 0.01, sellable: true }),
    security: () =>
      Promise.resolve({
        top10Percent: 0.1,
        teamPercent: 0.01,
        entrapmentPercent: 0.01,
        bundlerPercent: 0.01,
        sniperPercent: 0.01,
        flags: []
      }),
    pool: () => Promise.resolve({ sellable: true })
  },
  permission: {
    ownerRenounced: true,
    mintDisabled: true,
    hasDangerousPrivilege: false,
    poolKind: 'dex',
    lpLockedOrBurnedPercent: 0.8
  },
  minimumLockedOrBurnedPercent: 0.8,
  mappedFlags: new Set()
};

void test('does not consume deep-analysis work or observation capacity after pre-filter failure', async () => {
  let deepCalls = 0;
  const result = await assessCandidateSafety({
    ...input,
    discovery: { isHoneypot: true },
    deepFetchers: {
      info: () => {
        deepCalls += 1;
        return Promise.resolve({});
      },
      security: () => Promise.resolve({}),
      pool: () => Promise.resolve({})
    }
  });
  assert.deepEqual(result, {
    allowed: false,
    rejectionReason: 'honeypot',
    shouldEnterObservation: false,
    usedCache: false
  });
  assert.equal(deepCalls, 0);
});

void test('safety rejection overrides a hypothetical high score and never admits observation', async () => {
  const result = await assessCandidateSafety({
    ...input,
    permission: { ...input.permission, mintDisabled: false }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.shouldEnterObservation, false);
  assert.equal(result.rejectionReason, 'mint_privilege_unverified');
});
