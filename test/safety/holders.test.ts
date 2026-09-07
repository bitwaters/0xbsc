import assert from 'node:assert/strict';
import test from 'node:test';
import { assessHolders } from '../../src/safety/holders.js';
const policy = { max_single_non_pool_holder_percent: 0.1, max_suspicious_holder_percent: 0.2 };
const info = { data: { pool: { pool_address: '0xPOOL' } } };
const wallet = { address: '0xwallet', amount_percentage: 0.05, is_suspicious: false };
const assess = (list: unknown, token: unknown = info) =>
  assessHolders({ data: { list } }, token, policy);
void test('excludes identified pool contracts before interpreting wallet flags, while requiring real wallet evidence', () => {
  const result = assess([{ address: '0xpool', amount_percentage: 0.8 }, wallet]);
  assert.equal(result.concentratedHoldings, false);
  assert.equal(result.diagnostics.maxNonPoolShare, 0.05);
  assert.equal(assess([{ address: '0xpool' }]).reason, 'holders_wallets_missing');
  assert.equal(assess([wallet], {}).reason, 'holders_pool_identity_missing');
});
void test('distinguishes missing or malformed evidence from verified holder concentration', () => {
  assert.equal(assess([]).reason, 'holders_list_empty');
  assert.equal(assess({}).reason, 'holders_list_invalid');
  assert.equal(assess([{ ...wallet, address: null }]).reason, 'holders_address_missing');
  assert.equal(assess([{ ...wallet, amount_percentage: null }]).reason, 'holders_share_invalid');
  assert.equal(
    assess([{ ...wallet, is_suspicious: 'false' }]).reason,
    'holders_suspicious_flag_missing'
  );
  assert.equal(assess([wallet, wallet]).reason, 'holders_duplicate_address');
  const risk = assess([{ ...wallet, amount_percentage: 0.11 }]);
  assert.equal(risk.reason, 'holders_single_wallet_limit');
  assert.equal(risk.concentratedHoldings, true);
  assert.equal(assess([{ ...wallet, amount_percentage: 0.1 }]).concentratedHoldings, false);
  assert.equal(
    assess(
      [0, 1, 2].map((i) => ({
        ...wallet,
        address: `wallet${i}`,
        is_suspicious: true,
        amount_percentage: 0.08
      }))
    ).reason,
    'holders_suspicious_total_limit'
  );
});
