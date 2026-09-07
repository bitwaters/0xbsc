import { Decimal } from 'decimal.js';
import type { MarketFact } from '../gmgn/facts.js';
import { decimalValue } from '../gmgn/facts.js';
import {
  measurementProtocol as p,
  outcomes,
  type BaselineTrack,
  type Outcome
} from './protocol.js';

export interface BaselineValue {
  status: 'PENDING' | 'VALID' | 'UNVERIFIED' | 'MISSING';
  reason: string;
  price: string | null;
  availableAtMs: number | null;
  sourceAtMs: number | null;
  factId: string | null;
}
const absent = (status: BaselineValue['status'], reason: string): BaselineValue => ({
  status,
  reason,
  price: null,
  availableAtMs: null,
  sourceAtMs: null,
  factId: null
});

/** No network and no clock substitution. Caller persists PENDING before starting attempts. */
export function marketBaseline(input: {
  token: string;
  poolRevision: string;
  confirmationAtMs: number;
  nowMs: number;
  facts: readonly MarketFact[];
  preparationComplete: boolean;
  track: 'post_confirmation_market_v1' | 'decision_market_replay_v1';
}): BaselineValue {
  if (!input.preparationComplete) return absent('MISSING', 'MISSING_PREPARATION');
  const diagnostic = input.track === 'decision_market_replay_v1';
  const deadline = input.confirmationAtMs + (diagnostic ? 0 : p.baselineDeadlineMs);
  const facts = input.facts
    .filter(
      (f) =>
        f.endpoint === 'info' &&
        f.token === input.token &&
        f.poolRevision === input.poolRevision &&
        f.receivedAtMs <= Math.min(input.nowMs, deadline) &&
        (diagnostic
          ? f.receivedAtMs <= input.confirmationAtMs
          : f.requestedAtMs >= input.confirmationAtMs &&
            f.receivedAtMs - f.requestedAtMs <= p.physicalTimeoutMs)
    )
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.factId.localeCompare(b.factId));
  const candidates = diagnostic ? facts.reverse().slice(0, 1) : facts.slice(0, p.marketAttempts);
  for (const fact of candidates) {
    const price = decimalValue((fact.payload.price as Record<string, unknown> | undefined)?.price);
    const reference = diagnostic ? input.confirmationAtMs : fact.receivedAtMs;
    if (
      fact.sourceAtMs === null ||
      fact.qualityFlags.length ||
      reference - fact.sourceAtMs > p.sourceMaxAgeMs ||
      fact.sourceAtMs > fact.receivedAtMs ||
      (!diagnostic && fact.sourceAtMs < input.confirmationAtMs) ||
      !price?.gt(0)
    )
      continue;
    return {
      status: 'VALID',
      reason: 'FIRST_ELIGIBLE_PRICE',
      price: price.toString(),
      availableAtMs: diagnostic ? input.confirmationAtMs : fact.receivedAtMs,
      sourceAtMs: fact.sourceAtMs,
      factId: fact.factId
    };
  }
  if (input.nowMs < deadline && candidates.length < p.marketAttempts && !diagnostic)
    return absent('PENDING', 'AWAITING_BASELINE');
  return candidates.length
    ? absent('UNVERIFIED', 'PRICE_SOURCE_OR_QUALITY_UNVERIFIED')
    : absent('MISSING', 'NO_ELIGIBLE_PHYSICAL_RESPONSE');
}

