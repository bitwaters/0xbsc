import type { RuntimeConfig } from '../config/types.js';
import type { NormalizedEvent } from '../discovery/events.js';
import { KeyedSerialExecutor } from '../discovery/events.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import type { Priority } from '../gmgn/scheduler.js';
import { adaptGmgnSafety } from './gmgn-adapter.js';
import { assessCandidateSafety, type CandidateSafetyAssessment } from './candidate-admission.js';
import { adaptDiscoverySafetyFields, preFilter, type CachedSafety } from './pre-filter.js';

export interface SafetyRuntimeResult extends CandidateSafetyAssessment {
  info?: unknown;
  security?: unknown;
  pool?: unknown;
  assessedAtMs?: number;
}

export class SafetyRuntime {
  readonly #serial = new KeyedSerialExecutor();
  readonly #cache = new Map<string, CachedSafety>();
  constructor(
    private readonly config: RuntimeConfig,
    private readonly api: CandidateGmgnApi,
    private readonly now: () => number = Date.now
  ) {}

  /** Runs only payload/cache checks, so weak evidence can be rejected without deep API calls. */
  precheck(event: NormalizedEvent): SafetyRuntimeResult {
    if (event.decisionEligible === false)
      return {
        allowed: false,
        rejectionReason: 'unmapped_signal_type',
        shouldEnterObservation: false,
        usedCache: false
      };
    const cache = this.#cache.get(event.tokenAddress.toLowerCase());
    const prechecked = preFilter(
      adaptDiscoverySafetyFields(event.payload),
      this.thresholds.preFilter,
      this.now(),
      cache
    );
    if (!prechecked.allowed)
      return {
        allowed: false,
        rejectionReason: prechecked.reason,
        shouldEnterObservation: false,
        usedCache: prechecked.usedCache
      };
    return {
      allowed: true,
      rejectionReason: null,
      shouldEnterObservation: true,
      usedCache: prechecked.usedCache,
      ...(prechecked.usedCache && cache?.info !== undefined ? { info: cache.info } : {}),
      ...(prechecked.usedCache && cache?.security !== undefined
        ? { security: cache.security }
        : {}),
      ...(prechecked.usedCache && cache?.pool !== undefined ? { pool: cache.pool } : {}),
      ...(prechecked.usedCache && cache?.assessedAtMs !== undefined
        ? { assessedAtMs: cache.assessedAtMs }
        : {})
    };
  }

  process(
    event: NormalizedEvent,
    options: { force?: boolean; priority?: Priority } = {}
  ): Promise<SafetyRuntimeResult> {
    return this.#serial.enqueue(event.tokenAddress, async () => {
      if (!options.force) {
        const prechecked = this.precheck(event);
        if (!prechecked.allowed || prechecked.usedCache) return prechecked;
      } else if (event.decisionEligible === false)
        return {
          allowed: false,
          rejectionReason: 'unmapped_signal_type',
          shouldEnterObservation: false,
          usedCache: false
        };
      const nowMs = this.now();
      const cache = options.force ? undefined : this.#cache.get(event.tokenAddress.toLowerCase());
      const discovery = adaptDiscoverySafetyFields(event.payload);
      const prechecked = preFilter(discovery, this.thresholds.preFilter, nowMs, cache);
      if (!prechecked.allowed)
        return {
          allowed: false,
          rejectionReason: prechecked.reason,
          shouldEnterObservation: false,
          usedCache: prechecked.usedCache
        };
      if (prechecked.usedCache)
        return {
          allowed: true,
          rejectionReason: null,
          shouldEnterObservation: true,
          usedCache: true,
          ...(cache?.info !== undefined ? { info: cache.info } : {}),
          ...(cache?.security !== undefined ? { security: cache.security } : {}),
          ...(cache?.pool !== undefined ? { pool: cache.pool } : {}),
          ...(cache?.assessedAtMs !== undefined ? { assessedAtMs: cache.assessedAtMs } : {})
        };
      const [info, security, pool] = await Promise.all([
        this.api.token('/v1/token/info', event.tokenAddress, options.priority),
        this.api.token('/v1/token/security', event.tokenAddress, options.priority),
        this.api.token('/v1/token/pool_info', event.tokenAddress, options.priority)
      ]);
      const adapted = adaptGmgnSafety({ info, security, pool });
      const assessment = await assessCandidateSafety({
        discovery,
        nowMs,
        preFilterThresholds: this.thresholds.preFilter,
        deepThresholds: this.thresholds.deep,
        deepFetchers: {
          info: () => Promise.resolve(adapted.deep.info),
          security: () => Promise.resolve(adapted.deep.security),
          pool: () => Promise.resolve(adapted.deep.pool)
        },
        permission: adapted.permission,
        minimumLockedOrBurnedPercent: this.config.security.min_lp_locked_or_burned_percent,
        mappedFlags: new Set(this.config.security.fatal_flags)
      });
      const assessedAtMs = nowMs;
      this.#cache.set(event.tokenAddress.toLowerCase(), {
        accepted: assessment.allowed,
        ...(assessment.rejectionReason ? { rejectionReason: assessment.rejectionReason } : {}),
        expiresAtMs: nowMs + (this.config.quote?.security_pool_max_age_seconds ?? 30) * 1_000,
        ...(assessment.allowed ? { info, security, pool, assessedAtMs } : {})
      });
      return {
        ...assessment,
        ...(assessment.allowed ? { info, security, pool, assessedAtMs } : {})
      };
    });
  }

  private get thresholds(): {
    preFilter: {
      maxBuyTax: number;
      maxSellTax: number;
      maxTop10Percent: number;
      maxTeamPercent: number;
    };
    deep: {
      maxBuyTax: number;
      maxSellTax: number;
      maxTop10Percent: number;
      maxTeamPercent: number;
      maxEntrapmentPercent: number;
      maxBundlerPercent: number;
      maxSniperPercent: number;
      fatalFlags: string[];
    };
  } {
    const security = this.config.security;
    return {
      preFilter: {
        maxBuyTax: security.max_buy_tax,
        maxSellTax: security.max_sell_tax,
        maxTop10Percent: security.max_top10_percent,
        maxTeamPercent: security.max_team_percent
      },
      deep: {
        maxBuyTax: security.max_buy_tax,
        maxSellTax: security.max_sell_tax,
        maxTop10Percent: security.max_top10_percent,
        maxTeamPercent: security.max_team_percent,
        maxEntrapmentPercent: security.max_entrapment_percent,
        maxBundlerPercent: security.max_bundler_percent,
        maxSniperPercent: security.max_sniper_percent,
        fatalFlags: security.fatal_flags
      }
    };
  }
}
