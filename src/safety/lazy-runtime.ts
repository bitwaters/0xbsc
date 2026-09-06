import type { RuntimeConfig } from '../config/types.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import { assessCoordinatedExit, type TraderSnapshot } from './coordinated-exit.js';
import { normalizeRate } from './normalize.js';
import { evaluateLazyDeepVeto, type LazyDeepSafetyData } from './deep-veto.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
function nested(value: unknown, key: string): JsonRecord | null {
  return record(record(value)?.[key]);
}
function rows(value: unknown): JsonRecord[] | null {
  const root = record(value);
  const data = nested(value, 'data') ?? root;
  const list = data?.list ?? data?.tokens;
  return Array.isArray(list) && list.every((item) => record(item)) ? (list as JsonRecord[]) : null;
}
function rate(value: unknown, field: string): number | null {
  try {
    return normalizeRate(value, field).toNumber();
  } catch {
    return null;
  }
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}
/** Converts the audited GMGN response shapes into conservative veto booleans. */
export class LazySafetyRuntime {
  readonly cachedTraderResults = new Map<
    string,
    { atMs: number; value: LazyDeepSafetyData['traders'] }
  >();
  readonly dataCache = new Map<string, { atMs: number; value: unknown }>();
  readonly traderSnapshots = new Map<string, TraderSnapshot>();
  constructor(
    private readonly config: RuntimeConfig,
    private readonly api: CandidateGmgnApi,
    private readonly now: () => number = Date.now
  ) {}

  evaluate(tokenAddress: string, info: unknown): ReturnType<typeof evaluateLazyDeepVeto> {
    const creator = this.creatorAddress(info);
    return evaluateLazyDeepVeto(true, {
      holders: async () =>
        this.holders(
          await this.cachedRead(
            `holders:${tokenAddress}`,
            this.config.scoring?.data_ttl_seconds.holders ?? 300,
            () => this.api.holders(tokenAddress)
          ),
          info
        ),
      traders: () => this.readTraders(tokenAddress),
      createdTokens: async () =>
        creator
          ? this.createdTokens(
              await this.cachedRead(
                `creator:${creator}`,
                this.config.scoring?.data_ttl_seconds.creator ?? 3600,
                () => this.api.createdTokens(creator)
              ),
              info
            )
          : { creatorDirectHoldUnsafe: true }
    });
  }

  private async readTraders(tokenAddress: string): Promise<LazyDeepSafetyData['traders']> {
    const key = tokenAddress.toLowerCase();
    const cached = this.cachedTraderResults.get(key);
    const interval =
      (this.config.security.lazy_deep.coordinated_exit.min_snapshot_interval_seconds ?? 10) * 1000;
    if (cached && this.now() - cached.atMs < interval) return cached.value;
    return this.traders(
      tokenAddress,
      await this.cachedRead(`traders:${key}`, interval / 1000, () => this.api.traders(tokenAddress))
    );
  }

  private creatorAddress(info: unknown): string | null {
    const data = nested(info, 'data') ?? record(info);
    return text(nested(data, 'dev')?.creator_address) ?? text(nested(data, 'pool')?.creator);
  }

  private holders(value: unknown, info: unknown): LazyDeepSafetyData['holders'] {
    const list = rows(value);
    const data = nested(info, 'data') ?? record(info);
    const pool = nested(data, 'pool');
    const poolAddresses = new Set(
      [data?.pool_address, data?.biggest_pool_address, pool?.address, pool?.pool_address]
        .map(text)
        .filter((item): item is string => item !== null)
    );
    if (!list || poolAddresses.size === 0) return { concentratedHoldings: true };
    let suspicious = 0;
    for (const holder of list) {
      const address = text(holder.address);
      const holding = rate(holder.amount_percentage, 'holder.amount_percentage');
      if (!address || holding === null || typeof holder.is_suspicious !== 'boolean')
        return { concentratedHoldings: true };
      if (
        !poolAddresses.has(address) &&
        holding > this.config.security.lazy_deep.max_single_non_pool_holder_percent
      )
        return { concentratedHoldings: true };
      if (holder.is_suspicious) suspicious += holding;
    }
    return {
      concentratedHoldings:
        suspicious > this.config.security.lazy_deep.max_suspicious_holder_percent
    };
  }

  private traders(tokenAddress: string, value: unknown): LazyDeepSafetyData['traders'] {
    const key = tokenAddress.toLowerCase();
    const minimumMs =
      (this.config.security.lazy_deep.coordinated_exit.min_snapshot_interval_seconds ?? 10) * 1000;
    const cached = this.cachedTraderResults.get(key);
    if (cached && this.now() - cached.atMs < minimumMs) return cached.value;
    const list = rows(value);
    if (!list) return { reason: 'trader_list_invalid' };
    const result = assessCoordinatedExit(
      list,
      this.traderSnapshots.get(key),
      this.now(),
      this.config.security.lazy_deep.coordinated_exit
    );
    // Same-clock refresh cannot erase the previous usable comparison baseline.
    if (
      !this.traderSnapshots.has(key) ||
      this.now() - this.traderSnapshots.get(key)!.atMs >= minimumMs
    )
      this.traderSnapshots.set(key, result.snapshot);
    if (result.coordinatedSmartMoneyExit !== undefined)
      this.cachedTraderResults.set(key, { atMs: this.now(), value: result });
    return result;
  }

  private async cachedRead(
    key: string,
    ttlSeconds: number,
    read: () => Promise<unknown>
  ): Promise<unknown> {
    const nowMs = this.now();
    const cached = this.dataCache.get(key);
    if (cached && nowMs - cached.atMs < ttlSeconds * 1000) return cached.value;
    const value = await read();
    this.dataCache.set(key, { atMs: nowMs, value });
    for (const [k, v] of this.dataCache) if (nowMs - v.atMs > 3_600_000) this.dataCache.delete(k);
    return value;
  }

  private createdTokens(value: unknown, info: unknown): LazyDeepSafetyData['createdTokens'] {
    const data = nested(info, 'data') ?? record(info);
    const stat = nested(data, 'stat');
    const created = stat?.creator_created_count;
    const history = nested(value, 'data') ?? record(value);
    const openRatio = rate(history?.open_ratio, 'creator.open_ratio');
    const creatorHold = rate(stat?.creator_hold_rate, 'creator.creator_hold_rate');
    if (
      typeof created !== 'number' ||
      !Number.isInteger(created) ||
      created < 0 ||
      openRatio === null ||
      creatorHold === null
    )
      return { creatorDirectHoldUnsafe: true };
    const policy = this.config.security.lazy_deep;
    const elevatedHistory =
      created > policy.max_creator_created_tokens && openRatio < policy.min_creator_open_ratio;
    return {
      creatorDirectHoldUnsafe: creatorHold > policy.max_creator_hold_percent,
      creatorHistory: {
        createdTokens: created,
        openRatio,
        risk: elevatedHistory ? 'elevated' : 'healthy',
        qualityLevel: elevatedHistory ? 0.5 : 1
      }
    };
  }
}
