export type EpisodeState =
  | 'DISCOVERED'
  | 'OBSERVING'
  | 'READY'
  | 'DELIVERY_PENDING'
  | 'SENT'
  | 'SEND_FAILED'
  | 'DELIVERY_UNKNOWN'
  | 'REJECTED'
  | 'EXPIRED';
export const terminalStates = new Set<EpisodeState>([
  'SENT',
  'SEND_FAILED',
  'DELIVERY_UNKNOWN',
  'REJECTED',
  'EXPIRED'
]);

const allowed: Record<EpisodeState, ReadonlySet<EpisodeState>> = {
  DISCOVERED: new Set(['OBSERVING', 'READY', 'REJECTED']),
  OBSERVING: new Set(['OBSERVING', 'READY', 'REJECTED', 'EXPIRED']),
  READY: new Set(['DELIVERY_PENDING', 'OBSERVING', 'REJECTED', 'EXPIRED']),
  DELIVERY_PENDING: new Set(['SENT', 'SEND_FAILED', 'DELIVERY_UNKNOWN', 'REJECTED']),
  SENT: new Set(),
  SEND_FAILED: new Set(),
  DELIVERY_UNKNOWN: new Set(),
  REJECTED: new Set(),
  EXPIRED: new Set()
};

export class EpisodeTransitionError extends Error {}
export interface Episode {
  id: string;
  state: EpisodeState;
  lowScoreChecks: number;
  sentAtMs: number | null;
  endedAtMs: number | null;
}

export function routeResetSatisfied(
  route: 'new_launch' | 'revival' | 'continuation',
  features: { hasCompletedDormancy: boolean; hasHealthyPullbackAndRestart: boolean }
): boolean {
  if (route === 'new_launch') return true;
  return route === 'revival'
    ? features.hasCompletedDormancy
    : features.hasHealthyPullbackAndRestart;
}

export function transition(episode: Episode, target: EpisodeState, nowMs: number): Episode {
  if (!allowed[episode.state].has(target))
    throw new EpisodeTransitionError(`cannot transition ${episode.state} to ${target}`);
  if (target === 'DELIVERY_PENDING' && episode.state !== 'READY')
    throw new EpisodeTransitionError('delivery requires READY');
  if (target === 'SENT' && episode.state !== 'DELIVERY_PENDING')
    throw new EpisodeTransitionError('sent requires pending delivery');
  return {
    ...episode,
    state: target,
    sentAtMs: target === 'SENT' ? nowMs : episode.sentAtMs,
    endedAtMs: terminalStates.has(target) ? nowMs : null
  };
}

export function recordScore(
  episode: Episode,
  score: number,
  observationThreshold: number,
  nowMs: number
): Episode {
  if (terminalStates.has(episode.state)) return episode;
  if (score >= observationThreshold) return { ...episode, lowScoreChecks: 0 };
  const lowScoreChecks = episode.lowScoreChecks + 1;
  return lowScoreChecks >= 2
    ? transition({ ...episode, lowScoreChecks }, 'EXPIRED', nowMs)
    : { ...episode, lowScoreChecks };
}
