import type { RuntimeConfig, RouteName } from '../config/types.js';
import type { NormalizedEvent } from '../discovery/events.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import type { Priority } from '../gmgn/scheduler.js';
import { EvidenceBook, evidenceTtlMs, type Evidence } from './evidence.js';
import {
  adaptGmgnCandles,
  adaptGmgnRouteFeatures,
  rollingRevivalActivity,
  usablePool,
  deriveKlineRouteSignals,
  tokenAgeMs
} from './gmgn-adapter.js';
import { marketFlow } from './flow.js';
import { isDormant } from './features.js';
import { classifyObservationRoute, classifyRoute } from './routes.js';
import type { RouteFeatures } from './routes.js';
import {
  aggregateDimensionLevels,
  decideRoute,
  isFreshField,
  scoreRoute,
  type DimensionContribution,
  type RouteDecision,
  type ScoreResult
} from './scoring.js';

export interface RouteEvaluation {
  route: RouteName | null;
  decision: RouteDecision | null;
  score: ScoreResult | null;
  decisiveTriggerAtMs: number | null;
  evidenceFamilies: number;
  evidence: Evidence[];
  features: RouteFeatures | null;
  observationOnly: boolean;
}

export interface EvidenceObservation {
  eligibleForDeepAnalysis: boolean;
  evidence: Evidence[];
}

export interface RouteClassifyOptions {
  eventAlreadyObserved?: boolean;
  researchOnly?: boolean;
  forceKline?: boolean;
  priority?: Priority;
  infoObservedAtMs?: number | undefined;
  pool?: unknown;
  poolObservedAtMs?: number | undefined;
}

export class RouteRuntime {
  readonly #evidenceByToken = new Map<string, EvidenceBook>();
  readonly #klineCache = new Map<string, { value: unknown; observedAtMs: number }>();
  constructor(
    private readonly config: RuntimeConfig,
    private readonly api: CandidateGmgnApi,
    private readonly now: () => number = Date.now
  ) {}

  observe(event: NormalizedEvent): EvidenceObservation {
    const book = this.bookFor(event.tokenAddress);
    book.active(this.now());
    this.applyEvidence(book, event);
    return this.currentEvidence(event.tokenAddress);
  }

  currentEvidence(tokenAddress: string): EvidenceObservation {
    const book = this.bookFor(tokenAddress);
    const nowMs = this.now();
    const evidence = book.active(nowMs);
    return {
      eligibleForDeepAnalysis: book.hasMinimumEntryEvidence(nowMs),
      evidence
    };
  }

