import type { CandidateGmgnApi } from '../gmgn/api.js';
import { adaptGmgnCandles } from '../decision/gmgn-adapter.js';
import type { Candle } from './outcomes.js';

/** Small non-overlapping requests avoid the endpoint's 100-row truncation. */
export async function fetchMarketPath(
  api: CandidateGmgnApi,
  token: string,
  fromMs: number,
  toMs: number
): Promise<Candle[]> {
  const step = 30_000,
    chunk = step * 80;
  const rows = new Map<number, Candle>();
  for (let from = Math.floor(fromMs / step) * step; from < toMs; from += chunk) {
    const response = await api.kline(
      token,
      '30s',
      { fromMs: from, toMs: Math.min(from + chunk, toMs) },
      'evaluation'
    );
    for (const candle of adaptGmgnCandles(response, toMs, undefined, step)) {
      if (
        candle.timeMs === undefined ||
        candle.timeMs < from ||
        candle.timeMs >= Math.min(from + chunk, toMs)
      )
        continue;
      rows.set(candle.timeMs, {
        timeMs: candle.timeMs,
        intervalMs: step,
        completed: candle.completed,
        high: String(candle.high),
        low: String(candle.low),
        close: String(candle.close)
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.timeMs! - b.timeMs!);
}
