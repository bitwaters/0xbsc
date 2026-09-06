import type { Storage } from '../storage/database.js';
import { GmgnError, gmgnRetryDeadline } from '../gmgn/client.js';

/** Must run inside the token's serial executor so recovery cannot race its next decision. */
export async function withCandidateRecovery<T>(
  storage: Storage,
  tokenAddress: string,
  now: () => number,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const nowMs = now();
    await storage.deferReadyCandidate(
      tokenAddress,
      error instanceof GmgnError ? `candidate_${error.kind}_retry` : 'candidate_processing_retry',
      nowMs,
      gmgnRetryDeadline(error, nowMs)
    );
    throw error;
  }
}