  async classify(
    event: NormalizedEvent,
    knownInfo?: unknown,
    options: RouteClassifyOptions = {}
  ): Promise<RouteEvaluation> {
    const book = this.bookFor(event.tokenAddress);
    const observed = options.eventAlreadyObserved
      ? {
          eligibleForDeepAnalysis: book.hasMinimumEntryEvidence(this.now()),
          evidence: book.active(this.now())
        }
      : this.observe(event);
    let evidence = observed.evidence;
    if (!observed.eligibleForDeepAnalysis && !options.researchOnly)
      return {
        route: null,
        decision: null,
        score: null,
        decisiveTriggerAtMs: null,
        evidenceFamilies: evidence.length,
        evidence,
        features: null,
        observationOnly: false
      };
    const infoStartedAtMs = this.now();
    const info =
      knownInfo === undefined
        ? await this.api.token(
            '/v1/token/info',
            event.tokenAddress,
            options.priority ?? 'candidate'
          )
        : knownInfo;
    const oldEnoughForRevival =
      (tokenAgeMs(info, this.now()) ?? 0) > this.config.strategy.revival_min_age_hours * 3_600_000;
    const [shortKline, revivalKline] = await Promise.all([
      this.kline(event.tokenAddress, '30s', options),
      oldEnoughForRevival ? this.kline(event.tokenAddress, '5m', options) : Promise.resolve(null)
    ]);
    const nowMs = this.now();
    const currentEvidence = this.currentEvidence(event.tokenAddress);
    evidence = currentEvidence.evidence;
    if (!currentEvidence.eligibleForDeepAnalysis && !options.researchOnly)
      return {
        route: null,
        decision: null,
        score: null,
        decisiveTriggerAtMs: null,
        evidenceFamilies: evidence.length,
        evidence,
        features: null,
        observationOnly: false
      };
    const thresholds = {
      dormancyWindowCandles: this.config.strategy.dormancy_window_candles,
      dormancyMaxAverageVolumeUsd: this.config.strategy.dormancy_max_average_volume_usd,
      dormancyMaxAverageSwaps: this.config.strategy.dormancy_max_average_swaps,
      revivalBaselineCandles: this.config.strategy.revival_baseline_candles,
      revivalMinAbsoluteVolumeUsd: this.config.strategy.revival_min_absolute_volume_usd,
      revivalMinAbsoluteSwaps: this.config.strategy.revival_min_absolute_swaps,
      revivalVolumeMultiple: this.config.strategy.revival_volume_multiple,
      revivalSwapsMultiple: this.config.strategy.revival_swaps_multiple,
      breakoutLookbackCandles: this.config.strategy.breakout_lookback_candles,
      breakoutMinimumRate: this.config.strategy.breakout_minimum_rate,
      trendLookbackCandles: this.config.strategy.trend_lookback_candles,
      trendMinimumGrowthRate: this.config.strategy.trend_minimum_growth_rate,
      pullbackMaxRetraceRate: this.config.strategy.pullback_max_retrace_rate,
      pullbackMaxVolumeRatio: this.config.strategy.pullback_max_volume_ratio,
      restartMinimumVolumeRatio: this.config.strategy.restart_minimum_volume_ratio,
      verticalPumpWindowCandles: this.config.strategy.vertical_pump_window_candles,
      verticalPumpMaximumGrowthRate: this.config.strategy.vertical_pump_maximum_growth_rate
    };
    const shortCandles = adaptGmgnCandles(shortKline.value, nowMs);
    const shortSignals = deriveKlineRouteSignals(shortCandles, thresholds);
    const revivalCandles = revivalKline
      ? adaptGmgnCandles(revivalKline.value, nowMs, undefined, 300_000)
      : [];
    const revivalHistory = revivalCandles.filter(
      (c) => c.completed && c.timeMs! + 300_000 <= nowMs - 300_000
    );
    const dormancySample = revivalHistory.slice(-thresholds.dormancyWindowCandles);
    const revivalCoverage =
      dormancySample.length === thresholds.dormancyWindowCandles &&
      dormancySample.every(
        (c, i) => i === 0 || c.timeMs === dormancySample[i - 1]!.timeMs! + 300_000
      ) &&
      nowMs - 300_000 - (dormancySample.at(-1)!.timeMs! + 300_000) < 300_000;
    const revivalSignals = {
      dormant: revivalCoverage && isDormant(revivalHistory, thresholds),
      revivalActivity: rollingRevivalActivity(info, revivalCandles, nowMs, thresholds),
      breakout: shortSignals.breakout
    };
    const features = adaptGmgnRouteFeatures({
      info,
      nowMs,
      evidenceGatePassed: options.researchOnly === true || book.hasMinimumEntryEvidence(nowMs),
      hasCompletedDormancy: revivalSignals.dormant,
      revivalVolumeQualified: revivalSignals.revivalActivity,
      revivalSwapsQualified: revivalSignals.revivalActivity,
      structureBreakout: revivalSignals.breakout,
      additionalRevivalConfirmation: evidence.some(
        (item) => item.family === 'capital' || item.family === 'attention'
      ),
      upwardTrend: shortSignals.upwardTrend,
      healthyPullback: shortSignals.healthyPullback,
      restartVolume: shortSignals.restartVolume,
      smartMoneyExit: false,
      quoteDeteriorated: false,
      verticalPump: shortSignals.verticalPump,
      supportingGrowthObserved: evidence.some(
        (item) => item.family === 'capital' && item.strength === 'strong'
      )
    });
    if (!features)
      return {
        route: null,
        decision: null,
        score: null,
        decisiveTriggerAtMs: null,
        evidenceFamilies: evidence.length,
        evidence,
        features: null,
        observationOnly: false
      };
    const routeThresholds = {
      newLaunchMaxAgeHours: this.config.strategy.new_launch_max_age_hours,
      newLaunchMinLiquidityUsd: this.config.strategy.new_launch_min_liquidity_usd,
      revivalMinAgeHours: this.config.strategy.revival_min_age_hours,
      revivalMinLiquidityUsd: this.config.strategy.revival_min_liquidity_usd,
      continuationMinLiquidityUsd: this.config.strategy.continuation_min_liquidity_usd
    };
    const formalRoute = classifyRoute(features, routeThresholds);
    const route = formalRoute ?? classifyObservationRoute(features, routeThresholds);
    const observationOnly =
      options.researchOnly === true || (formalRoute === null && route !== null);
    if (!route)
      return {
        route: null,
        decision: null,
        score: null,
        decisiveTriggerAtMs: null,
        evidenceFamilies: evidence.length,
        evidence,
        features,
        observationOnly: false
      };
    const completedForSupport = shortCandles.filter((c) => c.completed);
    const priorStructure = completedForSupport
      .slice(0, -1)
      .slice(-thresholds.breakoutLookbackCandles);
    if (priorStructure.length)
      features.supportPriceUsd =
        route === 'revival'
          ? Math.max(...priorStructure.map((c) => c.high))
          : route === 'continuation'
            ? priorStructure.at(-1)!.low
            : Math.min(...completedForSupport.slice(-3).map((c) => c.low));
    const contributions: DimensionContribution[] = [
      { dimension: 'lifecycle', source: 'route', level: route === 'continuation' ? 0.5 : 1 },
      {
        dimension: 'structure',
        source: 'kline',
        level:
          route === 'new_launch'
            ? features.growthObserved && shortSignals.upwardTrend
              ? 1
              : 0
            : route === 'revival'
              ? features.structureBreakout && features.revivalVolumeQualified
                ? 1
                : 0
              : observationOnly
                ? features.structureBreakout && features.upwardTrend
                  ? 1
                  : 0
                : features.healthyPullback && features.restartVolume
                  ? 1
                  : 0
      },
      { dimension: 'quality', source: 'safety', level: 1 },
      { dimension: 'freshness', source: 'info-kline', level: 1 }
    ];
    const flow = marketFlow(info);
    if (
      flow.buyShare1m !== null &&
      flow.buyShare1m > 0.5 &&
      flow.buyShare5m !== null &&
      flow.buyShare5m > 0.5
    )
      contributions.push({ dimension: 'capital', source: 'market_buy_sell', level: 0.5 });
    for (const item of evidence) {
      if (item.family === 'structure') continue;
      const dimension =
        item.family === 'capital'
          ? 'capital'
          : item.family === 'attention'
            ? 'attention'
            : item.family === 'lifecycle'
              ? 'lifecycle'
              : 'structure';
      contributions.push({
        dimension,
        source: item.source,
        level: item.strength === 'strong' ? 1 : 0.5
      });
    }
    const completedCandles = shortCandles.filter((c) => c.completed);
    const required =
      route === 'new_launch'
        ? 3
        : Math.max(thresholds.trendLookbackCandles, thresholds.breakoutLookbackCandles + 1);
    const sample = completedCandles.slice(-required);
    const klineValid =
      sample.length >= required &&
      sample.every((c, i) => i === 0 || c.timeMs === sample[i - 1]!.timeMs! + 30_000) &&
      nowMs - (sample.at(-1)!.timeMs! + 30_000) <= 30_000;
    const score = scoreRoute(
      this.config.scoring.route_weights[route],
      aggregateDimensionLevels(contributions),
      [
        {
          weight: 30,
          available:
            features.priceUsd !== undefined && features.priceUsd > 0 && features.liquidityUsd > 0,
          fresh: isFreshField(
            'info',
            knownInfo === undefined ? infoStartedAtMs : (options.infoObservedAtMs ?? null),
            nowMs,
            this.config.scoring.data_ttl_seconds
          )
        },
        {
          weight: 30,
          available: usablePool(options.pool, info),
          fresh: isFreshField(
            'pool',
            options.poolObservedAtMs ?? null,
            nowMs,
            this.config.scoring.data_ttl_seconds
          )
        },
        {
          weight: 40,
          available: klineValid,
          fresh: isFreshField(
            'kline',
            shortKline.observedAtMs,
            nowMs,
            this.config.scoring.data_ttl_seconds
          )
        }
      ]
    );
    const decisiveTriggerAtMs = book.hasMinimumEntryEvidence(nowMs)
      ? (evidence
          .filter((item) => item.family !== 'attention' && item.sourceTimeKnown !== false)
          .map((item) => item.createdAtMs)
          .sort((left, right) => right - left)[0] ?? null)
      : null;
    const decision = decideRoute(score, evidence.length, decisiveTriggerAtMs, nowMs, route, {
      observationThreshold: this.config.scoring.observation_threshold,
      formalThreshold: this.config.scoring.formal_threshold,
      minimumCompleteness: this.config.scoring.min_completeness,
      decisiveWindowsMs: {
        new_launch: this.config.scoring.decisive_trigger_seconds.new_launch * 1_000,
        revival: this.config.scoring.decisive_trigger_seconds.revival * 1_000,
        continuation: this.config.scoring.decisive_trigger_seconds.continuation * 1_000
      }
    });
    return {
      route,
      decision:
        (observationOnly || !klineValid || score.completeness < 1) && decision === 'formal'
          ? 'observing'
          : decision,
      score,
      decisiveTriggerAtMs,
      evidenceFamilies: evidence.length,
      evidence,
      features,
      observationOnly
    };
  }

