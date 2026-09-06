import type { CandidateGmgnApi } from '../gmgn/api.js';
import { adaptGmgnCandles } from '../decision/gmgn-adapter.js';
import type { Candle } from './outcomes.js';
import { diagnosePathCoverage, mergeMarketPaths } from './path-coverage.js';

/** Fetch whole boundary bars for bounds, while evaluation keeps its original exact window. */
export async function fetchMarketPath(
  api: CandidateGmgnApi,
  token: string,
  fromMs: number,
  toMs: number,
  options: { now?: () => number; maxRepairRequests?: number } = {}
): Promise<Candle[]> {
  const step = 30_000,
    chunk = step * 80;
  const start = Math.floor(fromMs / step) * step,
    end = Math.ceil(toMs / step) * step;
  const now = options.now ?? Date.now;
  let rows: Candle[] = [];
  const fetchRange = async (from: number, to: number) => {
    const response = await api.kline(token, '30s', { fromMs: from, toMs: to }, 'evaluation');
    const capturedAtMs = now();
    const fresh = adaptGmgnCandles(response, capturedAtMs, undefined, step)
      .filter((c) => c.timeMs !== undefined && c.timeMs >= from && c.timeMs < to)
      .map((c) => ({
        timeMs: c.timeMs!,
        intervalMs: step,
        completed: c.completed,
        high: String(c.high),
        low: String(c.low),
        close: String(c.close)
      }));
    rows = mergeMarketPaths(rows, fresh);
  };
  for (let from = start; from < end; from += chunk)
    await fetchRange(from, Math.min(from + chunk, end));
  // Retry a bounded number of settled gaps; never invent prices for missing/no-trade periods.
  const gaps = diagnosePathCoverage(rows, fromMs, toMs).missingRanges;
  for (const gap of gaps.slice(0, options.maxRepairRequests ?? 2)) {
    const from = Math.floor(gap.fromMs / step) * step,
      to = Math.min(Math.ceil(gap.toMs / step) * step, from + chunk);
    if (to <= now()) await fetchRange(from, to);
  }
  return rows;
}
