import type { RuntimeConfig } from '../config/types.js';
import type { MarketFact } from '../gmgn/facts.js';
import { adaptGmgnSafety } from '../safety/gmgn-adapter.js';
import { evaluateDeepSafety, type DeepSafetyThresholds } from '../safety/deep-gate.js';
import { evaluatePermissionAndLpSafety } from '../safety/permission-gate.js';
import { normalizeRate } from '../safety/normalize.js';

export interface RiskFinding {
  kind: 'risk' | 'data';
  reason: string;
  factIds: string[];
  expiresAtMs: number;
  field?: string;
  actual?: string;
  limit?: number;
  endpoint?: string;
}
export const riskThresholds = (c: RuntimeConfig): DeepSafetyThresholds => ({
  maxBuyTax: c.security.max_buy_tax,
  maxSellTax: c.security.max_sell_tax,
  maxTop10Percent: c.security.max_top10_percent,
  maxTeamPercent: c.security.max_team_percent,
  maxEntrapmentPercent: c.security.max_entrapment_percent,
  maxBundlerPercent: c.security.max_bundler_percent,
  maxSniperPercent: c.security.max_sniper_percent,
  fatalFlags: c.security.fatal_flags
});
export function creatorAddress(info: MarketFact): string | null {
  const p = info.payload;
  const values = [
    (p.dev as { creator_address?: unknown } | undefined)?.creator_address,
    (p.pool as { creator?: unknown } | undefined)?.creator
  ];
  return (
    values.find((v): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v)) ?? null
  );
}
export function factProblem(
  f: MarketFact,
  endpoint: string,
  token: string,
  pool: string,
  ttl: number,
  now: number
): RiskFinding | null {
  const base = {
    kind: 'data' as const,
    factIds: [f.factId],
    expiresAtMs: Number.isSafeInteger(f.requestedAtMs)
      ? Math.min(now + 30000, f.requestedAtMs + ttl)
      : now,
    endpoint
  };
  if (f.endpoint !== endpoint || (endpoint !== 'created_tokens' && f.token !== token))
    return { ...base, reason: 'RISK_FACT_IDENTITY_MISMATCH' };
  if (endpoint !== 'created_tokens' && f.poolRevision !== pool)
    return { ...base, reason: 'RISK_POOL_CHANGED' };
  if (
    !Number.isSafeInteger(f.requestedAtMs) ||
    !Number.isSafeInteger(f.receivedAtMs) ||
    f.requestedAtMs > f.receivedAtMs ||
    f.receivedAtMs > now ||
    now - f.requestedAtMs > ttl
  )
    return { ...base, reason: 'RISK_FACT_STALE' };
  if (
    f.qualityFlags.some(
      (flag) => !['PRICE_SOURCE_TIME_UNVERIFIED', 'TOP_WALLET_COVERAGE_ONLY'].includes(flag)
    )
  )
    return { ...base, reason: 'RISK_FACT_QUALITY_UNKNOWN' };
  return null;
}
/** Same limits as the final deep gate; Info alone never grants safety approval. */
export function screenInfo(
  info: MarketFact,
  config: RuntimeConfig,
  now: number
): RiskFinding | null {
  const ttl = config.scoring.data_ttl_seconds.info * 1000;
  const bad = factProblem(info, 'info', info.token!, info.poolRevision, ttl, now);
  if (bad) return bad;
  const stat = (info.payload.stat ?? {}) as Record<string, unknown>;
  const limits = [
    ['dev_team_hold_rate', 'team', config.security.max_team_percent],
    ['top_entrapment_trader_percentage', 'entrapment', config.security.max_entrapment_percent],
    ['top_bundler_trader_percentage', 'bundler', config.security.max_bundler_percent],
    ['top70_sniper_hold_rate', 'sniper', config.security.max_sniper_percent]
  ] as const;
  const base = { factIds: [info.factId], expiresAtMs: info.requestedAtMs + ttl };
  for (const [field, label, limit] of limits) {
    try {
      const value = normalizeRate(stat[field], label);
      if (value.gt(limit))
        return {
          ...base,
          kind: 'risk',
          reason: label + '_limit',
          field,
          actual: value.toString(),
          limit
        };
    } catch {
      return { ...base, kind: 'data', reason: 'INFO_RISK_FIELD_UNAVAILABLE', field };
    }
  }
  if (!creatorAddress(info)) return { ...base, kind: 'data', reason: 'CREATOR_MISSING' };
  return null;
}
export function screenBasic(
  info: MarketFact,
  security: MarketFact,
  pool: MarketFact,
  config: RuntimeConfig,
  now: number
): RiskFinding | null {
  const ttl = config.quote.security_pool_max_age_seconds * 1000;
  for (const [f, endpoint] of [
    [info, 'info'],
    [security, 'security'],
    [pool, 'pool']
  ] as const) {
    const bad = factProblem(f, endpoint, info.token!, info.poolRevision, ttl, now);
    if (bad) return bad;
  }
  const fromInfo = screenInfo(info, config, now);
  if (fromInfo) return fromInfo;
  const a = adaptGmgnSafety({ info: info.payload, security: security.payload, pool: pool.payload });
  const deep = evaluateDeepSafety(
    a.deep,
    riskThresholds(config),
    new Set(config.security.fatal_flags)
  );
  const base = {
    factIds: [info.factId, security.factId, pool.factId],
    expiresAtMs: Math.min(info.requestedAtMs, security.requestedAtMs, pool.requestedAtMs) + ttl
  };
  if (!deep.allowed)
    return {
      ...base,
      kind:
        deep.reason &&
        (deep.reason.endsWith('_limit') ||
          deep.reason.startsWith('explicit_risk:') ||
          deep.reason.startsWith('fatal_flag:'))
          ? 'risk'
          : 'data',
      reason: deep.reason ?? 'DEEP_RISK_FAILED',
      ...deep.details
    };
  const permission = evaluatePermissionAndLpSafety(
    a.permission,
    config.security.min_lp_locked_or_burned_percent
  );
  if (!permission.allowed)
    return {
      ...base,
      kind: permission.reason === 'lp_lock_limit' ? 'risk' : 'data',
      reason: permission.reason ?? 'PERMISSION_FAILED'
    };
  return null;
}
