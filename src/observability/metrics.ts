import type { DurableMetricCounts, Storage } from '../storage/database.js';

export interface RuntimeMetricCounts {
  discovered: number;
  deduplicated: number;
  deepAnalyses: number;
  safetyRejected: number;
  staleCandidates: number;
  quoteRejections: number;
}

export class MetricsCollector {
  #runtime: RuntimeMetricCounts = {
    discovered: 0,
    deduplicated: 0,
    deepAnalyses: 0,
    safetyRejected: 0,
    staleCandidates: 0,
    quoteRejections: 0
  };

  increment(metric: keyof RuntimeMetricCounts, amount = 1): void {
    this.#runtime[metric] += amount;
  }

  async snapshot(
    storage: Storage,
    nowMs = Date.now()
  ): Promise<RuntimeMetricCounts & DurableMetricCounts & { deduplicationRate: number }> {
    const durable = await storage.durableMetricCounts(nowMs);
    return {
      ...this.#runtime,
      ...durable,
      deduplicationRate:
        this.#runtime.discovered === 0 ? 0 : this.#runtime.deduplicated / this.#runtime.discovered
    };
  }
}

export function apiMetricEndpoint(path: string): string {
  const mappings: Array<[string, string]> = [
    ['/token_top_holders', 'holders'],
    ['/token_top_traders', 'traders'],
    ['/created_tokens', 'created_tokens'],
    ['/hot_searches', 'hot'],
    ['/smartmoney', 'smart_money'],
    ['/token_signal', 'market_signal'],
    ['/token_kline', 'kline'],
    ['/pool_info', 'pool'],
    ['/security', 'security'],
    ['/info', 'info'],
    ['/quote', 'quote'],
    ['/gas_price', 'gas'],
    ['/trenches', 'trenches'],
    ['/rank', 'trending'],
    ['/kol', 'kol']
  ];
  return mappings.find(([suffix]) => path.endsWith(suffix))?.[1] ?? 'unknown';
}
