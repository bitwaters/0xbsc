import { createHash } from 'node:crypto';
import type { RouteName } from '../config/types.js';
import type { EpisodeState } from './episode.js';

export function episodeExpiryAtMs(
  createdAtMs: number,
  route: RouteName,
  expiryMinutes: Record<RouteName | 'narrative', number>,
  confirmedNarrative: boolean
): number {
  const routeExpiry = expiryMinutes[route] * 60_000;
  const narrativeExpiry = confirmedNarrative ? expiryMinutes.narrative * 60_000 : 0;
  return createdAtMs + Math.max(routeExpiry, narrativeExpiry);
}

export function canReenterFromFreshTrigger(
  previous: { state: EpisodeState; endedAtMs: number | null },
  triggerAtMs: number,
  nowMs: number,
  decisiveWindowMs: number
): boolean {
  return (
    (previous.state === 'REJECTED' || previous.state === 'EXPIRED') &&
    previous.endedAtMs !== null &&
    triggerAtMs > previous.endedAtMs &&
    triggerAtMs <= nowMs &&
    nowMs - triggerAtMs <= decisiveWindowMs
  );
}

export function klineResolutionForRoute(route: RouteName): '30s' | '1m' {
  return route === 'revival' ? '1m' : '30s';
}

export function eventDrivenReevaluationAtMs(eventObservedAtMs: number): number {
  return eventObservedAtMs;
}

export function staggeredEvaluationAtMs(
  nowMs: number,
  tokenAddress: string,
  route: RouteName,
  refreshMs = 30_000
): number {
  const windowStart = Math.floor(nowMs / refreshMs) * refreshMs;
  const hash = createHash('sha256').update(`${tokenAddress.toLowerCase()}:${route}`).digest();
  const offset = hash.readUInt32BE(0) % refreshMs;
  const candidate = windowStart + offset;
  return candidate > nowMs ? candidate : candidate + refreshMs;
}
