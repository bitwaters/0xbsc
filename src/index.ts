import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { LimiterStateFile } from './gmgn/limiter-state.js';
import { withGmgnContext } from './gmgn/context.js';
import { loadRuntimeConfig } from './config/load.js';
import { randomUUID } from 'node:crypto';
import { DiscoveryRuntime } from './discovery/runtime.js';
import { LatestKeyedSerialExecutor } from './discovery/events.js';
import type { NormalizedEvent } from './discovery/events.js';
import { GmgnApi, ScheduledCandidateGmgnApi } from './gmgn/api.js';
import { GmgnClient, GmgnError, gmgnRetryDeadline } from './gmgn/client.js';
import { GmgnScheduler, type Clock, type Priority } from './gmgn/scheduler.js';
import { preSendMarketRejection, preSendRejection } from './decision/pre-send.js';
import { runCandidateScope } from './decision/candidate-scope.js';
import { ShadowEvaluator } from './decision/shadow.js';
import { RouteRuntime } from './decision/runtime.js';
import { staggeredEvaluationAtMs } from './decision/episode-policy.js';
import { episodeExpiryAtMs } from './decision/episode-policy.js';
import { routeResetSatisfied } from './decision/episode.js';
import { freshQuoteCapacity, QuoteGateRuntime } from './quote/runtime.js';
import { finalFreshnessDecision, quoteAllowsDelivery } from './quote/gate.js';
import { SafetyRuntime } from './safety/runtime.js';
import { LazySafetyRuntime } from './safety/lazy-runtime.js';
import { Storage } from './storage/database.js';
import { ResearchRecorder } from './research/recorder.js';
import { ResearchRuntime, loadResearchModel } from './research/runtime.js';
import { researchBudgetContractHash } from './research/budget-check.js';
import { riskPolicyHash } from './decision/preparation.js';
import { protocolHash } from './research/protocol.js';
import type { MarketFact } from './gmgn/facts.js';
import { PublicationGuard } from './delivery/publication-guard.js';
import { TelegramClient } from './delivery/telegram.js';
import { TelegramCallbackHandler, TelegramLongPoller } from './delivery/callbacks.js';
import { OutboxDeliveryService } from './delivery/outbox.js';
import type { PendingOutboxSignal } from './storage/database.js';
import { extractGmgnPresentation } from './delivery/gmgn-presentation.js';
import { buttonLabelsFromConfig, formatRichSignal, inlineKeyboard } from './delivery/template.js';
import { scheduleEvaluationTasks } from './evaluation/tasks.js';
import { capturePostConfirmationEntryQuotes } from './evaluation/entry.js';
import { GmgnQuoteProvider } from './quote/gmgn-provider.js';
import { fetchMarketPath } from './evaluation/market-path.js';
import { captureOutcomeCheckpoint } from './evaluation/checkpoint.js';
import { evaluateAndStoreOutcome } from './evaluation/outcomes.js';
import { OperationTimeline } from './observability/timeline.js';
import { apiMetricEndpoint, MetricsCollector } from './observability/metrics.js';
import { chooseBudgetAction } from './gmgn/degradation.js';
import { Decimal } from 'decimal.js';

const configPath = process.argv[2] ?? `${process.env.HOME}/.config/gmgn-signal-bot/config.yaml`;
const loaded = await loadRuntimeConfig(configPath);
const researchModel = loadResearchModel(loaded.config);
const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random
};
const storage = await Storage.open(loaded.config.storage.sqlite_path);
const researchRecorder =
  loaded.config.research && loaded.config.research.mode !== 'off'
    ? new ResearchRecorder(storage, loaded.config.research, (reason) =>
        console.error(JSON.stringify({ event: 'research_recording_stopped', reason }))
      )
    : null;
await researchRecorder?.start(
  clock.now(),
  loaded.config.research && ['collect', 'execute_shadow'].includes(loaded.config.research.mode)
    ? {
        ...loaded.config.research,
        modelHash: researchModel?.hash ?? null,
        riskHash: riskPolicyHash(loaded.config),
        budgetContractHash: researchBudgetContractHash(),
        marketProtocolHash: protocolHash('post_confirmation_market_v1'),
        quoteProtocolHash: protocolHash('post_confirmation_quote_v1')
      }
    : undefined
);
const repairTasks = await storage.requeueIncompletePaths(Date.now());
if (repairTasks)
  console.log(JSON.stringify({ event: 'historical_path_repairs_queued', count: repairTasks }));
const metrics = new MetricsCollector();
await storage.recordConfigRevision(loaded.revisionId, loaded.sanitizedSnapshot, clock.now());
await storage.expireOutdatedConfiguration(loaded.revisionId, clock.now());
const recoveredReady = await storage.recoverReadyCandidates(
  clock.now(),
  loaded.config.observation.expiry_minutes
);
if (recoveredReady)
  console.log(JSON.stringify({ event: 'ready_candidates_recovered', count: recoveredReady }));
const limiterState = new LimiterStateFile(
  join(dirname(loaded.config.storage.sqlite_path), 'gmgn-limiter-state.json'),
  loaded.config.gmgn.base_url,
  loaded.config.gmgn.api_key
);
const scheduler = new GmgnScheduler(
  clock,
  loaded.config.gmgn.rate_limit.soft_weight_per_second,
  loaded.config.gmgn.rate_limit.hard_weight_per_second,
  loaded.config.gmgn.rate_limit.burst_reserve_weight,
  {
    paced: true,
    researchEnabled: ['collect', 'execute_shadow'].includes(loaded.config.research?.mode ?? 'off'),
    maxConcurrent: loaded.config.gmgn.rate_limit.max_in_flight ?? 4,
    channelIntervalsMs: { quote: loaded.config.gmgn.rate_limit.quote_min_interval_ms ?? 600 },
    channelCompletionIntervalsMs: {
      quote: loaded.config.gmgn.rate_limit.quote_completion_gap_ms ?? 1000
    },
    initialState: limiterState.read(),
    persistState: (state) => limiterState.save(state)
  }
);
scheduler.setResearchMonitoringHealthy(false);
const api = new GmgnApi(
  new GmgnClient({
    baseUrl: loaded.config.gmgn.base_url,
    apiKey: loaded.config.gmgn.api_key,
    scheduler,
    weights: loaded.config.gmgn.endpoint_weights,
    missingResetDelayMs: (loaded.config.gmgn.rate_limit.missing_reset_delay_seconds ?? 30) * 1000,
    ...(researchRecorder
      ? {
          onFact: (fact: MarketFact) => researchRecorder.fact(fact),
          onFactError: () => researchRecorder.stop('FACT_CONTRACT_FAILED')
        }
      : {}),
    onObservation: (observation) => {
      if (
        observation.attempt?.priority === 'formal' &&
        observation.attempt.startedAtMs - observation.attempt.queuedAtMs > 3000
      )
        scheduler.setResearchMonitoringHealthy(false);
      const endpoint = apiMetricEndpoint(observation.input.path);
      void storage
        .recordApiObservation({
          endpoint,
          occurredAtMs: observation.occurredAtMs,
          weight: observation.attempt!.weight,
          status: observation.status,
          latencyMs: observation.latencyMs,
          kind: observation.kind,
          retryCount: observation.retryCount,
          ...(observation.attempt ? { attempt: observation.attempt } : {}),
          ...(observation.detail === undefined ? {} : { detail: observation.detail })
        })
        .catch(() => {
          scheduler.setResearchMonitoringHealthy(false);
          console.error(JSON.stringify({ event: 'api_audit_write_failed' }));
        });
      if (observation.kind === 'rate_limit')
        console.error(
          JSON.stringify({ event: 'gmgn_rate_limit', endpoint, attempt: observation.attempt })
        );
    }
  }),
  loaded.config.quote.max_age_seconds * 1000,
  () => clock.now()
);
const candidateApi = new ScheduledCandidateGmgnApi(
  api,
  scheduler,
  clock,
  loaded.config.gmgn.endpoint_weights
);
const researchRuntime =
  researchRecorder && ['collect', 'execute_shadow'].includes(researchRecorder.config.mode)
    ? new ResearchRuntime(researchRecorder, loaded.config, api, clock)
    : null;
