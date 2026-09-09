import { normalizeBooleanFlag, type DeepSafetyData } from './deep-gate.js';
import type { PermissionSafetyData } from './permission-gate.js';
import { normalizeRate } from './normalize.js';

type RecordValue = Record<string, unknown>;

export function adaptGmgnSafety(input: { info: unknown; security: unknown; pool: unknown }): {
  deep: DeepSafetyData;
  permission: PermissionSafetyData;
} {
  const info = dataRecord(input.info);
  const security = dataRecord(input.security);
  const launchpad = verifiedLaunchpad(info);
  return {
    deep: {
      info: {
        buyTax: security.buy_tax,
        sellTax: security.sell_tax
      },
      security: {
        top10Percent: security.top_10_holder_rate,
        teamPercent: statValue(info, 'dev_team_hold_rate'),
        entrapmentPercent: statValue(info, 'top_entrapment_trader_percentage'),
        bundlerPercent: statValue(info, 'top_bundler_trader_percentage'),
        sniperPercent: statValue(info, 'top70_sniper_hold_rate'),
        flags: security.flags,
        isShowAlert: normalizeBooleanFlag(security.is_show_alert),
        explicitRisks: {
          honeypot: security.is_honeypot,
          blacklist: security.is_blacklist,
          wash_trading: security.is_wash_trading,
          closed_source: closedSourceRisk(security)
        }
      },
      pool: { sellable: sellableFromCanNotSell(security.can_not_sell) }
    },
    permission: {
      chain: 'bsc',
      ownerRenounced: ownerRenounced(security),
      hasDangerousPrivilege: dangerousPrivilege(security.privileges),
      poolKind: launchpad ? 'launchpad' : 'dex',
      lpLockedOrBurnedPercent: lockPercent(security),
      ...(launchpad ? { verifiedLaunchpadPool: true, verifiedLaunchpadMigration: true } : {})
    }
  };
}

function ownerRenounced(security: RecordValue): boolean | undefined {
  const values = [security.is_renounced, security.owner_renounced].filter(
    (value) => value !== undefined && value !== null
  );
  const normalized = values.map(normalizeBooleanFlag);
  if (!normalized.length || normalized.includes(null) || new Set(normalized).size !== 1)
    return undefined;
  return normalized[0]!;
}

function dataRecord(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as RecordValue;
  const data = record.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as RecordValue) : record;
}
function statValue(info: RecordValue, key: string): unknown {
  const stat = info.stat;
  return stat && typeof stat === 'object' && !Array.isArray(stat)
    ? (stat as RecordValue)[key]
    : undefined;
}
function lockPercent(security: RecordValue): unknown {
  const summary = security.lock_summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined;
  const record = summary as RecordValue;
  const conventional =
    record.lock_percent === undefined ? 0 : normalizedRate(record.lock_percent, 'lock_percent');
  if (conventional === undefined) return undefined;
  const details: unknown[] = Array.isArray(record.lock_detail) ? record.lock_detail : [];
  const burned = details.reduce<number>((total, detail) => {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return total;
    const item = detail as RecordValue;
    if (item.is_blackhole !== true) return total;
    const rate = normalizedRate(item.percent, 'lock_detail.percent');
    return rate === undefined ? Number.NaN : total + rate;
  }, 0);
  if (!Number.isFinite(burned)) return undefined;
  return Math.max(conventional, burned);
}

function sellableFromCanNotSell(value: unknown): boolean | undefined {
  if (value === 0 || value === false) return true;
  if (value === 1 || value === true) return false;
  return undefined;
}

function verifiedLaunchpad(info: RecordValue): boolean {
  const launchpad = info.launchpad;
  const platform = info.launchpad_platform;
  return (
    typeof launchpad === 'string' &&
    launchpad.length > 0 &&
    launchpad === platform &&
    (info.launchpad_status === 1 || info.launchpad_status === '1')
  );
}

function normalizedRate(value: unknown, field: string): number | undefined {
  try {
    return normalizeRate(value, field).toNumber();
  } catch {
    return undefined;
  }
}
function dangerousPrivilege(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return undefined;
}

function closedSourceRisk(security: RecordValue): unknown {
  const values = [security.is_open_source, security.open_source].filter(
    (v) => v !== undefined && v !== null
  );
  if (!values.length) return undefined;
  const flags = values.map(normalizeBooleanFlag);
  if (flags.includes(null)) return 'invalid';
  if (new Set(flags).size > 1) return 'conflict';
  return !flags[0];
}
