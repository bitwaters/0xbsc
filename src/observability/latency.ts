export interface LatencySample {
  path: string;
  loadBand: string;
  durationMs: number;
  failed: boolean;
}
export interface LatencyReport {
  path: string;
  loadBand: string;
  sampleCount: number;
  failureRate: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  theoreticalBudgetMs: number | null;
  budgetStatus: 'theoretical_only';
}

export interface StageTimingSample {
  correlationId: string;
  loadBand: string;
  stage: string;
  startedAtMs: number;
  completedAtMs: number;
  failed: boolean;
}

export const theoreticalLatencyBudgetsMs: Record<string, number> = {
  deep_data: 3_000,
  deep_data_p95: 5_000,
  first_analysis_p95: 6_000,
  discovery_p95: 15_000
};

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export function latencyReports(samples: LatencySample[]): LatencyReport[] {
  const groups = new Map<string, LatencySample[]>();
  for (const sample of samples) {
    const key = `${sample.path}\u0000${sample.loadBand}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    if (!first) throw new Error('empty latency group');
    const successful = group.filter((sample) => !sample.failed).map((sample) => sample.durationMs);
    return {
      path: first.path,
      loadBand: first.loadBand,
      sampleCount: group.length,
      failureRate: group.filter((sample) => sample.failed).length / group.length,
      p50: percentile(successful, 0.5),
      p95: percentile(successful, 0.95),
      p99: percentile(successful, 0.99),
      theoreticalBudgetMs: theoreticalLatencyBudgetsMs[first.path] ?? null,
      budgetStatus: 'theoretical_only'
    };
  });
}

/**
 * Produces a stage-by-stage diagnostic from correlated timings. Budget values remain
 * explicitly theoretical until a live acceptance run creates a versioned baseline.
 */
export function stageLatencyReports(samples: StageTimingSample[]): LatencyReport[] {
  return latencyReports(
    samples.map((sample) => {
      if (sample.completedAtMs < sample.startedAtMs)
        throw new RangeError(`stage ${sample.stage} completed before it started`);
      return {
        path: sample.stage,
        loadBand: sample.loadBand,
        durationMs: sample.completedAtMs - sample.startedAtMs,
        failed: sample.failed
      };
    })
  );
}
