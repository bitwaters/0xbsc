import type { RouteName } from '../config/types.js';

export type ScoreLevel = 0 | 0.5 | 1;
export type Dimension =
  'lifecycle' | 'structure' | 'capital' | 'attention' | 'quality' | 'freshness';
export interface ScoredField {
  weight: number;
  available: boolean;
  fresh: boolean;
}
export interface ScoreResult {
  score: number;
  completeness: number;
}
export type RouteDecision = 'rejected' | 'observing' | 'formal';

export const requiredTtlMs = {
  info: 30_000,
  pool: 30_000,
  kline: 60_000,
  traders: 180_000,
  holders: 300_000,
  creator: 3_600_000
} as const;
export type DataFieldKind = keyof typeof requiredTtlMs;
export interface DimensionContribution {
  dimension: Dimension;
  source: string;
  level: ScoreLevel;
}

export function dataTtlMs(kind: DataFieldKind, configured?: Record<DataFieldKind, number>): number {
  return (configured?.[kind] ?? requiredTtlMs[kind] / 1_000) * 1_000;
}

export function isFreshField(
  kind: DataFieldKind,
  observedAtMs: number | null,
  nowMs: number,
  configured?: Record<DataFieldKind, number>
): boolean {
  return (
    observedAtMs !== null &&
    observedAtMs <= nowMs &&
    nowMs - observedAtMs <= dataTtlMs(kind, configured)
  );
}

export function aggregateDimensionLevels(
  contributions: readonly DimensionContribution[]
): Record<Dimension, ScoreLevel> {
  const perSource = new Map<string, ScoreLevel>();
  for (const contribution of contributions) {
    const key = `${contribution.dimension}:${contribution.source}`;
    const current = perSource.get(key) ?? 0;
    if (contribution.level > current) perSource.set(key, contribution.level);
  }
  const levels: Record<Dimension, ScoreLevel> = {
    lifecycle: 0,
    structure: 0,
    capital: 0,
    attention: 0,
    quality: 0,
    freshness: 0
  };
  for (const [key, level] of perSource) {
    const [dimension] = key.split(':') as [Dimension];
    if (level > levels[dimension]) levels[dimension] = level;
  }
  return levels;
}

export function scoreRoute(
  weights: Record<Dimension, number>,
  levels: Record<Dimension, ScoreLevel>,
  fields: ScoredField[]
): ScoreResult {
  const score = (Object.keys(weights) as Dimension[]).reduce(
    (total, dimension) => total + weights[dimension] * levels[dimension],
    0
  );
  const totalWeight = fields.reduce((total, field) => total + field.weight, 0);
  const freshWeight = fields
    .filter((field) => field.available && field.fresh)
    .reduce((total, field) => total + field.weight, 0);
  return { score, completeness: totalWeight === 0 ? 0 : freshWeight / totalWeight };
}

export function passesFormalGate(
  result: ScoreResult,
  evidenceFamilies: number,
  decisiveTriggerAtMs: number | null,
  nowMs: number,
  decisiveWindowMs: number,
  formalThreshold = 80,
  minimumCompleteness = 0.7
): boolean {
  return (
    result.score >= formalThreshold &&
    result.completeness >= minimumCompleteness &&
    evidenceFamilies >= 2 &&
    decisiveTriggerAtMs !== null &&
    nowMs >= decisiveTriggerAtMs &&
    nowMs - decisiveTriggerAtMs <= decisiveWindowMs
  );
}

export function decideRoute(
  result: ScoreResult,
  evidenceFamilies: number,
  decisiveTriggerAtMs: number | null,
  nowMs: number,
  route: RouteName,
  thresholds: {
    observationThreshold: number;
    formalThreshold: number;
    minimumCompleteness: number;
    decisiveWindowsMs: Record<RouteName, number>;
  }
): RouteDecision {
  if (result.score < thresholds.observationThreshold) return 'rejected';
  return passesFormalGate(
    result,
    evidenceFamilies,
    decisiveTriggerAtMs,
    nowMs,
    thresholds.decisiveWindowsMs[route],
    thresholds.formalThreshold,
    thresholds.minimumCompleteness
  )
    ? 'formal'
    : 'observing';
}

export const routeWindowsMs: Record<RouteName, number> = {
  new_launch: 90_000,
  revival: 120_000,
  continuation: 60_000
};
