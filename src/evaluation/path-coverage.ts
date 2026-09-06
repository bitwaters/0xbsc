import type { Candle } from './outcomes.js';

export interface PathRange {
  fromMs: number;
  toMs: number;
}

/** Separates unavailable intervals from unavoidable OHLC boundary uncertainty. */
export function diagnosePathCoverage(candles: Candle[], fromMs: number, toMs: number) {
  const rows = candles
    .filter(
      (c) =>
        c.timeMs !== undefined &&
        c.intervalMs !== undefined &&
        c.intervalMs > 0 &&
        c.timeMs < toMs &&
        c.timeMs + c.intervalMs > fromMs
    )
    .sort((a, b) => a.timeMs! - b.timeMs! || Number(b.completed) - Number(a.completed));
  const missingRanges: PathRange[] = [],
    pendingRanges: PathRange[] = [];
  let cursor = fromMs;
  for (const c of rows) {
    const start = Math.max(fromMs, c.timeMs!),
      end = Math.min(toMs, c.timeMs! + c.intervalMs!);
    if (end <= cursor) continue;
    if (start > cursor) missingRanges.push({ fromMs: cursor, toMs: start });
    if (!c.completed) pendingRanges.push({ fromMs: Math.max(cursor, start), toMs: end });
    cursor = end;
  }
  if (cursor < toMs) missingRanges.push({ fromMs: cursor, toMs });
  return {
    entryBoundary: rows.some((c) => c.timeMs! < fromMs && c.timeMs! + c.intervalMs! > fromMs),
    targetBoundary: rows.some((c) => c.timeMs! < toMs && c.timeMs! + c.intervalMs! > toMs),
    missingRanges,
    pendingRanges,
    missingDurationMs: missingRanges.reduce((n, r) => n + r.toMs - r.fromMs, 0),
    pendingDurationMs: pendingRanges.reduce((n, r) => n + r.toMs - r.fromMs, 0),
    gapCause: missingRanges.length ? 'unverified_missing_or_no_trades' : null
  };
}

/** A completed candle cannot be silently replaced by a conflicting historical value. */
export function mergeMarketPaths(previous: Candle[], fresh: Candle[]): Candle[] {
  const rows = new Map<number, Candle[]>();
  const untimed: Candle[] = [];
  for (const c of [...previous, ...fresh]) {
    if (c.timeMs === undefined) {
      untimed.push(c);
      continue;
    }
    const old = rows.get(c.timeMs) ?? [];
    if (c.completed) {
      const completed = old.filter((x) => x.completed);
      if (!completed.some((x) => JSON.stringify(x) === JSON.stringify(c))) completed.push(c);
      rows.set(c.timeMs, completed);
    } else if (!old.some((x) => x.completed)) rows.set(c.timeMs, [c]);
  }
  return [...rows.values()]
    .flat()
    .sort((a, b) => a.timeMs! - b.timeMs!)
    .concat(untimed);
}
