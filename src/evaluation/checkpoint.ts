import type { Candle } from './outcomes.js';
import type { QuoteProvider, QuoteLeg } from '../quote/gate.js';
import type { Storage } from '../storage/database.js';

export interface MarketPathProvider {
  candles(input: { episodeId: string; fromMs: number; toMs: number }): Promise<Candle[]>;
}

/** Captures a market path for every tracked sample and exits only formal signals. */
export async function captureOutcomeCheckpoint(
  storage: Storage,
  market: MarketPathProvider,
  quotes: QuoteProvider,
  input: {
    taskId: number;
    episodeId: string;
    signalId: string | null;
    formal: boolean;
    checkpointMinutes: number;
    entryAtMs: number;
    targetAtMs: number;
    now?: () => number;
  }
): Promise<{
  candles: Candle[];
  exitLate: boolean;
  exitQuotes: Array<{
    sizeUsd: number;
    entryUsd: string;
    quote: QuoteLeg | null;
    requestedAtMs: number;
    completedAtMs: number;
    late: boolean;
  }>;
}> {
  const now = input.now ?? Date.now;
  const requestedAtMs = now();
  const entryQuotes =
    input.formal && input.signalId ? await storage.completedEntryQuotes(input.signalId) : [];
  const [candles, exits] = await Promise.all([
    market.candles({ episodeId: input.episodeId, fromMs: input.entryAtMs, toMs: input.targetAtMs }),
    Promise.all(
      entryQuotes.map(async (entry) => {
        const quoteRequestedAtMs = now();
        try {
          const quote = await quotes.sell(entry.outputTokenAmount);
          const quoteCompletedAtMs = now();
          return {
            sizeUsd: entry.sizeUsd,
            entryUsd: entry.inputUsd,
            quote,
            requestedAtMs: quoteRequestedAtMs,
            completedAtMs: quoteCompletedAtMs,
            late:
              quoteRequestedAtMs < input.targetAtMs ||
              quoteCompletedAtMs - input.targetAtMs > 10_000
          };
        } catch {
          return {
            sizeUsd: entry.sizeUsd,
            entryUsd: entry.inputUsd,
            quote: null,
            requestedAtMs: quoteRequestedAtMs,
            completedAtMs: now(),
            late: true
          };
        }
      })
    )
  ]);
  const completedAtMs = now();
  const exitLate = input.formal && requestedAtMs - input.targetAtMs > 10_000;
  await storage.recordOutcomeCheckpoint({
    taskId: input.taskId,
    episodeId: input.episodeId,
    signalId: input.signalId,
    checkpointMinutes: input.checkpointMinutes,
    requestedAtMs,
    completedAtMs,
    data: { candles, exitQuotes: exits, exitLate }
  });
  return { candles, exitLate, exitQuotes: exits };
}
