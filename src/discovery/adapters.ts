import { createHash } from 'node:crypto';
import { mapSignalType } from '../gmgn/signal-mapping.js';
import { normalizeRate } from '../safety/normalize.js';
import {
  normalizeEvent,
  snapshotHash,
  type DiscoverySource,
  type EvidenceFamily,
  type NormalizedEvent
} from './events.js';

const sourceEvidence: Record<
  Exclude<DiscoverySource, 'signal'>,
  { family: EvidenceFamily; strength: 'weak' | 'strong' }
> = {
  trenches: { family: 'lifecycle', strength: 'strong' },
  trending: { family: 'attention', strength: 'weak' },
  hot: { family: 'attention', strength: 'weak' },
  smart_money: { family: 'capital', strength: 'strong' },
  kol: { family: 'capital', strength: 'strong' }
};

export function adaptGmgnResponse(input: {
  source: DiscoverySource;
  pollKey: string;
  response: unknown;
  observedAtMs: number;
  ttlMs: number;
  ttlByFamilyMs?: Partial<Record<EvidenceFamily, number>>;
  narrativeTtlMs?: number;
  maxRank?: number;
  rankChangeStep?: number;
  snapshotSafetyThresholds?: {
    maxBuyTax: number;
    maxSellTax: number;
    maxTop10Percent: number;
    maxTeamPercent: number;
  };
}): NormalizedEvent[] {
  return responseRows(input.response, input.source).flatMap((row) => {
    if (input.source === 'trending' && input.maxRank !== undefined) {
      const rank = numberField(row, 'rank');
      if (rank === null || rank > input.maxRank) return [];
    }
    const tokenAddress = stringField(row, ['token_address', 'address', 'base_address']);
    if (!tokenAddress || !/^0x[a-fA-F0-9]{3,}$/.test(tokenAddress)) return [];
    const payload = sanitizePayload(row);
    const sourceEventId = stringField(row, ['id', 'event_id', 'transaction_hash']);
    const sourceEventAtMs =
      input.source === 'trenches'
        ? timestampMs(
            row,
            Number(row.launchpad_status) === 2 || Number(row.complete_timestamp) > 0
              ? ['complete_timestamp']
              : ['trigger_at', 'timestamp', 'open_timestamp', 'created_timestamp']
          )
        : timestampMs(row, ['trigger_at', 'timestamp']);
    const rawPayloadRef = `sha256:${createHash('sha256').update(JSON.stringify(row)).digest('hex')}`;
    if (input.source === 'signal') {
      const signalType = numberField(row, 'signal_type');
      const mapping = signalType === null ? null : mapSignalType(signalType);
      const family = mapping?.evidenceFamily ?? 'attention';
      return [
        normalizeEvent({
          chain: 'bsc',
          tokenAddress,
          source: 'signal',
          ...(sourceEventId ? { sourceEventId } : {}),
          pollKey: input.pollKey,
          sourceEventAtMs,
          observedAtMs: input.observedAtMs,
          evidenceFamily: family,
          strength: mapping ? 'strong' : 'weak',
          expiresAtMs: input.observedAtMs + ttlFor(input, family),
          rawPayloadRef,
          payload: {
            ...payload,
            signal_type: signalType,
            mapping_version: mapping?.version ?? null
          },
          decisionEligible: mapping !== null
        })
      ];
    }
    const evidence = sourceEvidence[input.source];
    const side = stringField(row, ['side'])?.toLowerCase();
    if (
      (input.source === 'smart_money' || input.source === 'kol') &&
      side !== 'buy' &&
      side !== 'sell'
    )
      return [];
    return [
      normalizeEvent({
        chain: 'bsc',
        tokenAddress,
        source: input.source,
        ...(sourceEventId ? { sourceEventId } : {}),
        pollKey:
          input.source === 'hot'
            ? `${input.pollKey}:${pollKeyPart(payload.hot_interval)}`
            : input.pollKey,
        sourceEventAtMs,
        observedAtMs: input.observedAtMs,
        evidenceFamily: evidence.family,
        strength: evidence.strength,
        expiresAtMs: input.observedAtMs + ttlFor(input, evidence.family),
        rawPayloadRef,
        snapshotHash: snapshotHash(
          decisionSnapshot(
            input.source,
            row,
            input.rankChangeStep ?? 5,
            input.snapshotSafetyThresholds
          )
        ),
        payload:
          (input.source === 'smart_money' || input.source === 'kol') && side === 'sell'
            ? { ...payload, contrary: true }
            : payload
      })
    ];
  });
}

/**
 * Snapshot sources contain rapidly changing market values. Those values are
 * fetched again during route analysis, so only discovery fields that can alter
 * admission, lifecycle, or safety belong in the deduplication fingerprint.
 */
