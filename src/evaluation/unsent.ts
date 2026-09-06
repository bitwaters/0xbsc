import type { Storage } from '../storage/database.js';

/** Stores the original decision context for false-negative analysis; it never sends a message. */
export function preserveUnsentEvaluationContext(
  storage: Storage,
  input: {
    episodeId: string;
    rejectionReason: string;
    featureSnapshot: unknown;
    configRevisionId: string;
    nowMs: number;
  }
): Promise<boolean> {
  return storage.preserveUnsentEvaluationContext(input);
}
