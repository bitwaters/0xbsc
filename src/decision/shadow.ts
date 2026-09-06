import type { RouteEvaluation } from './runtime.js';
import { marketFlow } from './flow.js';
export interface ShadowPolicy {
  enabled: boolean;
  minimum_buy_share: number;
  confirmations: number;
  minimum_spacing_seconds: number;
  max_sample_age_seconds: number;
  formal_threshold: number;
  early_age_minutes: number;
  early_observe_only: boolean;
  soft_failure_grace_seconds: number;
  prewatch_hot_capacity: number;
  prewatch_capacity: number;
  prewatch_seconds: number;
  prewatch_expiry_minutes: number;
  queue_capacity: number;
  queue_concurrency: number;
}
interface FlowSample {
  atMs: number;
  share: number;
  price: number;
}
export class ShadowEvaluator {
  readonly triggers = new Map<string, { atMs: number; active: boolean }>();
  readonly samples = new Map<string, FlowSample[]>();
  constructor(private readonly policy: ShadowPolicy) {}
  evaluate(token: string, info: unknown, evaluation: RouteEvaluation | null, nowMs: number) {
    const flow = marketFlow(info),
      key = token.toLowerCase(),
      p = this.policy;
    const history = (this.samples.get(key) ?? []).filter(
      (s) => nowMs - s.atMs <= p.max_sample_age_seconds * 1000
    );
    if (
      flow.buyShare1m !== null &&
      flow.priceUsd !== null &&
      (!history.length || nowMs - history.at(-1)!.atMs >= p.minimum_spacing_seconds * 1000)
    )
      history.push({ atMs: nowMs, share: flow.buyShare1m, price: flow.priceUsd });
    this.samples.set(key, history.slice(-p.confirmations));
    for (const [k, v] of this.samples)
      if (nowMs - (v.at(-1)?.atMs ?? 0) > p.max_sample_age_seconds * 1000) {
        this.samples.delete(k);
        this.triggers.delete(k);
      }
    const sample = history.slice(-p.confirmations),
      f = evaluation?.features;
    const sustained =
      sample.length >= p.confirmations &&
      sample.every((s) => s.share >= p.minimum_buy_share) &&
      flow.buyShare5m !== null &&
      flow.buyShare5m >= 0.5;
    const structure =
      !!f &&
      (evaluation?.route === 'new_launch'
        ? f.growthObserved && f.upwardTrend
        : evaluation?.route === 'revival'
          ? f.structureBreakout && f.revivalVolumeQualified
          : f.healthyPullback && f.restartVolume);
    const holding = sample.length >= p.confirmations && sample.at(-1)!.price >= sample[0]!.price;
    const data = !!evaluation?.score && evaluation.score.completeness === 1;
    const signalActive = data && structure && sustained && holding;
    const previousTrigger = this.triggers.get(key);
    const triggerAtMs = signalActive
      ? previousTrigger?.active
        ? previousTrigger.atMs
        : sample.at(-1)!.atMs
      : null;
    this.triggers.set(key, { atMs: triggerAtMs ?? nowMs, active: signalActive });
    const triggerFresh =
      triggerAtMs !== null && nowMs - triggerAtMs <= p.max_sample_age_seconds * 1000;
    const early = !!f && f.ageMs < p.early_age_minutes * 60_000;
    const reasons = [
      !data ? 'data_incomplete' : null,
      !structure ? 'structure_unconfirmed' : null,
      !sustained ? 'flow_unconfirmed' : null,
      !holding ? 'price_not_holding' : null,
      early && p.early_observe_only ? 'early_observation_only' : null,
      !triggerFresh ? 'no_fresh_market_trigger' : null
    ].filter((r): r is string => r !== null);
    // Quote cost and lazy background quality are not invented before those gates run.
    const score =
      (structure ? 30 : 0) +
      (sustained ? 30 : 0) +
      (holding ? 20 : 0) +
      (evaluation?.evidence.some((e) => e.family === 'attention') ? 5 : 0);
    return {
      version: 'shadow-v2',
      legacyDecision: evaluation?.decision ?? null,
      decisiveTriggerAtMs: triggerAtMs,
      route: evaluation?.route ?? null,
      flow,
      score,
      candidateQualified: reasons.length === 0 && score >= p.formal_threshold,
      deliveryQualified: false,
      watchPriority:
        data && structure && flow.buyShare1m !== null && flow.buyShare1m >= p.minimum_buy_share,
      pendingGates: ['lazy_safety', 'executable_quote', 'pre_send_revalidation'],
      reasons,
      samples: sample,
      features: f ?? null
    };
  }
}
