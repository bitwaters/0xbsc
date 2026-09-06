import { withGmgnContext } from '../gmgn/context.js';
import type { Storage } from '../storage/database.js';
import type { NormalizedEvent } from '../discovery/events.js';
import { withCandidateRecovery } from './recovery.js';

/** Research requests get a fresh work budget, never fresh market evidence. */
export function runCandidateScope<T>(
  storage: Storage,
  event: NormalizedEvent,
  options: { researchOnly: boolean; correlationId: string; now: () => number },
  run: () => Promise<T>
): Promise<T> {
  return withGmgnContext(
    {
      correlationId: options.correlationId,
      deadlineMs: options.researchOnly ? options.now() + 30_000 : event.expiresAtMs,
      ...(options.researchOnly ? { priority: 'evaluation' as const } : {})
    },
    () =>
      options.researchOnly
        ? run()
        : withCandidateRecovery(storage, event.tokenAddress, options.now, run)
  );
}