export interface QuoteObservation {
  factId: string;
  chain: 'bsc';
  token: string;
  poolRevision: string;
  wallet: string;
  inputAsset: string;
  outputAsset: string;
  direction: 'buy' | 'sell';
  inputAmount: string;
  outputAmount: string;
  outputUsd: string;
  inputUsd: string;
  slippage: string;
  semantics: string;
  requestedAtMs: number;
  receivedAtMs: number;
}
export function quoteReuseKey(
  quote: Omit<
    QuoteObservation,
    'factId' | 'outputAmount' | 'outputUsd' | 'inputUsd' | 'requestedAtMs' | 'receivedAtMs'
  >
): string {
  // Exact amounts are intentionally not rounded or inferred from a USD label.
  return JSON.stringify([
    quote.chain,
    quote.token,
    quote.poolRevision,
    quote.wallet,
    quote.inputAsset,
    quote.outputAsset,
    quote.direction,
    quote.inputAmount,
    quote.slippage,
    quote.semantics
  ]);
}
export function quoteBaseline(quote: QuoteObservation, confirmationAtMs: number): BaselineValue {
  if (
    quote.direction !== 'buy' ||
    quote.requestedAtMs < confirmationAtMs ||
    quote.receivedAtMs < quote.requestedAtMs ||
    quote.receivedAtMs > confirmationAtMs + p.baselineDeadlineMs ||
    quote.receivedAtMs - quote.requestedAtMs > p.physicalTimeoutMs
  )
    return absent('MISSING', 'QUOTE_PHYSICAL_DEADLINE');
  const quantity = decimalValue(quote.outputAmount),
    cost = decimalValue(quote.inputUsd);
  if (!quantity?.gt(0) || !cost?.eq(10)) return absent('UNVERIFIED', 'QUOTE_QUANTITY_OR_COST');
  return {
    status: 'VALID',
    reason: 'SIMULATED_QUOTE_NOT_FILL',
    price: cost.div(quantity).toString(),
    availableAtMs: quote.receivedAtMs,
    sourceAtMs: null,
    factId: quote.factId
  };
}
export function pairedQuoteReturn(buy: QuoteObservation, sell: QuoteObservation): string | null {
  if (
    buy.direction !== 'buy' ||
    sell.direction !== 'sell' ||
    buy.outputAmount !== sell.inputAmount ||
    buy.chain !== sell.chain ||
    buy.token !== sell.token ||
    buy.poolRevision !== sell.poolRevision ||
    buy.wallet !== sell.wallet ||
    buy.outputAsset !== sell.inputAsset ||
    buy.inputAsset !== sell.outputAsset ||
    buy.semantics !== sell.semantics ||
    buy.slippage !== sell.slippage ||
    sell.requestedAtMs < buy.receivedAtMs ||
    sell.receivedAtMs < sell.requestedAtMs ||
    sell.receivedAtMs - sell.requestedAtMs > p.physicalTimeoutMs
  )
    return null;
  const cost = decimalValue(buy.inputUsd),
    proceeds = decimalValue(sell.outputUsd);
  return cost?.gt(0) && proceeds?.gte(0) ? proceeds.div(cost).toString() : null;
}

