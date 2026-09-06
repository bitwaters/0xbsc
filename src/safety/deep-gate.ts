import { normalizeRate } from './normalize.js';

export interface DeepSafetyThresholds {
  maxBuyTax: number;
  maxSellTax: number;
  maxTop10Percent: number;
  maxTeamPercent: number;
  maxEntrapmentPercent: number;
  maxBundlerPercent: number;
  maxSniperPercent: number;
  fatalFlags: readonly string[];
}

export interface DeepSafetyData {
  info: { buyTax?: unknown; sellTax?: unknown };
  security: {
    top10Percent?: unknown;
    teamPercent?: unknown;
    entrapmentPercent?: unknown;
    bundlerPercent?: unknown;
    sniperPercent?: unknown;
    flags?: unknown;
    isShowAlert?: unknown;
    explicitRisks?: Record<string, unknown>;
  };
  pool: { sellable?: unknown };
}

export interface DeepSafetyFetchers {
  info(): Promise<DeepSafetyData['info']>;
  security(): Promise<DeepSafetyData['security']>;
  pool(): Promise<DeepSafetyData['pool']>;
}

export interface DeepSafetyResult {
  allowed: boolean;
  reason: string | null;
  attempts: number;
  data?: DeepSafetyData;
}

const requiredRates = [
  ['info', 'buyTax', 'maxBuyTax', 'buy_tax'],
  ['info', 'sellTax', 'maxSellTax', 'sell_tax'],
  ['security', 'top10Percent', 'maxTop10Percent', 'top10'],
  ['security', 'teamPercent', 'maxTeamPercent', 'team'],
  ['security', 'entrapmentPercent', 'maxEntrapmentPercent', 'entrapment'],
  ['security', 'bundlerPercent', 'maxBundlerPercent', 'bundler'],
  ['security', 'sniperPercent', 'maxSniperPercent', 'sniper']
] as const;

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function hasCriticalFields(data: DeepSafetyData): boolean {
  return requiredRates.every(([source, field]) =>
    isPresent((data[source] as Record<string, unknown>)[field])
  );
}

function flagsFrom(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((flag) => typeof flag !== 'string')) return null;
  const flags: string[] = value as string[];
  return flags.map((flag) => flag.trim().toLowerCase());
}

export function evaluateDeepSafety(
  data: DeepSafetyData,
  thresholds: DeepSafetyThresholds,
  mappedFlags: ReadonlySet<string>
): DeepSafetyResult {
  for (const [name, value] of Object.entries(data.security.explicitRisks ?? {})) {
    if (value === undefined || value === null) continue;
    if (value === 'conflict')
      return { allowed: false, reason: `security_field_conflict:${name}`, attempts: 0 };
    const normalized = normalizeBooleanFlag(value);
    if (normalized === null)
      return { allowed: false, reason: `security_field_invalid:${name}`, attempts: 0 };
    if (normalized) return { allowed: false, reason: `explicit_risk:${name}`, attempts: 0 };
  }
  if (!hasCriticalFields(data))
    return { allowed: false, reason: 'critical_field_missing', attempts: 0 };
  // GMGN's `can_sell` is not a reliable affirmative flag on BSC launchpads.
  // `can_not_sell` is the audited risk indicator; it must explicitly say the
  // token is sellable, otherwise we fail closed.
  if (data.pool.sellable !== true) return { allowed: false, reason: 'unsellable', attempts: 0 };
  const flags = flagsFrom(data.security.flags);
  if (!flags) return { allowed: false, reason: 'security_flags_invalid', attempts: 0 };
  if (data.security.isShowAlert === true)
    return { allowed: false, reason: 'unmapped_security_alert', attempts: 0 };
  for (const flag of flags) {
    if (!mappedFlags.has(flag))
      return { allowed: false, reason: 'unmapped_security_flag', attempts: 0 };
    if (thresholds.fatalFlags.includes(flag))
      return { allowed: false, reason: `fatal_flag:${flag}`, attempts: 0 };
  }
  for (const [source, field, threshold, label] of requiredRates) {
    try {
      if (
        normalizeRate((data[source] as Record<string, unknown>)[field], label).gt(
          thresholds[threshold]
        )
      )
        return { allowed: false, reason: `${label}_limit`, attempts: 0 };
    } catch {
      return { allowed: false, reason: `${label}_invalid`, attempts: 0 };
    }
  }
  return { allowed: true, reason: null, attempts: 0, data };
}

export async function fetchAndEvaluateDeepSafety(
  fetchers: DeepSafetyFetchers,
  thresholds: DeepSafetyThresholds,
  mappedFlags: ReadonlySet<string>,
  missingFieldRetries = 1
): Promise<DeepSafetyResult> {
  for (let attempts = 1; attempts <= missingFieldRetries + 1; attempts += 1) {
    let data: DeepSafetyData;
    try {
      const [info, security, pool] = await Promise.all([
        fetchers.info(),
        fetchers.security(),
        fetchers.pool()
      ]);
      data = { info, security, pool };
    } catch {
      return { allowed: false, reason: 'safety_source_unavailable', attempts };
    }
    const result = evaluateDeepSafety(data, thresholds, mappedFlags);
    if (result.reason !== 'critical_field_missing' || attempts > missingFieldRetries)
      return { ...result, attempts, ...(result.allowed ? { data } : {}) };
  }
  return { allowed: false, reason: 'critical_field_missing', attempts: missingFieldRetries + 1 };
}

export function normalizeBooleanFlag(value: unknown): boolean | null {
  if (value === true || value === 1 || ['1', 'true', 'yes'].includes(String(value).toLowerCase()))
    return true;
  if (value === false || value === 0 || ['0', 'false', 'no'].includes(String(value).toLowerCase()))
    return false;
  return null;
}