  restore(events: readonly NormalizedEvent[]): void {
    for (const event of [...events].sort((left, right) => left.observedAtMs - right.observedAtMs))
      this.applyEvidence(this.bookFor(event.tokenAddress), event);
  }

  applyCreatorHistoryQuality(evaluation: RouteEvaluation, qualityLevel: 0.5 | 1): RouteEvaluation {
    if (!evaluation.route || !evaluation.score || !evaluation.decision) return evaluation;
    const qualityWeight = this.config.scoring.route_weights[evaluation.route].quality ?? 0;
    const requestedPenalty = qualityWeight * (1 - qualityLevel);
    const penalty = Math.min(
      requestedPenalty,
      this.config.security.lazy_deep.creator_history_max_penalty_points
    );
    if (penalty === 0) return evaluation;
    const score = { ...evaluation.score, score: Math.max(0, evaluation.score.score - penalty) };
    const decision = decideRoute(
      score,
      evaluation.evidenceFamilies,
      evaluation.decisiveTriggerAtMs,
      this.now(),
      evaluation.route,
      {
        observationThreshold: this.config.scoring.observation_threshold,
        formalThreshold: this.config.scoring.formal_threshold,
        minimumCompleteness: this.config.scoring.min_completeness,
        decisiveWindowsMs: {
          new_launch: this.config.scoring.decisive_trigger_seconds.new_launch * 1_000,
          revival: this.config.scoring.decisive_trigger_seconds.revival * 1_000,
          continuation: this.config.scoring.decisive_trigger_seconds.continuation * 1_000
        }
      }
    );
    return {
      ...evaluation,
      score,
      decision:
        (evaluation.observationOnly || evaluation.decision !== 'formal') && decision === 'formal'
          ? 'observing'
          : decision
    };
  }

