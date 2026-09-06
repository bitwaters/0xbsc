import type { Storage } from '../storage/database.js';

/** Durable result-task creation; SQLite is the only task queue. */
export async function scheduleEvaluationTasks(
  storage: Storage,
  input: {
    episodeId: string;
    signalId: string | null;
    score: number;
    hardSafetyPassed: boolean;
    formal: boolean;
    narrative: boolean;
    fromMs: number;
    checkpointsMinutes: readonly number[];
    narrativeCheckpointsMinutes: readonly number[];
    maxUnsentTrackingMinutes?: number;
  }
): Promise<number> {
  return storage.scheduleResultTasks({
    ...input,
    checkpointsMinutes:
      input.formal || input.maxUnsentTrackingMinutes === undefined
        ? input.checkpointsMinutes
        : input.checkpointsMinutes.filter((minute) => minute <= input.maxUnsentTrackingMinutes!),
    narrativeCheckpointsMinutes:
      input.formal || input.maxUnsentTrackingMinutes === undefined
        ? input.narrativeCheckpointsMinutes
        : input.narrativeCheckpointsMinutes.filter(
            (minute) => minute <= input.maxUnsentTrackingMinutes!
          )
  });
}
