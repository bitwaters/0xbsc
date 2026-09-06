import { Decimal } from 'decimal.js';

export interface TraderSnapshot {
  atMs: number;
  wallets: Record<string, Record<string, unknown>>;
}
export interface ExitAssessment {
  coordinatedSmartMoneyExit?: boolean;
  reason?: string;
  snapshot: TraderSnapshot;
  comparedWallets: number;
  taggedWallets: number;
}
const canonical = (tag: string) =>
  ['smart_money', 'smart money', 'smartmoney', 'smart_degen'].includes(tag.toLowerCase())
    ? 'smart_money'
    : ['kol', 'renowned'].includes(tag.toLowerCase())
      ? 'kol'
      : tag.toLowerCase();
const amount = (v: unknown): Decimal | null => {
  if ((typeof v !== 'number' && typeof v !== 'string') || v === '') return null;
  try {
    const n = new Decimal(v);
    return n.isFinite() && n.gte(0) ? n : null;
  } catch {
    return null;
  }
};

/** Compare like-for-like cumulative snapshots. Netflow sign and last activity are not sell events. */
export function assessCoordinatedExit(
  rows: Record<string, unknown>[],
  previous: TraderSnapshot | undefined,
  nowMs: number,
  policy: {
    recognized_wallet_tags: string[];
    min_tagged_wallets: number;
    min_each_sell_percent: number;
    min_total_sell_percent: number;
    max_activity_age_seconds: number;
    max_activity_spread_seconds: number;
    min_snapshot_interval_seconds?: number;
  }
): ExitAssessment {
  const accepted = new Set(policy.recognized_wallet_tags.map(canonical));
  const wallets: TraderSnapshot['wallets'] = {};
  let invalid = false;
  for (const row of rows) {
    const tags = [row.tags ?? [], row.maker_token_tags ?? []];
    if (tags.some((t) => !Array.isArray(t) || t.some((v) => typeof v !== 'string'))) {
      invalid = true;
      continue;
    }
    if (!(tags.flat() as string[]).some((t) => accepted.has(canonical(t)))) continue;
    const address = typeof row.address === 'string' ? row.address.toLowerCase() : '';
    if (!address) {
      invalid = true;
      continue;
    }
    if (wallets[address] && JSON.stringify(wallets[address]) !== JSON.stringify(row))
      invalid = true;
    wallets[address] = row;
  }
  const snapshot = { atMs: nowMs, wallets },
    taggedWallets = Object.keys(wallets).length;
  const unknown = (reason: string, comparedWallets = 0): ExitAssessment => ({
    reason,
    snapshot,
    comparedWallets,
    taggedWallets
  });
  if (invalid) return unknown('trader_fields_invalid');
  if (!taggedWallets && !Object.keys(previous?.wallets ?? {}).length)
    return { coordinatedSmartMoneyExit: false, snapshot, comparedWallets: 0, taggedWallets };
  if (
    !previous ||
    nowMs - previous.atMs < (policy.min_snapshot_interval_seconds ?? 10) * 1000 ||
    nowMs - previous.atMs >
      Math.min(policy.max_activity_age_seconds, policy.max_activity_spread_seconds) * 1000
  )
    return unknown('trader_baseline_required');
  if (Object.keys(previous.wallets).some((address) => !wallets[address]))
    return unknown('trader_coverage_changed');
  let comparedWallets = 0,
    exiting = 0,
    sold = new Decimal(0),
    exposure = new Decimal(0);
  for (const [address, row] of Object.entries(wallets)) {
    const prior = previous.wallets[address];
    if (!prior) return unknown('trader_baseline_required', comparedWallets);
    const keys = [
      'buy_amount_cur',
      'sell_amount_cur',
      'buy_volume_cur',
      'sell_volume_cur',
      'amount_cur'
    ] as const;
    const current = keys.map((k) => amount(row[k])),
      old = keys.map((k) => amount(prior[k]));
    if (current.some((v) => v === null) || old.some((v) => v === null))
      return unknown('trader_fields_missing', comparedWallets);
    const delta = current.map((v, i) => v!.minus(old[i]!));
    if (delta.slice(0, 4).some((v) => v.lt(0)))
      return unknown('trader_counter_reset', comparedWallets);
    // Transfers or inconsistent provider snapshots invalidate the comparison.
    const expectedBalance = old[4]!.plus(delta[0]!).minus(delta[1]!);
    if (expectedBalance.minus(current[4]!).abs().gt(Decimal.max(1, old[4]!).mul('0.000001')))
      return unknown('trader_transfer_or_inconsistent_balance', comparedWallets);
    comparedWallets++;
    exposure = exposure.plus(old[4]!);
    if (
      old[4]!.gt(0) &&
      delta[1]!.minus(delta[0]!).div(old[4]!).gte(policy.min_each_sell_percent) &&
      delta[3]!.gt(delta[2]!)
    ) {
      exiting++;
      sold = sold.plus(Decimal.min(old[4]!, delta[1]!.minus(delta[0]!)));
    }
  }
  return {
    coordinatedSmartMoneyExit:
      exiting >= policy.min_tagged_wallets &&
      exposure.gt(0) &&
      sold.div(exposure).gte(policy.min_total_sell_percent),
    snapshot,
    comparedWallets,
    taggedWallets
  };
}