  private bookFor(tokenAddress: string): EvidenceBook {
    const key = tokenAddress.toLowerCase();
    const existing = this.#evidenceByToken.get(key);
    if (existing) return existing;
    const created = new EvidenceBook();
    this.#evidenceByToken.set(key, created);
    return created;
  }

  private async kline(
    tokenAddress: string,
    resolution: '30s' | '5m',
    options: RouteClassifyOptions
  ): Promise<{ value: unknown; observedAtMs: number }> {
    const key = `${tokenAddress.toLowerCase()}:${resolution}`;
    const cached = this.#klineCache.get(key);
    const nowMs = this.now();
    const reuseMs = Math.min(
      (this.config.polling?.observation_seconds ?? 30) * 1_000,
      this.config.scoring.data_ttl_seconds.kline * 1_000
    );
    if (!options.forceKline && cached && nowMs - cached.observedAtMs < reuseMs) return cached;
    const value = await this.api.kline(
      tokenAddress,
      resolution,
      undefined,
      options.priority ?? 'candidate'
    );
    const result = { value, observedAtMs: nowMs };
    this.#klineCache.set(key, result);
    return result;
  }

  private applyEvidence(book: EvidenceBook, event: NormalizedEvent): void {
    if (
      event.decisionEligible === false ||
      (event.source === 'signal' && event.payload.mapping_version === null)
    )
      return;
    if (event.payload.contrary === true) {
      book.invalidate(event.evidenceFamily);
      return;
    }
    const narrative = false;
    const createdAtMs = event.sourceEventAtMs ?? event.observedAtMs;
    book.add({
      id: event.key,
      family: event.evidenceFamily,
      score: event.strength === 'strong' ? 1 : 0.5,
      strength: event.strength,
      createdAtMs,
      expiresAtMs: Math.min(
        event.expiresAtMs,
        createdAtMs +
          evidenceTtlMs(event.evidenceFamily, narrative, this.config.evidence.ttl_seconds)
      ),
      source: event.source,
      sourceTimeKnown: event.sourceEventAtMs !== null,
      narrative
    });
  }
}
