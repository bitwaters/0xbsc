export interface RevivalCycleState {
  dormantSinceLastRevival: boolean;
}

export function observeRevivalDormancy(
  state: RevivalCycleState,
  isDormantNow: boolean
): RevivalCycleState {
  return isDormantNow ? { dormantSinceLastRevival: true } : state;
}

export function consumeRevivalCycle(
  state: RevivalCycleState,
  activityQualified: boolean,
  structureBreakout: boolean
): { eligible: boolean; next: RevivalCycleState } {
  const eligible = state.dormantSinceLastRevival && activityQualified && structureBreakout;
  return { eligible, next: eligible ? { dormantSinceLastRevival: false } : state };
}