await researchRuntime?.start();
const researchTimer = researchRuntime
  ? setInterval(() => {
      void researchRuntime.tick().catch(() => researchRecorder?.stop('RESEARCH_RUNTIME_FAILED'));
    }, 1000)
  : null;
const safety = new SafetyRuntime(loaded.config, candidateApi, () => clock.now());
const lazySafety = new LazySafetyRuntime(loaded.config, candidateApi, () => clock.now());
const routes = new RouteRuntime(loaded.config, candidateApi, () => clock.now());
const quotes = new QuoteGateRuntime(loaded.config, candidateApi, () => clock.now());
const candidateSerial = new LatestKeyedSerialExecutor();
const shadow = new ShadowEvaluator(loaded.config.optimization);
const processCandidate = (
  event: NormalizedEvent,
  options: {
    priority?: Priority;
    forceKline?: boolean;
    observationEpisodeId?: string;
    researchOnly?: boolean;
  } = {}
) => {
  const timeline = new OperationTimeline(storage, undefined, () => clock.now());
  void timeline.record('source_event', { eventKey: event.key, tokenAddress: event.tokenAddress });
  const precheck = safety.precheck(event);
  const evidenceObservation =
    precheck.allowed && !options.researchOnly ? routes.observe(event) : null;
  return candidateSerial.enqueue(event.tokenAddress, () =>
    runCandidateScope(
      storage,
      event,
      {
        researchOnly: options.researchOnly ?? false,
        correlationId: timeline.correlationId,
        now: () => clock.now()
      },
      async () => {
        await timeline.record('queue', { tokenAddress: event.tokenAddress });
        if (!precheck.allowed) {
          if (options.researchOnly) await storage.removeCandidateWatch(event.tokenAddress);
          if (precheck.rejectionReason === 'unmapped_signal_type') {
            await timeline.record('decision', {
              decision: 'ignored',
              reason: 'unmapped_signal_type'
            });
            return;
          }
          await storage.recordSentRisk(
            event.tokenAddress,
            'failed',
            precheck.rejectionReason,
            clock.now()
          );
          metrics.increment('safetyRejected');
          if (options.observationEpisodeId)
            await storage.rejectEpisodeSafetyGate({
              episodeId: options.observationEpisodeId,
              reason: precheck.rejectionReason ?? 'precheck_rejected',
              snapshot: { event: event.payload },
              nowMs: clock.now()
            });
          await timeline.record('decision', {
            decision: 'rejected',
            reason: precheck.rejectionReason
          });
          return;
        }
        if (!evidenceObservation?.eligibleForDeepAnalysis && !options.researchOnly) {
          if (
            loaded.config.optimization.enabled &&
            event.decisionEligible !== false &&
            event.payload.contrary !== true
          )
            await storage.watchCandidate(
              event,
              clock.now(),
              loaded.config.optimization.prewatch_capacity,
              loaded.config.optimization.prewatch_expiry_minutes * 60_000,
              loaded.config.optimization.prewatch_seconds * 1000,
              'insufficient_evidence'
            );
          if (options.observationEpisodeId)
            await storage.holdObservation(
              options.observationEpisodeId,
              'evidence_expired',
              clock.now(),
              loaded.config.optimization.soft_failure_grace_seconds * 1000
            );
          await timeline.record('decision', {
            decision: 'insufficient_evidence',
            evidenceFamilies: evidenceObservation?.evidence.map((item) => item.family) ?? []
          });
          return;
        }
        let result = await safety.process(event, { priority: options.priority ?? 'candidate' });
        if (result.allowed && !result.usedCache) metrics.increment('deepAnalyses');
        if (!result.allowed) {
          if (options.researchOnly) await storage.removeCandidateWatch(event.tokenAddress);
          metrics.increment('safetyRejected');
          await storage.recordSentRisk(
            event.tokenAddress,
            'failed',
            result.rejectionReason,
            clock.now()
          );
        }
        await timeline.record('api_batch', { safetyAllowed: result.allowed });
        if (!result.allowed && options.observationEpisodeId) {
          await storage.rejectEpisodeSafetyGate({
            episodeId: options.observationEpisodeId,
            reason: result.rejectionReason ?? 'safety_rejected',
            snapshot: { event: event.payload, safety: result },
            nowMs: clock.now()
          });
          await timeline.record('decision', {
            decision: 'rejected',
            reason: result.rejectionReason ?? 'safety_rejected'
          });
          return;
        }
        const preliminaryEvaluation = result.allowed
          ? await routes.classify(event, result.info, {
              eventAlreadyObserved: true,
              ...(options.researchOnly ? { researchOnly: true } : {}),
              infoObservedAtMs: result.assessedAtMs,
              pool: result.pool,
              poolObservedAtMs: result.assessedAtMs,
              priority: options.priority ?? 'candidate',
              ...(options.forceKline === undefined ? {} : { forceKline: options.forceKline })
            })
          : null;
        if (loaded.config.optimization.enabled && result.allowed) {
          const shadowDecision = shadow.evaluate(
            event.tokenAddress,
            result.info,
            preliminaryEvaluation,
            clock.now()
          );
          await storage.recordShadowDecision(
            event.tokenAddress,
            options.observationEpisodeId ?? null,
            loaded.revisionId,
            clock.now(),
            shadowDecision
          );
          if (options.researchOnly)
            await storage.updateWatchSnapshot(
              event.tokenAddress,
              clock.now(),
              shadowDecision,
              shadowDecision.watchPriority,
              loaded.config.optimization.prewatch_hot_capacity,
              loaded.config.optimization.minimum_spacing_seconds * 1000,
              loaded.config.optimization.prewatch_seconds * 1000
            );
        }
        if (options.researchOnly) return;
        const lazyGate =
          preliminaryEvaluation?.decision === 'formal' && result.info !== undefined
            ? await lazySafety.evaluate(event.tokenAddress, result.info)
            : null;
        const waitingForTraderBaseline =
          lazyGate?.allowed === false && lazyGate.reason?.startsWith('trader_') === true;
        const evaluation =
          waitingForTraderBaseline && preliminaryEvaluation
            ? { ...preliminaryEvaluation, decision: 'observing' as const }
            : preliminaryEvaluation && lazyGate?.allowed && lazyGate.creatorHistory
              ? routes.applyCreatorHistoryQuality(
                  preliminaryEvaluation,
                  lazyGate.creatorHistory.qualityLevel
                )
              : preliminaryEvaluation;
        if (options.observationEpisodeId && !evaluation?.route) {
          const evidenceStillEligible = routes.currentEvidence(
            event.tokenAddress
          ).eligibleForDeepAnalysis;
          const held = await storage.holdObservation(
            options.observationEpisodeId,
            evidenceStillEligible ? 'route_no_longer_qualified' : 'evidence_expired',
            clock.now(),
            loaded.config.optimization.soft_failure_grace_seconds * 1000
          );
          await timeline.record('decision', {
            decision: held ? 'observing' : 'observation_expired',
            reason: evidenceStillEligible ? 'route_no_longer_qualified' : 'evidence_expired',
            features: evaluation?.features ?? null,
            evidence: evaluation?.evidence ?? []
          });
          return;
        }
        const creatorScoreAdjustment =
          preliminaryEvaluation?.score && evaluation?.score && lazyGate?.creatorHistory
            ? {
                baseScore: preliminaryEvaluation.score.score,
                adjustedScore: evaluation.score.score,
                penalty: preliminaryEvaluation.score.score - evaluation.score.score,
                ...lazyGate.creatorHistory
              }
            : null;
        if (!evaluation?.route && loaded.config.optimization.enabled && result.allowed)
          await storage.watchCandidate(
            event,
            clock.now(),
            loaded.config.optimization.prewatch_capacity,
            loaded.config.optimization.prewatch_expiry_minutes * 60_000,
            loaded.config.optimization.prewatch_seconds * 1000,
            'route_not_formed'
          );
        const route = evaluation?.route ?? null;
        const episodeId = route ? randomUUID() : null;
        const episode = route
          ? await storage.claimEpisode({
              id: episodeId!,
              tokenAddress: event.tokenAddress,
              route,
              configRevisionId: loaded.revisionId,
              nowMs: clock.now(),
              triggerAtMs: evaluation?.decisiveTriggerAtMs ?? null,
              decisiveWindowMs: loaded.config.scoring.decisive_trigger_seconds[route] * 1_000,
              resetSatisfied:
                evaluation?.features !== null && evaluation?.features !== undefined
                  ? routeResetSatisfied(route, {
                      hasCompletedDormancy: evaluation.features.hasCompletedDormancy,
                      hasHealthyPullbackAndRestart:
                        evaluation.features.healthyPullback && evaluation.features.restartVolume
                    })
                  : false,
              reentryCooldownMsByReason: {
                coordinated_smart_money_exit: loaded.config.scoring.data_ttl_seconds.traders * 1000,
                coordinated_smart_money_exit_unverified:
                  loaded.config.scoring.data_ttl_seconds.traders * 1_000,
                concentrated_holdings_unverified:
                  loaded.config.scoring.data_ttl_seconds.holders * 1_000,
                ...Object.fromEntries(
                  [
                    'holders_list_invalid',
                    'holders_list_empty',
                    'holders_duplicate_address',
                    'holders_wallets_missing',
                    'holders_pool_identity_missing',
                    'holders_address_missing',
                    'holders_share_invalid',
                    'holders_suspicious_flag_missing',
                    'holders_single_wallet_limit',
                    'holders_suspicious_total_limit'
                  ].map((reason) => [reason, loaded.config.scoring.data_ttl_seconds.holders * 1000])
                ),
                creator_direct_hold_unverified:
                  loaded.config.scoring.data_ttl_seconds.creator * 1_000,
                creator_history_unverified: loaded.config.scoring.data_ttl_seconds.creator * 1_000,
                creator_abuse_unverified: loaded.config.scoring.data_ttl_seconds.creator * 1_000
              }
            })
          : null;
        const activeEpisodeId =
          episode === 'created'
            ? episodeId
            : route
              ? await storage.activeEpisodeId(event.tokenAddress, route)
              : null;
        if (options.observationEpisodeId && activeEpisodeId !== options.observationEpisodeId)
          await storage.expireObservation(
            options.observationEpisodeId,
            'route_changed',
            clock.now()
          );
        const observationAdmission =
          activeEpisodeId && route && evaluation?.decision === 'observing' && evaluation.score
            ? await storage.admitObservation({
                episodeId: activeEpisodeId,
                route,
                score: evaluation.score.score,
                completeness: evaluation.score.completeness,
                evidenceFreshness: evaluation.evidence.length,
                capacity: loaded.config.observation.max_active_episodes,
                softRouteTarget: loaded.config.observation.soft_route_target,
                nextEvaluationAtMs: staggeredEvaluationAtMs(clock.now(), event.tokenAddress, route),
                expiresAtMs: episodeExpiryAtMs(
                  clock.now(),
                  route,
                  loaded.config.observation.expiry_minutes,
                  evaluation.evidence.some((item) => item.narrative)
                ),
                nowMs: clock.now()
              })
            : null;
        if (activeEpisodeId && route && evaluation?.decision === 'rejected')
          await storage.rescheduleObservation(
            activeEpisodeId,
            staggeredEvaluationAtMs(clock.now(), event.tokenAddress, route),
            clock.now()
          );
        if (activeEpisodeId && evaluation?.decision && evaluation.score)
          if (observationAdmission?.admitted !== false)
            await storage.recordEpisodeDecision({
              episodeId: activeEpisodeId,
              decision: evaluation.decision,
              score: evaluation.score.score,
              completeness: evaluation.score.completeness,
              decisiveTriggerAtMs: evaluation.decisiveTriggerAtMs,
              readyReevaluationAtMs: clock.now() + loaded.config.polling.observation_seconds * 1000,
              readyExpiresAtMs: episodeExpiryAtMs(
                clock.now(),
                route!,
                loaded.config.observation.expiry_minutes,
                evaluation.evidence.some((item) => item.narrative)
              ),
              featureSnapshot: {
                features: evaluation.features,
                evidence: evaluation.evidence,
                creator_history: creatorScoreAdjustment
              },
              nowMs: clock.now()
            });
          else
            await storage.rejectEpisodeSafetyGate({
              episodeId: activeEpisodeId,
              reason: 'observation_capacity_rejected',
              snapshot: {
                features: evaluation.features,
                evidence: evaluation.evidence,
                creator_history: creatorScoreAdjustment
              },
              nowMs: clock.now()
            });
        await timeline.record('decision', {
          route: evaluation?.route ?? null,
          decision: evaluation?.decision ?? null,
          score: evaluation?.score?.score ?? null,
          observationOnly: evaluation?.observationOnly ?? false,
          features: evaluation?.features ?? null,
          evidence: evaluation?.evidence ?? [],
          creatorHistory: creatorScoreAdjustment,
          episodeAdmission: episode,
          lazySafety: lazyGate
            ? {
                allowed: lazyGate.allowed,
                reason: lazyGate.reason,
                holderDiagnostics: lazyGate.holderDiagnostics
              }
            : null
        });
        if (
          activeEpisodeId &&
          evaluation?.score &&
          evaluation.decision !== 'formal' &&
          result.allowed
        ) {
          await storage.preserveUnsentEvaluationContext({
            episodeId: activeEpisodeId,
            rejectionReason: evaluation.decision ?? 'not_formal',
            featureSnapshot: {
              features: evaluation.features,
              evidence: evaluation.evidence,
              creator_history: creatorScoreAdjustment
            },
            configRevisionId: loaded.revisionId,
            nowMs: clock.now()
          });
          await scheduleEvaluationTasks(storage, {
            episodeId: activeEpisodeId,
            signalId: null,
            score: evaluation.score.score,
            hardSafetyPassed: true,
            formal: false,
            narrative: evaluation.evidence.some((item) => item.narrative),
            fromMs: clock.now(),
            checkpointsMinutes: loaded.config.evaluation.checkpoints_minutes,
            narrativeCheckpointsMinutes: loaded.config.evaluation.narrative_checkpoints_minutes,
            maxUnsentTrackingMinutes: loaded.config.evaluation.unsent_tracking_minutes
          });
        }
        if (activeEpisodeId && lazyGate && !lazyGate.allowed && !waitingForTraderBaseline) {
          const lazySnapshot = {
            features: evaluation?.features,
            evidence: evaluation?.evidence,
            lazy_safety: lazyGate,
            creator_history: creatorScoreAdjustment
          };
          await storage.rejectEpisodeSafetyGate({
            episodeId: activeEpisodeId,
            reason: lazyGate.reason ?? 'lazy_safety_rejected',
            snapshot: lazySnapshot,
            nowMs: clock.now()
          });
          if (evaluation?.score) {
            await storage.preserveUnsentEvaluationContext({
              episodeId: activeEpisodeId,
              rejectionReason: lazyGate.reason ?? 'lazy_safety_rejected',
              featureSnapshot: lazySnapshot,
              configRevisionId: loaded.revisionId,
              nowMs: clock.now()
            });
            await scheduleEvaluationTasks(storage, {
              episodeId: activeEpisodeId,
              signalId: null,
              score: evaluation.score.score,
              hardSafetyPassed: true,
              formal: false,
              narrative: evaluation.evidence.some((item) => item.narrative),
              fromMs: clock.now(),
              checkpointsMinutes: loaded.config.evaluation.checkpoints_minutes,
              narrativeCheckpointsMinutes: loaded.config.evaluation.narrative_checkpoints_minutes,
              maxUnsentTrackingMinutes: loaded.config.evaluation.unsent_tracking_minutes
            });
          }
        }
        const market =
          evaluation?.features?.priceUsd === undefined
            ? undefined
            : {
                priceUsd: evaluation.features.priceUsd,
                liquidityUsd: evaluation.features.liquidityUsd
              };
        let quote =
          activeEpisodeId && evaluation?.decision === 'formal' && lazyGate?.allowed
            ? await quotes.evaluate(event.tokenAddress, market)
            : null;
        const evaluateFinalFreshness = () =>
          quote && result.assessedAtMs !== undefined && evaluation?.decisiveTriggerAtMs != null
            ? finalFreshnessDecision({
                nowMs: clock.now(),
                securityAtMs: result.assessedAtMs,
                poolAtMs: result.assessedAtMs,
                quoteAtMs: quote.quotedAtMs,
                triggerAtMs: evaluation.decisiveTriggerAtMs,
                securityPoolMaxAgeMs: loaded.config.quote.security_pool_max_age_seconds * 1_000,
                quoteMaxAgeMs: loaded.config.quote.max_age_seconds * 1_000,
                decisiveWindowMs: route
                  ? loaded.config.scoring.decisive_trigger_seconds[route] * 1_000
                  : 0
              })
            : null;
        let finalFreshness = evaluateFinalFreshness();
        for (
          let refreshCount = 0;
          activeEpisodeId &&
          quote &&
          refreshCount < 3 &&
          (finalFreshness === 'refresh_security_pool' || finalFreshness === 'refresh_quote');
          refreshCount += 1
        ) {
          if (finalFreshness === 'refresh_security_pool')
            result = await safety.process(event, { force: true, priority: 'formal' });
          else quote = await quotes.evaluate(event.tokenAddress, market, { force: true });
          if (!result.allowed) break;
          finalFreshness = evaluateFinalFreshness();
        }
        const finalSafetyAllowed = result.allowed && lazyGate?.allowed === true;
        let finalEvidenceAllowed = routes.currentEvidence(event.tokenAddress).evidence.length >= 2;
        const temporaryQuoteAdmission =
          activeEpisodeId &&
          route &&
          evaluation?.score &&
          quote?.temporaryCostFailure &&
          finalSafetyAllowed &&
          finalFreshness === 'fresh'
            ? await storage.admitObservation({
                episodeId: activeEpisodeId,
                route,
                score: evaluation.score.score,
                completeness: evaluation.score.completeness,
                evidenceFreshness: evaluation.evidence.length,
                capacity: loaded.config.observation.max_active_episodes,
                softRouteTarget: loaded.config.observation.soft_route_target,
                nextEvaluationAtMs: staggeredEvaluationAtMs(clock.now(), event.tokenAddress, route),
                expiresAtMs: episodeExpiryAtMs(
                  clock.now(),
                  route,
                  loaded.config.observation.expiry_minutes,
                  evaluation.evidence.some((item) => item.narrative)
                ),
                nowMs: clock.now()
              })
            : null;
        if (quote && !quote.accepted) metrics.increment('quoteRejections');
        if (quote && finalFreshness !== 'fresh') metrics.increment('staleCandidates');
        if (activeEpisodeId && quote && !finalSafetyAllowed)
          await storage.rejectEpisodeSafetyGate({
            episodeId: activeEpisodeId,
            reason: 'final_safety_refresh_rejected',
            snapshot: {
              features: evaluation?.features,
              evidence: evaluation?.evidence,
              lazy_safety: lazyGate,
              creator_history: creatorScoreAdjustment
            },
            nowMs: clock.now()
          });
        else if (activeEpisodeId && quote && finalFreshness !== 'fresh')
          await storage.rejectEpisodeSafetyGate({
            episodeId: activeEpisodeId,
            reason: `final_freshness_${finalFreshness ?? 'unverified'}`,
            snapshot: {
              features: evaluation?.features,
              evidence: evaluation?.evidence,
              quote_gate: quote
            },
            nowMs: clock.now()
          });
        if (activeEpisodeId && quote && temporaryQuoteAdmission?.admitted === false)
          await storage.rejectEpisodeSafetyGate({
            episodeId: activeEpisodeId,
            reason: 'observation_capacity_rejected',
            snapshot: {
              features: evaluation?.features,
              evidence: evaluation?.evidence,
              quote_gate: quote
            },
            nowMs: clock.now()
          });
        else if (activeEpisodeId && quote && finalSafetyAllowed && finalFreshness === 'fresh')
          await storage.recordEpisodeQuoteGate({
            episodeId: activeEpisodeId,
            quoteResult: quote,
            accepted: quote.accepted,
            temporaryCostFailure: quote.temporaryCostFailure,
            nowMs: clock.now()
          });
        finalEvidenceAllowed = routes.currentEvidence(event.tokenAddress).evidence.length >= 2;
        if (
          activeEpisodeId &&
          quote &&
          quoteAllowsDelivery({
            accepted: quote.accepted,
            finalSafetyAllowed: finalSafetyAllowed && finalEvidenceAllowed,
            finalFreshness,
            observationAdmissionRejected: temporaryQuoteAdmission?.admitted === false
          })
        ) {
          const outbox = await storage.createSignalOutbox({
            signalId: randomUUID(),
            episodeId: activeEpisodeId,
            configRevisionId: loaded.revisionId,
            quoteSnapshot: quote,
            decision: {
              correlationId: timeline.correlationId,
              route,
              tokenAddress: event.tokenAddress,
              observedAtMs: event.observedAtMs,
              decision: evaluation?.decision,
              score: evaluation?.score,
              completeness: evaluation?.score?.completeness,
              decisiveTriggerAtMs: evaluation?.decisiveTriggerAtMs,
              features: evaluation?.features,
              evidence: evaluation?.evidence,
              creatorHistory: creatorScoreAdjustment,
              presentation: extractGmgnPresentation({
                infoResponse: result.info,
                discoveryPayload: event.payload,
                nowMs: clock.now()
              })
            },
            nowMs: clock.now()
          });
          await timeline.record('outbox', { signalCreated: outbox === 'created' });
          if (outbox === 'created') void deliverPendingOutbox();
        } else if (
          activeEpisodeId &&
          quote &&
          evaluation?.decision === 'formal' &&
          evaluation.score &&
          finalSafetyAllowed &&
          finalEvidenceAllowed
        ) {
          await storage.preserveUnsentEvaluationContext({
            episodeId: activeEpisodeId,
            rejectionReason:
              temporaryQuoteAdmission?.admitted === false
                ? 'observation_capacity_rejected'
                : !finalEvidenceAllowed
                  ? 'final_evidence_invalidated'
                  : finalFreshness !== 'fresh'
                    ? `final_freshness_${finalFreshness ?? 'unverified'}`
                    : quote.accepted
                      ? 'outbox_not_created'
                      : quote.temporaryCostFailure
                        ? 'quote_cost_temporary'
                        : 'quote_route_unavailable',
            featureSnapshot: {
              features: evaluation.features,
              evidence: evaluation.evidence,
              quote_gate: quote,
              creator_history: creatorScoreAdjustment
            },
            configRevisionId: loaded.revisionId,
            nowMs: clock.now()
          });
          await scheduleEvaluationTasks(storage, {
            episodeId: activeEpisodeId,
            signalId: null,
            score: evaluation.score.score,
            hardSafetyPassed: true,
            formal: false,
            narrative: evaluation.evidence.some((item) => item.narrative),
            fromMs: clock.now(),
            checkpointsMinutes: loaded.config.evaluation.checkpoints_minutes,
            narrativeCheckpointsMinutes: loaded.config.evaluation.narrative_checkpoints_minutes,
            maxUnsentTrackingMinutes: loaded.config.evaluation.unsent_tracking_minutes
          });
        }
        if (
          result.allowed ||
          [
            'unmapped_signal_type',
            'safety_source_unavailable',
            'critical_field_missing',
            'unmapped_security_alert',
            'unmapped_security_flag'
          ].includes(result.rejectionReason ?? '')
        )
          console.log(
            JSON.stringify({
              event: 'safety_assessed',
              token: event.tokenAddress,
              allowed: result.allowed,
              reason: result.rejectionReason,
              route,
              decision: evaluation?.decision ?? null,
              score: evaluation?.score?.score ?? null,
              creator_base_score: creatorScoreAdjustment?.baseScore ?? null,
              creator_history_penalty: creatorScoreAdjustment?.penalty ?? null,
              creator_history_risk: creatorScoreAdjustment?.risk ?? null,
              completeness: evaluation?.score?.completeness ?? null,
              evidence_families: evaluation?.evidence.map((item) => item.family) ?? [],
              route_features:
                evaluation?.features === null || evaluation?.features === undefined
                  ? null
                  : {
                      age_ms: evaluation.features.ageMs,
                      liquidity_usd: evaluation.features.liquidityUsd,
                      first_launch_stage: evaluation.features.firstLaunchStage,
                      valid_pool: evaluation.features.validPool,
                      real_trading: evaluation.features.realTrading,
                      growth_observed: evaluation.features.growthObserved,
                      evidence_gate_passed: evaluation.features.evidenceGatePassed,
                      dormant: evaluation.features.hasCompletedDormancy,
                      revival_activity:
                        evaluation.features.revivalVolumeQualified &&
                        evaluation.features.revivalSwapsQualified,
                      breakout: evaluation.features.structureBreakout,
                      upward_trend: evaluation.features.upwardTrend,
                      healthy_pullback: evaluation.features.healthyPullback,
                      restart_volume: evaluation.features.restartVolume,
                      vertical_pump: evaluation.features.verticalPump
                    },
              quote_accepted: quote?.accepted ?? null,
              lazy_safety_allowed: lazyGate?.allowed ?? null,
              observation_admitted: observationAdmission?.admitted ?? null,
              episode
            })
          );
      }
    ).catch(async (error: unknown) => {
      await timeline.record('decision', {
        decision: 'processing_error',
        reason: error instanceof GmgnError ? error.kind : 'processing_failure',
        retryAtMs: error instanceof GmgnError ? (error.retryAtMs ?? null) : null
      });
      throw error;
    })
  );
};
const telegram = new TelegramClient({ botToken: loaded.config.telegram.bot_token });
const outboxDelivery = new OutboxDeliveryService({
  publicationGuard: new PublicationGuard(storage),
  storage,
  telegram,
  chatId: loaded.config.telegram.chat_ids[0]!,
  render: renderOutboxSignal,
  prepareBeforeDelivery: refreshPendingSignalMarket,
  preparationRetryAt: (error, nowMs) =>
    error instanceof GmgnError ? gmgnRetryDeadline(error, nowMs) : null,
  revalidateBeforeUnknownRetry: revalidateUnknownDelivery,
  outcomeCheckpointsMinutes: loaded.config.evaluation.checkpoints_minutes,
  narrativeOutcomeCheckpointsMinutes: loaded.config.evaluation.narrative_checkpoints_minutes,
  onTrace: async (signal, stage, occurredAtMs) => {
    const correlationId = asRecord(signal.decision).correlationId;
    if (typeof correlationId === 'string')
      await storage.recordOperationTrace({ correlationId, stage, occurredAtMs });
  },
  onConfirmed: (signal, confirmedAtMs) => {
    void researchRuntime
      ?.confirmed(signal, confirmedAtMs)
      .catch(() => researchRecorder?.stop('ACTUAL_BASELINE_CAPTURE_FAILED'));
    return withGmgnContext({ purpose: 'baseline' }, async () => {
      const decision = asRecord(signal.decision);
      const tokenAddress = requiredString(decision.tokenAddress, 'tokenAddress');
      const provider = await GmgnQuoteProvider.create({
        api: candidateApi,
        config: loaded.config,
        tokenAddress
      });
      await capturePostConfirmationEntryQuotes(storage, provider, {
        episodeId: signal.episodeId,
        signalId: signal.id,
        confirmedAtMs,
        sizesUsd: loaded.config.quote.position_usd,
        now: () => clock.now()
      });
    });
  },
  onConfirmedError: (signal, error) =>
    console.error(
      JSON.stringify({
        event: 'post_confirmation_work_failed',
        signal_id: signal.id,
        error: error instanceof Error ? error.message : 'unknown error'
      })
    ),
  now: () => clock.now()
});
const callbackHandler = new TelegramCallbackHandler({
  storage,
  telegram,
  allowedChatIds: loaded.config.telegram.chat_ids,
  allowedUserIds: loaded.config.telegram.allowed_user_ids,
  now: () => clock.now()
});
const telegramPoller = new TelegramLongPoller({ storage, telegram, handler: callbackHandler });
let outboxDeliveryRunning = false;
const discovery = new DiscoveryRuntime({
  config: loaded.config,
  storage,
  api,
  scheduler,
  clock,
  onEvent: processCandidate,
  ...(researchRecorder
    ? { onUniverseObserved: (event: NormalizedEvent) => researchRecorder.event(event) }
    : {}),
  onEventObserved: (_event, persisted) => {
    if (persisted && safety.precheck(_event).allowed) routes.observe(_event);
    metrics.increment('discovered');
    if (!persisted) metrics.increment('deduplicated');
  },
  onEventError: (event, error) =>
    console.error(
      JSON.stringify({
        event: 'event_handler_failed',
        token: event.tokenAddress,
        error: error.message
      })
    )
});
routes.restore(await storage.activeEvidenceEvents(clock.now()));
await discovery.start();
void deliverPendingOutbox();
const outboxDeliveryTimer = setInterval(() => {
  void deliverPendingOutbox();
}, 250);
let telegramPollRunning = false;
const telegramPollTimer = setInterval(() => {
  if (telegramPollRunning) return;
  telegramPollRunning = true;
  void telegramPoller
    .pollOnce()
    .catch((error: unknown) =>
      console.error(
        JSON.stringify({
          event: 'telegram_poll_failed',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      )
    )
    .finally(() => {
      telegramPollRunning = false;
    });
}, 250);
let dueLoopRunning = false;
let gmgnBackgroundBackoffUntilMs = 0;
const dueTimer = setInterval(() => {
  if (dueLoopRunning) return;
  dueLoopRunning = true;
  const nowMs = clock.now();
  void storage
    .expireObservations(nowMs)
    .then(() => storage.dueObservationEvents(nowMs))
    .then(async (events) => {
      const now = clock.now();
      if (now < gmgnBackgroundBackoffUntilMs) return;
      const utilization = schedulerUtilization(now);
      const admitted = await Promise.all(
        events.map(async (event) => {
          const action = chooseBudgetAction({
            kind: 'observation',
            score: event.observationScore ?? 0,
            nowMs: now,
            deadlineMs: event.expiresAtMs,
            utilization
          });
          if (action.action === 'expire') {
            await storage.expireObservations(now);
            return null;
          }
          if (action.reevaluationMultiplier > 1) {
            await storage.rescheduleObservation(
              event.episodeId,
              now +
                loaded.config.polling.observation_seconds * 1_000 * action.reevaluationMultiplier,
              now
            );
            return null;
          }
          return event;
        })
      );
      for (const event of admitted) {
        if (!event) continue;
        try {
          await processCandidate(event, {
            priority: 'observation',
            forceKline: true,
            observationEpisodeId: event.episodeId
          });
        } catch (error) {
          const failedAtMs = clock.now();
          const retryAtMs = gmgnRetryDeadline(error, failedAtMs);
          await storage.rescheduleObservation(event.episodeId, retryAtMs, failedAtMs);
          if (error instanceof GmgnError && error.kind === 'rate_limit')
            gmgnBackgroundBackoffUntilMs = Math.max(gmgnBackgroundBackoffUntilMs, retryAtMs);
          console.error(
            JSON.stringify({
              event: 'observation_reevaluation_failed',
              episode_id: event.episodeId,
              retry_at_ms: retryAtMs,
              error: error instanceof Error ? error.message : 'unknown error'
            })
          );
          if (error instanceof GmgnError && error.kind === 'rate_limit') break;
        }
      }
    })
    .catch((error: unknown) =>
      console.error(
        JSON.stringify({
          event: 'observation_reevaluation_failed',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      )
    )
    .finally(() => {
      dueLoopRunning = false;
    });
}, 250);
let prewatchRunning = false;
const prewatchTimer = setInterval(() => {
  if (prewatchRunning || dueLoopRunning || clock.now() < scheduler.cooldownUntilMs) return;
  prewatchRunning = true;
  void (async () => {
    const now = clock.now();
    if (
      loaded.config.optimization.enabled &&
      schedulerUtilization(clock.now()) < 0.7 &&
      clock.now() >= scheduler.cooldownUntilMs
    ) {
      for (const watch of await storage.dueCandidateWatches(
        now,
        loaded.config.optimization.prewatch_seconds * 1000
      )) {
        try {
          await processCandidate(watch, {
            priority: 'evaluation',
            forceKline: true,
            researchOnly: true
          });
        } catch (error) {
          if (!(error instanceof GmgnError && error.kind === 'rate_limit'))
            await storage.removeCandidateWatch(watch.tokenAddress);
          console.error(
            JSON.stringify({
              event: 'prewatch_failed',
              error: error instanceof Error ? error.message : 'unknown'
            })
          );
        }
      }
    }
  })()
    .catch(() => console.error(JSON.stringify({ event: 'prewatch_loop_failed' })))
    .finally(() => {
      prewatchRunning = false;
    });
}, 1000);
let outcomeLoopRunning = false;
const outcomeTimer = setInterval(() => {
  if (outcomeLoopRunning) return;
  outcomeLoopRunning = true;
  void withGmgnContext({ priority: 'evaluation', purpose: 'outcome' }, () => runDueOutcomeTasks())
    .catch((error: unknown) =>
      console.error(
        JSON.stringify({
          event: 'outcome_checkpoint_failed',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      )
    )
    .finally(() => {
      outcomeLoopRunning = false;
    });
}, 250);
let metricSnapshotRunning = false;
const metricTimer = setInterval(() => {
  if (metricSnapshotRunning) return;
  metricSnapshotRunning = true;
  void storage
    .retainAudit(clock.now(), loaded.config.storage.raw_payload_retention_days)
    .then(() => metrics.snapshot(storage, clock.now()))
    .then((snapshot) => {
      scheduler.setResearchMonitoringHealthy(true);
      console.log(
        JSON.stringify({ event: 'runtime_metrics', ...snapshot, gmgn: scheduler.snapshot() })
      );
    })
    .catch((error: unknown) => {
      scheduler.setResearchMonitoringHealthy(false);
      console.error(
        JSON.stringify({
          event: 'runtime_metrics_failed',
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
    })
    .finally(() => {
      metricSnapshotRunning = false;
    });
}, 60_000);
const writeHealth = () =>
  writeFileSync(
    '/tmp/gmgn-runtime-health.json',
    JSON.stringify({
      atMs: clock.now(),
      revision: loaded.revisionId,
      gmgn: scheduler.snapshot(),
      research: {
        mode: loaded.config.research?.mode ?? 'off',
        runId: loaded.config.research?.run_id ?? null,
        pendingWrites: researchRecorder?.pending ?? 0,
        stoppedReason: researchRecorder?.stoppedReason ?? null,
        newPublisherEnabled: false,
        marketBaseline: 'UNAVAILABLE'
      }
    })
  );
writeHealth();
const healthTimer = setInterval(writeHealth, 5000);
console.log(JSON.stringify({ event: 'discovery_started', revision_id: loaded.revisionId }));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (researchTimer) clearInterval(researchTimer);
    researchRecorder?.close();
    clearInterval(dueTimer);
    clearInterval(telegramPollTimer);
    clearInterval(outboxDeliveryTimer);
    clearInterval(outcomeTimer);
    clearInterval(metricTimer);
    clearInterval(healthTimer);
    clearInterval(prewatchTimer);
    discovery.stop();
    storage.close();
    process.exit(0);
  });

async function deliverPendingOutbox(): Promise<void> {
  if (loaded.config.runtime.mode !== 'live' || outboxDeliveryRunning) return;
  outboxDeliveryRunning = true;
  try {
    await outboxDelivery.recoverAndDeliver();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'outbox_delivery_failed',
        error: error instanceof Error ? error.message : 'unknown error'
      })
    );
  } finally {
    outboxDeliveryRunning = false;
  }
}

async function refreshPendingSignalMarket(
  signal: PendingOutboxSignal
): Promise<PendingOutboxSignal | null> {
  const nowMs = clock.now();
  const decision = asRecord(signal.decision);
  const tokenAddress = requiredString(decision.tokenAddress, 'tokenAddress');
  const route = requiredString(decision.route, 'route');
  const triggerAtMs = requiredNumber(decision.decisiveTriggerAtMs, 'decisiveTriggerAtMs');
  if (route !== 'new_launch' && route !== 'revival' && route !== 'continuation') {
    await storage.recordPreSendCancellation(signal.id, 'pre_send_unknown_route', nowMs);
    return null;
  }
  if (nowMs - triggerAtMs > loaded.config.scoring.decisive_trigger_seconds[route] * 1_000) {
    await storage.recordPreSendCancellation(signal.id, 'pre_send_decisive_trigger_expired', nowMs);
    return null;
  }

  if (!(await revalidateUnknownDelivery(signal))) {
    await storage.recordPreSendCancellation(
      signal.id,
      'pre_send_route_or_safety_invalidated',
      clock.now()
    );
    return null;
  }
  let info = await candidateApi.token('/v1/token/info', tokenAddress, 'formal');
  let fetchedAtMs = clock.now();
  let presentation = extractGmgnPresentation({ infoResponse: info, nowMs: fetchedAtMs });
  const previousPresentation = asRecord(decision.presentation);
  const features = asRecord(decision.features);
  let currentMarket = marketFromPresentation(presentation, features);
  const previousMarket = marketFromPresentation(previousPresentation, features);
  const earlyRejection = preSendMarketRejection({
    info,
    expectedPrice: optionalNumber(features.priceUsd) ?? null,
    supportPrice: optionalNumber(features.supportPriceUsd) ?? null,
    maxRetrace: loaded.config.strategy.pullback_max_retrace_rate,
    nowMs: clock.now(),
    triggerAtMs,
    triggerMaxAgeMs: loaded.config.scoring.decisive_trigger_seconds[route] * 1000
  });
  if (earlyRejection) {
    await storage.recordPreSendCancellation(signal.id, earlyRejection, clock.now());
    return null;
  }
  const previousQuote = asRecord(signal.quoteSnapshot);
  const quotedAtMs = optionalNumber(previousQuote.quotedAtMs);
  const quoteExpired =
    quotedAtMs === undefined ||
    clock.now() - quotedAtMs > loaded.config.quote.max_age_seconds * 1_000;
  const marketChanged = materiallyChanged(previousMarket, currentMarket);

  let quoteSnapshot: unknown = undefined;
  if (quoteExpired || marketChanged) {
    quoteSnapshot = await quotes.evaluate(
      tokenAddress,
      currentMarket === null
        ? undefined
        : {
            priceUsd: Number(currentMarket.priceUsd),
            liquidityUsd: Number(currentMarket.liquidityUsd)
          },
      { force: true, full: marketChanged }
    );
    if (!asRecord(quoteSnapshot).accepted) {
      await storage.recordPreSendCancellation(signal.id, 'pre_send_quote_rejected', clock.now());
      return null;
    }
    info = await candidateApi.token('/v1/token/info', tokenAddress, 'formal');
    fetchedAtMs = clock.now();
    presentation = extractGmgnPresentation({ infoResponse: info, nowMs: fetchedAtMs });
    const postQuoteMarket = marketFromPresentation(presentation, features);
    if (materiallyChanged(currentMarket, postQuoteMarket)) {
      currentMarket = postQuoteMarket;
      quoteSnapshot = await quotes.evaluate(
        tokenAddress,
        currentMarket === null
          ? undefined
          : {
              priceUsd: Number(currentMarket.priceUsd),
              liquidityUsd: Number(currentMarket.liquidityUsd)
            },
        { force: true, full: true }
      );
      if (!asRecord(quoteSnapshot).accepted) {
        await storage.recordPreSendCancellation(signal.id, 'pre_send_quote_rejected', clock.now());
        return null;
      }
      info = await candidateApi.token('/v1/token/info', tokenAddress, 'formal');
      fetchedAtMs = clock.now();
      presentation = extractGmgnPresentation({ infoResponse: info, nowMs: fetchedAtMs });
    }
  }
  const finalQuote = asRecord(quoteSnapshot ?? signal.quoteSnapshot);
  const rejection = preSendRejection({
    info,
    expectedPrice: optionalNumber(features.priceUsd) ?? null,
    supportPrice: optionalNumber(features.supportPriceUsd) ?? null,
    maxRetrace: loaded.config.strategy.pullback_max_retrace_rate,
    nowMs: clock.now(),
    triggerAtMs,
    triggerMaxAgeMs: loaded.config.scoring.decisive_trigger_seconds[route] * 1000,
    securityStartedAtMs: nowMs,
    securityMaxAgeMs: loaded.config.quote.security_pool_max_age_seconds * 1000,
    quoteAtMs: optionalNumber(finalQuote.quotedAtMs) ?? null,
    quoteMaxAgeMs: loaded.config.quote.max_age_seconds * 1000
  });
  if (rejection) {
    await storage.recordPreSendCancellation(signal.id, rejection, clock.now());
    return null;
  }
  quoteSnapshot = {
    ...finalQuote,
    maxSafePosition: freshQuoteCapacity(
      finalQuote,
      clock.now(),
      loaded.config.quote.max_age_seconds * 1000
    )
  };
  return storage.updatePendingSignalMarket(signal.id, presentation, quoteSnapshot, fetchedAtMs);
}

async function runDueOutcomeTasks(): Promise<void> {
  const nowMs = clock.now();
  if (nowMs < gmgnBackgroundBackoffUntilMs) return;
  for (const task of await storage.dueOutcomeTasks(nowMs)) {
    try {
      const budget = chooseBudgetAction({
        kind: 'result',
        nowMs,
        utilization: schedulerUtilization(nowMs)
      });
      if (budget.action === 'postpone') {
        await storage.deferPriceSampleTask(task.taskId, nowMs + 5_000, nowMs);
        continue;
      }
      const match = /^outcome_(\d+)m$/.exec(task.taskKind);
      if (!match) continue;
      const checkpointMinutes = Number(match[1]);
      const entryAtMs = task.entryAtMs;
      if (task.qualityVersion === 'legacy' || !task.entryMarketPrice) {
        await storage.attachOutcomeEvaluation({
          taskId: task.taskId,
          episodeId: task.episodeId,
          signalId: task.signalId,
          checkpointMinutes,
          outcome: {
            quality: task.qualityVersion === 'legacy' ? 'legacy_untrusted' : 'missing_frozen_entry'
          },
          nowMs
        });
        continue;
      }
      const formal = task.signalId !== null;
      const provider = formal
        ? await GmgnQuoteProvider.create({
            api: candidateApi,
            config: loaded.config,
            tokenAddress: task.tokenAddress
          })
        : null;
      const checkpoint = await captureOutcomeCheckpoint(
        storage,
        {
          candles: ({ fromMs, toMs }) =>
            fetchMarketPath(candidateApi, task.tokenAddress, fromMs, toMs, {
              now: () => clock.now(),
              maxRepairRequests: loaded.config.evaluation.path_max_gap_requests ?? 2
            })
        },
        provider ?? {
          buy: () => Promise.reject(new Error('unsent samples have no entry Quote')),
          sell: () => Promise.reject(new Error('unsent samples have no exit Quote'))
        },
        {
          taskId: task.taskId,
          episodeId: task.episodeId,
          signalId: task.signalId,
          formal,
          checkpointMinutes,
          entryAtMs,
          targetAtMs: task.targetAtMs,
          now: () => clock.now()
        }
      );
      const entryMarketPrice = task.entryMarketPrice;
      const endpoint = checkpoint.candles.find(
        (candle) =>
          candle.completed === true &&
          candle.timeMs !== undefined &&
          candle.intervalMs !== undefined &&
          candle.timeMs + candle.intervalMs === task.targetAtMs
      );
      const exitMarketPrice = endpoint?.close ?? null;
      const executable = checkpoint.exitQuotes.find((item) => item.sizeUsd === 10);
      if (!entryMarketPrice) throw new Error('outcome task has no frozen entry market price');
      await evaluateAndStoreOutcome(storage, {
        taskId: task.taskId,
        episodeId: task.episodeId,
        signalId: task.signalId,
        checkpointMinutes,
        entryMarketPrice,
        exitMarketPrice,
        entryExecutableUsd: executable?.entryUsd ?? null,
        exitExecutableUsd:
          checkpoint.exitLate ||
          executable?.late ||
          executable?.quote === null ||
          executable === undefined
            ? null
            : executable.quote.outputUsd,
        candles: checkpoint.candles,
        takeProfit: String(
          task.evaluationPolicy?.take_profit_percent ?? loaded.config.evaluation.take_profit_percent
        ),
        stopLoss: String(
          -(task.evaluationPolicy?.stop_loss_percent ?? loaded.config.evaluation.stop_loss_percent)
        ),
        nowMs: clock.now(),
        pathContext: {
          entryAtMs,
          targetAtMs: task.targetAtMs,
          horizonAtMs: task.horizonAtMs ?? task.targetAtMs
        },
        targetMultiples:
          task.evaluationPolicy?.target_multiples ?? loaded.config.evaluation.target_multiples,
        repairPolicy: {
          attempt: task.pathCaptureAttempts + 1,
          maxAttempts: loaded.config.evaluation.path_max_capture_attempts ?? 3,
          retryDelayMs: (loaded.config.evaluation.path_retry_seconds ?? 30) * 1000
        }
      });
      await storage.recordOperationTrace({
        correlationId: task.signalId ?? `episode:${task.episodeId}`,
        stage: 'result',
        occurredAtMs: clock.now(),
        metadata: { taskKind: task.taskKind }
      });
    } catch (error) {
      const failedAtMs = clock.now();
      const retryAtMs = gmgnRetryDeadline(error, failedAtMs);
      await storage.deferPriceSampleTask(task.taskId, retryAtMs, failedAtMs);
      if (error instanceof GmgnError && error.kind === 'rate_limit')
        gmgnBackgroundBackoffUntilMs = Math.max(gmgnBackgroundBackoffUntilMs, retryAtMs);
      console.error(
        JSON.stringify({
          event: 'outcome_task_failed',
          episode_id: task.episodeId,
          signal_id: task.signalId,
          task_kind: task.taskKind,
          retry_at_ms: retryAtMs,
          error: error instanceof Error ? error.message : 'unknown error'
        })
      );
      if (error instanceof GmgnError && error.kind === 'rate_limit') break;
    }
  }
}

function schedulerUtilization(nowMs: number): number {
  return Math.max(
    1 - scheduler.bucket.available(nowMs) / scheduler.bucket.hardPerSecond,
    Number(scheduler.snapshot().lastSecondWeight) / scheduler.bucket.hardPerSecond
  );
}

function marketFromPresentation(
  presentationValue: unknown,
  fallbackFeaturesValue: unknown
): { priceUsd: string; liquidityUsd: string } | null {
  const presentation = asRecord(presentationValue);
  const fallbackFeatures = asRecord(fallbackFeaturesValue);
  const priceUsd =
    optionalNumericString(presentation.priceUsd) ??
    optionalNumericString(fallbackFeatures.priceUsd);
  const liquidityUsd =
    optionalNumericString(presentation.liquidityUsd) ??
    optionalNumericString(fallbackFeatures.liquidityUsd);
  return priceUsd && liquidityUsd ? { priceUsd, liquidityUsd } : null;
}

function relativeChange(before: string, after: string): Decimal {
  const previous = new Decimal(before);
  const current = new Decimal(after);
  if (!previous.isFinite() || !current.isFinite() || previous.lte(0) || current.lte(0))
    return new Decimal(0);
  return current.minus(previous).abs().div(previous);
}

function materiallyChanged(
  before: { priceUsd: string; liquidityUsd: string } | null,
  after: { priceUsd: string; liquidityUsd: string } | null
): boolean {
  return (
    before !== null &&
    after !== null &&
    (relativeChange(before.priceUsd, after.priceUsd).gte(
      loaded.config.quote.material_price_change_percent
    ) ||
      relativeChange(before.liquidityUsd, after.liquidityUsd).gte(
        loaded.config.quote.material_liquidity_change_percent
      ))
  );
}

async function revalidateUnknownDelivery(signal: PendingOutboxSignal): Promise<boolean> {
  const event = await storage.latestEventForSignal(signal.id);
  if (!event) return false;
  const decision = asRecord(signal.decision);
  const expectedRoute = decision.route;
  if (
    expectedRoute !== 'new_launch' &&
    expectedRoute !== 'revival' &&
    expectedRoute !== 'continuation'
  )
    return false;
  const safetyResult = await safety.process(event, { force: true, priority: 'formal' });
  if (!safetyResult.allowed || safetyResult.info === undefined) return false;
  const preliminaryEvaluation = await routes.classify(event, safetyResult.info, {
    forceKline: true,
    infoObservedAtMs: safetyResult.assessedAtMs,
    pool: safetyResult.pool,
    poolObservedAtMs: safetyResult.assessedAtMs
  });
  if (preliminaryEvaluation.route !== expectedRoute || preliminaryEvaluation.decision !== 'formal')
    return false;
  const lazy = await lazySafety.evaluate(event.tokenAddress, safetyResult.info);
  if (!lazy.allowed || !lazy.creatorHistory) return false;
  return (
    routes.applyCreatorHistoryQuality(preliminaryEvaluation, lazy.creatorHistory.qualityLevel)
      .decision === 'formal'
  );
}

function renderOutboxSignal(signal: PendingOutboxSignal) {
  const decision = asRecord(signal.decision);
  const features = asRecord(decision.features);
  const score = asRecord(decision.score);
  const creatorHistory = asRecord(decision.creatorHistory);
  const presentation = asRecord(decision.presentation);
  const socialLinks = asRecord(presentation.socialLinks);
  const tokenAddress = requiredString(decision.tokenAddress, 'tokenAddress');
  const route = requiredString(decision.route, 'route');
  const observedAtMs = requiredNumber(decision.observedAtMs, 'observedAtMs');
  const evidence = Array.isArray(decision.evidence)
    ? decision.evidence.map((item) => requiredString(asRecord(item).family, 'evidence family'))
    : [];
  const richMessage = formatRichSignal({
    signalId: signal.id,
    route,
    tokenAddress,
    symbol: optionalString(presentation.symbol) ?? tokenAddress.slice(0, 8),
    name: optionalString(presentation.name) ?? 'Unknown token',
    evidence,
    score: requiredNumber(score.score, 'score'),
    completeness: requiredNumber(score.completeness, 'completeness'),
    ...((optionalString(presentation.priceUsd) ?? optionalNumericString(features.priceUsd))
      ? {
          priceUsd:
            optionalString(presentation.priceUsd) ?? optionalNumericString(features.priceUsd)!
        }
      : {}),
    ...(optionalString(presentation.marketCapUsd)
      ? { marketCapUsd: optionalString(presentation.marketCapUsd)! }
      : {}),
    liquidityUsd:
      optionalString(presentation.liquidityUsd) ??
      String(requiredNumber(features.liquidityUsd, 'liquidityUsd')),
    ...(optionalCount(presentation.holderCount) === undefined
      ? {}
      : { holderCount: optionalCount(presentation.holderCount)! }),
    ...(optionalCount(presentation.visitingCount) === undefined
      ? {}
      : { visitingCount: optionalCount(presentation.visitingCount)! }),
    ...((optionalNumber(presentation.ageMs) ?? optionalNumber(features.ageMs)) === undefined
      ? {}
      : { ageMs: optionalNumber(presentation.ageMs) ?? optionalNumber(features.ageMs)! }),
    riskStatus: asRecord(decision.riskStatus),
    risks:
      creatorHistory.risk === 'elevated'
        ? [
            `创建者历史偏弱：累计 ${requiredNumber(creatorHistory.createdTokens, 'creator token count')} 个代币，开放率 ${(requiredNumber(creatorHistory.openRatio, 'creator open ratio') * 100).toFixed(1)}%`
          ]
        : [],
    socialLinks: {
      ...(optionalString(socialLinks.website)
        ? { website: optionalString(socialLinks.website)! }
        : {}),
      ...(optionalString(socialLinks.x) ? { x: optionalString(socialLinks.x)! } : {}),
      ...(optionalString(socialLinks.telegram)
        ? { telegram: optionalString(socialLinks.telegram)! }
        : {})
    },
    observedAtMs,
    renderedAtMs: clock.now()
  });
  return {
    richMessage,
    replyMarkup: inlineKeyboard(
      tokenAddress,
      buttonLabelsFromConfig(loaded.config.telegram.buttons)
    )
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`outbox ${field} is missing`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new Error(`outbox ${field} is missing`);
  return number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalCount(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function optionalNumericString(value: unknown): string | undefined {
  const number = optionalNumber(value);
  return number === undefined ? undefined : String(number);
}
