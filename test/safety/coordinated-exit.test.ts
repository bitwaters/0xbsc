import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCoordinatedExit } from '../../src/safety/coordinated-exit.js';
const policy = {
  recognized_wallet_tags: ['smart_money', 'kol'],
  min_tagged_wallets: 3,
  min_each_sell_percent: 0.05,
  min_total_sell_percent: 0.2,
  max_activity_age_seconds: 180,
  max_activity_spread_seconds: 60
};
const rows = (sell = 0, buy = 0) =>
  Array.from({ length: 3 }, (_, i) => ({
    address: `0x${i}`,
    tags: ['smart_degen'],
    buy_amount_cur: 100 + buy,
    sell_amount_cur: sell,
    buy_volume_cur: 1000 + buy * 10,
    sell_volume_cur: sell * 10,
    amount_cur: 100 + buy - sell,
    netflow_usd: -1000
  }));
void test('requires two snapshots and identifies recent net selling despite a negative cumulative netflow', () => {
  const first = assessCoordinatedExit(rows(), undefined, 1000, policy);
  assert.equal(first.reason, 'trader_baseline_required');
  const result = assessCoordinatedExit(rows(25), first.snapshot, 31_000, policy);
  assert.equal(result.coordinatedSmartMoneyExit, true);
  assert.equal(result.comparedWallets, 3);
  assert.equal(
    assessCoordinatedExit(rows(25, 30), first.snapshot, 31_000, policy).coordinatedSmartMoneyExit,
    false
  );
});
void test('uses a shared exposure denominator and deduplicates wallets', () => {
  const first = assessCoordinatedExit(rows(), undefined, 1000, policy);
  // 3 wallets each sell 8%: sum of wallet percentages is 24%, aggregate sold exposure is only 8%.
  const next = rows(8);
  assert.equal(
    assessCoordinatedExit([...next, next[0]!], first.snapshot, 31_000, policy)
      .coordinatedSmartMoneyExit,
    false
  );
});
void test('does not turn counter resets, transfers or missing wallets into clean comparisons', () => {
  const first = assessCoordinatedExit(rows(10), undefined, 1000, policy);
  assert.equal(
    assessCoordinatedExit(rows(), first.snapshot, 31_000, policy).reason,
    'trader_counter_reset'
  );
  const transfer = rows(10);
  transfer[0]!.amount_cur = 10;
  assert.equal(
    assessCoordinatedExit(transfer, first.snapshot, 31_000, policy).reason,
    'trader_transfer_or_inconsistent_balance'
  );
  assert.equal(
    assessCoordinatedExit(rows(10).slice(1), first.snapshot, 31_000, policy).reason,
    'trader_coverage_changed'
  );
  assert.equal(
    assessCoordinatedExit(rows(25), first.snapshot, 2000, policy).reason,
    'trader_baseline_required'
  );
});
