import { Decimal } from 'decimal.js';
import type { Candle } from './outcomes.js';

export type PathStatus =
  'TP' | 'SL' | 'ambiguous_same_candle' | 'not_touched' | 'pending' | 'unknown';
export interface PathContext {
  entryAtMs: number;
  targetAtMs: number;
  horizonAtMs: number;
}
export interface PathResult {
  version: 'path-v2';
  coverage: 'complete' | 'incomplete';
  reasons: string[];
  observedMaxMultiple: string | null;
  maxMultiple: string | null;
  maxEntryDrop: string | null;
  peakDrawdownLower: string | null;
  peakDrawdownUpper: string | null;
  barriers: Array<{
    multiple: number;
    stopLoss: number;
    status: PathStatus;
    touchedAtMs: number | null;
  }>;
  targets: Array<{
    multiple: number;
    touchedAtMs: number | null;
    preTargetDropLower: string | null;
    preTargetDropUpper: string | null;
  }>;
}

/** OHLC cannot order the high and low inside the target candle: return bounds, never guess. */
export function evaluatePath(
  entryPrice: string,
  candles: Candle[],
  context: PathContext,
  multiples: readonly number[],
  stopLoss: number
): PathResult {
  const entry = new Decimal(entryPrice);
  if (
    !entry.isFinite() ||
    entry.lte(0) ||
    stopLoss <= 0 ||
    stopLoss >= 1 ||
    multiples.some((m) => m <= 1)
  )
    throw new RangeError('invalid path parameters');
  const reasons = new Set<string>();
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (c.timeMs === undefined || c.intervalMs === undefined || c.intervalMs <= 0) {
      reasons.add('missing_time');
      continue;
    }
    if (
      c.timeMs < context.entryAtMs ||
      c.timeMs + c.intervalMs > context.targetAtMs ||
      c.completed !== true
    ) {
      if (c.timeMs < context.entryAtMs && c.timeMs + c.intervalMs > context.entryAtMs)
        reasons.add('entry_candle_ambiguous');
      continue;
    }
    const values = [c.high, c.low, c.close].map((v) => new Decimal(v));
    if (
      values.some((v) => !v.isFinite() || v.lte(0)) ||
      values[0]!.lt(values[1]!) ||
      values[2]!.gt(values[0]!) ||
      values[2]!.lt(values[1]!)
    ) {
      reasons.add('invalid_ohlc');
      continue;
    }
    const previous = byTime.get(c.timeMs);
    if (previous && JSON.stringify(previous) !== JSON.stringify(c))
      reasons.add('conflicting_duplicate');
    byTime.set(c.timeMs, c);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.timeMs! - b.timeMs!);
  let cursor = context.entryAtMs;
  for (const c of sorted) {
    if (c.timeMs !== cursor) reasons.add('coverage_gap');
    cursor = c.timeMs! + c.intervalMs!;
  }
  if (cursor !== context.targetAtMs || !sorted.length) reasons.add('coverage_gap');
  const complete = reasons.size === 0;
  const ratios = sorted.map((c) => ({
    c,
    high: new Decimal(c.high).div(entry),
    low: new Decimal(c.low).div(entry),
    close: new Decimal(c.close).div(entry)
  }));
  let peak = new Decimal(1),
    drop = new Decimal(0),
    drawdownLower = new Decimal(0),
    drawdownUpper = new Decimal(0);
  for (const r of ratios) {
    drop = Decimal.max(drop, new Decimal(1).minus(r.low));
    drawdownLower = Decimal.max(
      drawdownLower,
      new Decimal(1).minus(r.low.div(peak)),
      new Decimal(1).minus(r.close.div(r.high))
    );
    peak = Decimal.max(peak, r.high);
    drawdownUpper = Decimal.max(drawdownUpper, new Decimal(1).minus(r.low.div(peak)));
  }
  const targets = multiples.map((multiple) => {
    const index = ratios.findIndex((r) => r.high.gte(multiple));
    const target = ratios[index];
    const priorLow = Decimal.min(1, ...ratios.slice(0, Math.max(0, index)).map((r) => r.low));
    return {
      multiple,
      touchedAtMs: complete && target ? target.c.timeMs! : null,
      preTargetDropLower: complete && target ? new Decimal(1).minus(priorLow).toString() : null,
      preTargetDropUpper:
        complete && target
          ? new Decimal(1).minus(Decimal.min(priorLow, target.low)).toString()
          : null
    };
  });
  const barriers = multiples.map((multiple) => {
    let status: PathStatus = complete
      ? context.targetAtMs >= context.horizonAtMs
        ? 'not_touched'
        : 'pending'
      : 'unknown';
    let touchedAtMs: number | null = null;
    // A proven first touch stays proven even if later candles are missing.
    // An entry-straddling bar may prove no touch only when its ENTIRE range is inside both barriers.
    if (
      !reasons.has('missing_time') &&
      !reasons.has('invalid_ohlc') &&
      !reasons.has('conflicting_duplicate')
    ) {
      let coveredThrough = context.entryAtMs;
      status = 'unknown';
      const ordered = [...candles]
        .filter((c) => c.timeMs !== undefined && c.intervalMs !== undefined)
        .sort((a, b) => a.timeMs! - b.timeMs!);
      for (const c of ordered) {
        const end = c.timeMs! + c.intervalMs!;
        if (end <= context.entryAtMs || end <= coveredThrough) continue;
        if (c.timeMs! > coveredThrough || end > context.targetAtMs || !c.completed) break;
        const up = new Decimal(c.high).div(entry).gte(multiple),
          down = new Decimal(c.low).div(entry).lte(1 - stopLoss);
        if (c.timeMs! < context.entryAtMs && (up || down)) break;
        if (up || down) {
          status = up && down ? 'ambiguous_same_candle' : up ? 'TP' : 'SL';
          touchedAtMs = c.timeMs!;
          break;
        }
        coveredThrough = end;
      }
      if (touchedAtMs === null && coveredThrough === context.targetAtMs)
        status = context.targetAtMs >= context.horizonAtMs ? 'not_touched' : 'pending';
    }
    return { multiple, stopLoss, status, touchedAtMs };
  });
  const observedMaxMultiple = ratios.length
    ? Decimal.max(1, ...ratios.map((r) => r.high)).toString()
    : null;
  return {
    version: 'path-v2',
    coverage: complete ? 'complete' : 'incomplete',
    reasons: [...reasons],
    observedMaxMultiple,
    maxMultiple: complete ? observedMaxMultiple : null,
    maxEntryDrop: complete ? drop.toString() : null,
    peakDrawdownLower: complete ? drawdownLower.toString() : null,
    peakDrawdownUpper: complete ? drawdownUpper.toString() : null,
    targets,
    barriers
  };
}

export function summarizePathStatuses(statuses: readonly PathStatus[]) {
  const count = (value: PathStatus) => statuses.filter((s) => s === value).length;
  const hit = count('TP'),
    loss = count('SL'),
    notTouched = count('not_touched'),
    pending = count('pending');
  const unknown = count('unknown') + count('ambiguous_same_candle'),
    adjudicable = hit + loss + notTouched;
  return {
    total: statuses.length,
    hit,
    loss,
    notTouched,
    pending,
    unknown,
    adjudicable,
    coverage: statuses.length ? adjudicable / statuses.length : null,
    hitRate: adjudicable ? hit / adjudicable : null,
    conditionalHitRate: hit + loss ? hit / (hit + loss) : null
  };
}