function decisionSnapshot(
  source: Exclude<DiscoverySource, 'signal'>,
  row: Record<string, unknown>,
  rankChangeStep: number,
  safetyThresholds?: {
    maxBuyTax: number;
    maxSellTax: number;
    maxTop10Percent: number;
    maxTeamPercent: number;
  }
): Record<string, unknown> {
  const common = pick(row, [
    'address',
    'token_address',
    'base_address',
    'is_honeypot',
    'is_wash_trading',
    'is_show_alert',
    'burn_status',
    'owner_renounced',
    'is_renounced',
    'renounced_mint',
    'renounced_freeze_account',
    'launchpad',
    'launchpad_platform',
    'launchpad_status',
    'open_timestamp'
  ]);
  const safetyState = safetyThresholds
    ? {
        buy_tax_state: rateLimitState(row.buy_tax, safetyThresholds.maxBuyTax),
        sell_tax_state: rateLimitState(row.sell_tax, safetyThresholds.maxSellTax),
        top10_state: rateLimitState(row.top_10_holder_rate, safetyThresholds.maxTop10Percent),
        team_state: rateLimitState(row.dev_team_hold_rate, safetyThresholds.maxTeamPercent)
      }
    : pick(row, ['buy_tax', 'sell_tax', 'top_10_holder_rate', 'dev_team_hold_rate']);
  if (source === 'trending' || source === 'hot')
    return {
      ...common,
      ...safetyState,
      rank_bucket: rankBucket(row.rank, rankChangeStep),
      ...(source === 'hot' ? { hot_interval: row.hot_interval } : {})
    };
  if (source === 'trenches')
    return {
      ...common,
      ...safetyState,
      status: row.status,
      complete_timestamp: row.complete_timestamp,
      progress_bucket: progressBucket(row.progress),
      has_buys: positive(row.buys_24h),
      has_sells: positive(row.sells_24h),
      creator_token_status: row.creator_token_status
    };
  return { ...common, ...safetyState };
}

function rateLimitState(
  value: unknown,
  maximum: number
): 'missing' | 'invalid' | 'allowed' | 'exceeded' {
  if (value === undefined || value === null || value === '') return 'missing';
  try {
    return normalizeRate(value, 'snapshot_rate').gt(maximum) ? 'exceeded' : 'allowed';
  } catch {
    return 'invalid';
  }
}

function rankBucket(value: unknown, step: number): number | null {
  const rank = Number(value);
  if (!Number.isFinite(rank) || rank < 1) return null;
  return Math.floor((rank - 1) / Math.max(1, step));
}

function pollKeyPart(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : 'unknown';
}

function pick(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (row[key] === undefined ? [] : [[key, row[key]]]))
  );
}

function progressBucket(value: unknown): number | null {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return null;
  return Math.floor(Math.max(0, Math.min(1, progress)) * 20) / 20;
}

function positive(value: unknown): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function ttlFor(
  input: {
    source: DiscoverySource;
    ttlMs: number;
    ttlByFamilyMs?: Partial<Record<EvidenceFamily, number>>;
    narrativeTtlMs?: number;
  },
  family: EvidenceFamily
): number {
  if ((input.source === 'hot' || input.source === 'trending') && input.narrativeTtlMs !== undefined)
    return input.narrativeTtlMs;
  return input.ttlByFamilyMs?.[family] ?? input.ttlMs;
}

/**
 * Discovery rows can carry inline base64 artwork. It is neither decision input nor
 * safe to retain in every SQLite event; the raw payload digest remains auditable.
 */
function sanitizePayload(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).flatMap(([key, value]) =>
      /base64/i.test(key) ? [] : [[key, sanitizeValue(value)] as const]
    )
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!isRecord(value)) return value;
  return sanitizePayload(value);
}

export function responseRows(value: unknown, source: DiscoverySource): Record<string, unknown>[] {
  const data = unwrapData(value);
  if (source === 'trending') {
    const rank = isRecord(data) ? [...records(data.rank), ...records(data.list)] : [];
    return rank.map((row, index) => ({ ...row, rank: numberField(row, 'rank') ?? index + 1 }));
  }
  if (source === 'hot' && Array.isArray(data))
    return records(data).flatMap((group) =>
      records(group.tokens).map((row, index) => ({
        ...row,
        rank: index + 1,
        hot_interval: group.interval
      }))
    );
  if (Array.isArray(data)) return records(data);
  if (!isRecord(data)) return [];
  const direct = ['list', 'items', 'tokens'].flatMap((key) => records(data[key]));
  if (direct.length) return direct;
  return Object.values(data).flatMap(records);
}

function unwrapData(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current) || !('data' in current)) break;
    current = current.data;
  }
  return current;
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function stringField(row: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) if (typeof row[field] === 'string') return row[field];
  return null;
}
function numberField(row: Record<string, unknown>, field: string): number | null {
  if (row[field] === null || row[field] === undefined || row[field] === '') return null;
  const value = Number(row[field]);
  return Number.isFinite(value) ? value : null;
}
function timestampMs(row: Record<string, unknown>, fields: string[]): number | null {
  for (const field of fields) {
    const value = numberField(row, field);
    if (value !== null) return value < 10_000_000_000 ? value * 1_000 : value;
  }
  return null;
}
