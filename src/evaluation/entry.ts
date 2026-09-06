import type { QuoteProvider } from '../quote/gate.js';
import type { Storage } from '../storage/database.js';

export interface EntryQuoteCapture {
  sizeUsd: number;
  requestedAtMs: number;
  completedAtMs: number;
  primaryExecutableCohort: boolean;
  error: string | null;
}

/** Captures all entry sizes concurrently after Telegram confirmation; it never trades. */
export async function capturePostConfirmationEntryQuotes(
  storage: Storage,
  provider: QuoteProvider,
  input: {
    episodeId: string;
    signalId: string;
    confirmedAtMs: number;
    sizesUsd: readonly [number, number, number];
    now?: () => number;
  }
): Promise<EntryQuoteCapture[]> {
  const now = input.now ?? Date.now;
  return Promise.all(
    input.sizesUsd.map(async (sizeUsd) => {
      const requestedAtMs = now();
      try {
        const quote = await provider.buy(sizeUsd);
        const completedAtMs = now();
        await storage.recordEntryQuote({
          episodeId: input.episodeId,
          signalId: input.signalId,
          sizeUsd,
          confirmedAtMs: input.confirmedAtMs,
          requestedAtMs,
          completedAtMs,
          quote,
          error: null
        });
        return {
          sizeUsd,
          requestedAtMs,
          completedAtMs,
          primaryExecutableCohort: requestedAtMs - input.confirmedAtMs <= 5_000,
          error: null
        };
      } catch (error) {
        const completedAtMs = now();
        const message = error instanceof Error ? error.message : 'entry quote failure';
        await storage.recordEntryQuote({
          episodeId: input.episodeId,
          signalId: input.signalId,
          sizeUsd,
          confirmedAtMs: input.confirmedAtMs,
          requestedAtMs,
          completedAtMs,
          quote: null,
          error: message
        });
        return {
          sizeUsd,
          requestedAtMs,
          completedAtMs,
          primaryExecutableCohort: requestedAtMs - input.confirmedAtMs <= 5_000,
          error: message
        };
      }
    })
  );
}
