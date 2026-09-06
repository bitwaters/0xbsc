import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateLazyDeepVeto } from '../../src/safety/deep-veto.js';

void test('does not request lazy safety sources until a candidate can formally qualify', async () => {
  let calls = 0;
  const result = await evaluateLazyDeepVeto(false, {
    holders: () => {
      calls += 1;
      return Promise.resolve({});
    },
    traders: () => Promise.resolve({}),
    createdTokens: () => Promise.resolve({})
  });
  assert.deepEqual(result, {
    allowed: true,
    reason: null,
    fetched: false,
    creatorHistory: null
  });
  assert.equal(calls, 0);
});

void test('fails closed for unverifiable creator data, concentrated holdings and coordinated exits', async () => {
  const safeFetchers = {
    holders: () => Promise.resolve({ concentratedHoldings: false }),
    traders: () => Promise.resolve({ coordinatedSmartMoneyExit: false }),
    createdTokens: () =>
      Promise.resolve({
        creatorDirectHoldUnsafe: false,
        creatorHistory: {
          createdTokens: 2,
          openRatio: 0.75,
          risk: 'healthy' as const,
          qualityLevel: 1 as const
        }
      })
  };
  assert.deepEqual(await evaluateLazyDeepVeto(true, safeFetchers), {
    allowed: true,
    reason: null,
    fetched: true,
    creatorHistory: {
      createdTokens: 2,
      openRatio: 0.75,
      risk: 'healthy',
      qualityLevel: 1
    }
  });
  assert.equal(
    (
      await evaluateLazyDeepVeto(true, {
        ...safeFetchers,
        holders: () => Promise.resolve({ concentratedHoldings: true })
      })
    ).reason,
    'concentrated_holdings_unverified'
  );
  assert.equal(
    (
      await evaluateLazyDeepVeto(true, {
        ...safeFetchers,
        createdTokens: () => Promise.resolve({ creatorDirectHoldUnsafe: false })
      })
    ).reason,
    'creator_history_unverified'
  );
});
