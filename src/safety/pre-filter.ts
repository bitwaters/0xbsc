import { normalizeRate } from './normalize.js';

export interface SafetyThresholds {
  maxBuyTax: number;
  maxSellTax: number;
  maxTop10Percent: number;
  maxTeamPercent: number;
}
export interface DiscoverySafetyFields {
  buyTax?: unknown;
  sellTax?: unknown;
  top10Percent?: unknown;
  teamPercent?: unknown;
  isHoneypot?: unknown;
  isWashTrading?: unknown;
}

/** Maps the audited GMGN discovery response names into the safety contract. */
export function adaptDiscoverySafetyFields(
  payload: Record<string, unknown>
): DiscoverySafetyFields {
  const nested = payload.data;
  if (nested && typeof nested === 'object' && !Array.isArray(nested))
    payload = { ...payload, ...nested };
  return {
    buyTax: firstDefined(payload.buyTax, payload.buy_tax),
    sellTax: firstDefined(payload.sellTax, payload.sell_tax),
    top10Percent: firstDefined(payload.top10Percent, payload.top_10_holder_rate),
    teamPercent: firstDefined(payload.teamPercent, payload.dev_team_hold_rate),
    isHoneypot: booleanRisk(firstDefined(payload.isHoneypot, payload.is_honeypot)),
    isWashTrading: booleanRisk(firstDefined(payload.isWashTrading, payload.is_wash_trading))
  };
}
export interface CachedSafety {
  expiresAtMs: number;
  accepted: boolean;
  info?: unknown;
  security?: unknown;
  pool?: unknown;
  assessedAtMs?: number;
  rejectionReason?: string;
}
export interface PreFilterResult {
  allowed: boolean;
  reason: string | null;
  usedCache: boolean;
}

export function preFilter(
  fields: DiscoverySafetyFields,
  thresholds: SafetyThresholds,
  nowMs: number,
  cache?: CachedSafety
): PreFilterResult {
  // Fresh source-side vetoes always outrank an older deep-safety cache.
  if (fields.isHoneypot === true) return { allowed: false, reason: 'honeypot', usedCache: false };
  if (fields.isWashTrading === true)
    return { allowed: false, reason: 'wash_trading', usedCache: false };
  const checks: Array<[unknown, number, string]> = [
    [fields.buyTax, thresholds.maxBuyTax, 'buy_tax'],
    [fields.sellTax, thresholds.maxSellTax, 'sell_tax'],
    [fields.top10Percent, thresholds.maxTop10Percent, 'top10'],
    [fields.teamPercent, thresholds.maxTeamPercent, 'team']
  ];
  for (const [value, maximum, name] of checks) {
    if (value === undefined) continue;
    try {
      if (normalizeRate(value, name).gt(maximum))
        return { allowed: false, reason: `${name}_limit`, usedCache: false };
    } catch {
      return { allowed: false, reason: `${name}_invalid`, usedCache: false };
    }
  }
  if (cache && cache.expiresAtMs > nowMs)
    return cache.accepted
      ? { allowed: true, reason: null, usedCache: true }
      : {
          allowed: false,
          reason: cache.rejectionReason ?? 'cached_safety_rejection',
          usedCache: true
        };
  return { allowed: true, reason: null, usedCache: false };
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function booleanRisk(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1' || value === 'yes') return true;
  if (value === false || value === 0 || value === '0' || value === 'no') return false;
  return undefined;
}