export interface PathCandle {
  startMs: number;
  endMs: number;
  receivedAtMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
}
export interface PathResult {
  outcome: Outcome;
  reason: string;
  touchedAtMs: number | null;
}
/** A gap before a touch or an ambiguous boundary cannot be repaired by a later high. */
export function firstTouch(
  baseline: BaselineValue,
  target: number,
  candles: readonly PathCandle[],
  nowMs: number
): PathResult {
  const result = (
    outcome: Outcome,
    reason: string,
    touchedAtMs: number | null = null
  ): PathResult => ({ outcome, reason, touchedAtMs });
  if (!p.targets.includes(target as 1.3 | 1.5 | 2 | 3)) throw new Error('UNREGISTERED_TARGET');
  if (baseline.status === 'PENDING') return result('CENSORED', 'BASELINE_PENDING');
  if (
    baseline.status !== 'VALID' ||
    !decimalValue(baseline.price)?.gt(0) ||
    baseline.availableAtMs === null
  )
    return result('MISSING_BASELINE', baseline.reason);
  const start = baseline.availableAtMs,
    end = start + p.horizonMs;
  const price = new Decimal(baseline.price!),
    tp = price.times(target),
    sl = price.times(p.stopMultiple);
  let covered = start;
  let incomplete = false;
  const rows = candles
    .filter(
      (c) => c.receivedAtMs <= nowMs && c.endMs > (baseline.sourceAtMs ?? start) && c.startMs < end
    )
    .sort((a, b) => a.startMs - b.startMs || a.receivedAtMs - b.receivedAtMs);
  const byStart = new Map<number, PathCandle>();
  for (const c of rows) {
    const previous = byStart.get(c.startMs);
    if (
      previous &&
      ['endMs', 'open', 'high', 'low', 'close'].some(
        (k) => previous[k as keyof PathCandle] !== c[k as keyof PathCandle]
      )
    )
      return result('UNKNOWN', 'CONFLICTING_CANDLE');
    byStart.set(c.startMs, c);
  }
  for (const c of byStart.values()) {
    const values = [c.open, c.high, c.low, c.close].map(decimalValue);
    if (
      values.some((v) => !v?.gt(0)) ||
      ![c.startMs, c.endMs, c.receivedAtMs].every(Number.isSafeInteger) ||
      c.endMs <= c.startMs ||
      c.endMs > c.receivedAtMs
    )
      return result('UNKNOWN', 'INVALID_OR_INCOMPLETE_CANDLE');
    const [open, high, low, close] = values as Decimal[];
    if (low!.gt(Decimal.min(open!, close!)) || high!.lt(Decimal.max(open!, close!)))
      return result('UNKNOWN', 'INVALID_OHLC');
    const hitsTp = high!.gte(tp),
      hitsSl = low!.lte(sl);
    if (c.startMs < start || c.endMs > end) {
      if (hitsTp || hitsSl) return result('UNKNOWN', 'BOUNDARY_TOUCH_ORDER');
      if (c.startMs <= covered) covered = Math.min(end, Math.max(covered, c.endMs));
      continue;
    }
    if (c.startMs < covered) return result('UNKNOWN', 'PATH_GAP_OR_OVERLAP');
    if (c.startMs > covered) incomplete = true;
    if (incomplete && (hitsTp || hitsSl)) return result('UNKNOWN', 'PATH_GAP_OR_OVERLAP');
    if (hitsTp && hitsSl) return result('UNKNOWN', 'SAME_CANDLE_ORDER');
    if (hitsSl) return result('SL', 'STOP_FIRST', c.endMs);
    if (hitsTp) return result('TP', 'TARGET_FIRST', c.endMs);
    covered = c.endMs;
  }
  if (nowMs < end) return result('CENSORED', 'HORIZON_PENDING');
  return covered >= end && !incomplete
    ? result('NOT_TOUCHED', 'COMPLETE_HORIZON_NO_TOUCH')
    : result('CENSORED', 'PATH_INCOMPLETE');
}

export function outcomeSummary(
  rows: readonly { track: BaselineTrack; protocolHash: string; target: number; outcome: Outcome }[]
) {
  const groups = new Map<
    string,
    { track: BaselineTrack; protocolHash: string; target: number; counts: Record<Outcome, number> }
  >();
  for (const row of rows) {
    const key = JSON.stringify([row.track, row.protocolHash, row.target]);
    const group = groups.get(key) ?? {
      track: row.track,
      protocolHash: row.protocolHash,
      target: row.target,
      counts: Object.fromEntries(outcomes.map((o) => [o, 0])) as Record<Outcome, number>
    };
    group.counts[row.outcome]++;
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => {
    const all = Object.values(g.counts).reduce((a, b) => a + b, 0);
    const known = g.counts.TP + g.counts.SL + g.counts.NOT_TOUCHED;
    return {
      ...g,
      all,
      coverage: known / all,
      tpAll: g.counts.TP / all,
      tpConditional: g.counts.TP + g.counts.SL ? g.counts.TP / (g.counts.TP + g.counts.SL) : null
    };
  });
}

export function observationCoordinates(startMs: number): number[] {
  const coordinates: number[] = [];
  for (let offset = 30000; offset <= p.horizonMs;) {
    coordinates.push(startMs + offset);
    offset += offset < 600000 ? 30000 : offset < 3600000 ? 120000 : 600000;
  }
  return coordinates;
}
