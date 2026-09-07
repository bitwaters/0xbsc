import { normalizeRate } from './normalize.js';
type RecordValue = Record<string, unknown>;
const record = (x: unknown): RecordValue | null =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as RecordValue) : null;
const address = (x: unknown): string | null =>
  typeof x === 'string' && x.trim() ? x.trim().toLowerCase() : null;
export interface HolderAssessment {
  concentratedHoldings?: boolean;
  reason: string | null;
  diagnostics: {
    rows: number;
    pools: number;
    invalidRow?: number;
    maxNonPoolShare?: number;
    suspiciousShare?: number;
  };
}
/** Only documented pool identities are excluded. Unknown values are not inferred to be safe. */
export function assessHolders(
  value: unknown,
  info: unknown,
  policy: { max_single_non_pool_holder_percent: number; max_suspicious_holder_percent: number }
): HolderAssessment {
  const root = record(value),
    data = record(root?.data) ?? root;
  const list = data?.list ?? data?.tokens;
  const token = record(record(info)?.data) ?? record(info),
    pool = record(token?.pool);
  const pools = new Set(
    [
      token?.pool_address,
      token?.biggest_pool_address,
      token?.migrated_pool,
      pool?.address,
      pool?.pool_address
    ]
      .map(address)
      .filter((x): x is string => x !== null)
  );
  const diagnostics: HolderAssessment['diagnostics'] = {
    rows: Array.isArray(list) ? list.length : 0,
    pools: pools.size
  };
  const unknown = (reason: string): HolderAssessment => ({ reason, diagnostics });
  if (!Array.isArray(list)) return unknown('holders_list_invalid');
  if (!list.length) return unknown('holders_list_empty');
  if (!pools.size) return unknown('holders_pool_identity_missing');
  const owners = new Set<string>();
  let maximum = 0,
    suspicious = 0;
  for (const [i, item] of list.entries()) {
    const row = record(item),
      owner = address(row?.address);
    if (!row || !owner) {
      diagnostics.invalidRow = i;
      return unknown('holders_address_missing');
    }
    // Pool contracts are not individual wallet holders; their missing wallet flags are irrelevant.
    if (pools.has(owner)) continue;
    if (owners.has(owner)) return unknown('holders_duplicate_address');
    owners.add(owner);
    let share: number;
    try {
      share = normalizeRate(row.amount_percentage, 'holder.amount_percentage').toNumber();
    } catch {
      diagnostics.invalidRow = i;
      return unknown('holders_share_invalid');
    }
    if (typeof row.is_suspicious !== 'boolean') {
      diagnostics.invalidRow = i;
      return unknown('holders_suspicious_flag_missing');
    }
    maximum = Math.max(maximum, share);
    if (row.is_suspicious) suspicious += share;
  }
  if (!owners.size) return unknown('holders_wallets_missing');
  diagnostics.maxNonPoolShare = maximum;
  diagnostics.suspiciousShare = suspicious;
  if (maximum > policy.max_single_non_pool_holder_percent)
    return { concentratedHoldings: true, reason: 'holders_single_wallet_limit', diagnostics };
  if (suspicious > policy.max_suspicious_holder_percent)
    return { concentratedHoldings: true, reason: 'holders_suspicious_total_limit', diagnostics };
  return { concentratedHoldings: false, reason: null, diagnostics };
}
