import { z } from 'zod';
import { hashValue, measurementProtocol, outcomes } from './protocol.js';

const time = z.number().int().nonnegative().safe();
const track = z.enum([
  'card_reference_legacy',
  'post_confirmation_market_v1',
  'post_confirmation_quote_v1',
  'decision_market_replay_v1'
]);
const identity = {
  runId: z.string().min(1),
  modelHash: z.string().min(1),
  sampleId: z.string().min(1),
  token: z.string().min(1),
  track,
  protocolHash: z.string().min(1),
  confirmationKind: z.enum(['ACTUAL', 'SIMULATED', 'DECISION']),
  confirmationAtMs: time.nullable(),
  horizonMs: z.number().int().positive().safe()
};
const expected = z.object(identity).strict();
const observation = z
  .object({
    ...identity,
    baselineStatus: z.enum(['PENDING', 'VALID', 'UNVERIFIED', 'MISSING']),
    baselineReason: z.string().min(1),
    availableAtMs: time.nullable(),
    targets: z
      .array(
        z
          .object({
            target: z.union([z.literal(1.3), z.literal(1.5), z.literal(2), z.literal(3)]),
            outcome: z.enum(['TP', 'SL', 'NOT_TOUCHED', 'CENSORED', 'UNKNOWN', 'MISSING_BASELINE']),
            reason: z.string().min(1)
          })
          .strict()
      )
      .max(4)
  })
  .strict();
const inputSchema = z
  .object({
    expected: z.array(expected).max(100000),
    observations: z.array(observation).max(100000)
  })
  .strict();
export type MeasurementReportInput = z.input<typeof inputSchema>;
type Expected = z.infer<typeof expected>;
const key = (s: Expected) =>
  hashValue([s.runId, s.modelHash, s.sampleId, s.track, s.protocolHash, s.confirmationKind]);
const groupKey = (s: Expected, target: number) =>
  hashValue([
    s.runId,
    s.modelHash,
    s.track,
    s.protocolHash,
    s.confirmationKind,
    s.horizonMs,
    target
  ]);
const percentile = (values: number[], fraction: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
};

/** The registered denominator is supplied separately: missing measurements cannot disappear. */
export function measurementReport(value: unknown) {
  const input = inputSchema.parse(value);
  const expectedById = new Map<string, Expected>();
  for (const s of input.expected) {
    if (expectedById.has(key(s))) throw new Error('DUPLICATE_EXPECTED_SAMPLE');
    if ((s.track === 'decision_market_replay_v1') !== (s.confirmationKind === 'DECISION'))
      throw new Error('CONFIRMATION_TRACK_MISMATCH');
    if (s.track !== 'card_reference_legacy' && s.horizonMs !== measurementProtocol.horizonMs)
      throw new Error('MEASUREMENT_HORIZON_MISMATCH');
    expectedById.set(key(s), s);
  }
  const measured = new Map<string, z.infer<typeof observation>>();
  for (const s of input.observations) {
    const original = expectedById.get(key(s));
    if (
      !original ||
      hashValue(original) !==
        hashValue(
          expected.parse(
            Object.fromEntries(Object.keys(identity).map((k) => [k, s[k as keyof typeof s]]))
          )
        )
    )
      throw new Error('UNREGISTERED_OR_CHANGED_SAMPLE');
    if (measured.has(key(s))) throw new Error('DUPLICATE_MEASUREMENT');
    if (new Set(s.targets.map((t) => t.target)).size !== s.targets.length)
      throw new Error('DUPLICATE_TARGET');
    if (s.baselineStatus === 'VALID') {
      if (
        s.availableAtMs === null ||
        (s.track !== 'card_reference_legacy' &&
          (s.confirmationAtMs === null ||
            s.availableAtMs < s.confirmationAtMs ||
            s.availableAtMs >
              s.confirmationAtMs +
                (s.track === 'decision_market_replay_v1'
                  ? 0
                  : measurementProtocol.baselineDeadlineMs)))
      )
        throw new Error('BASELINE_COORDINATE_MISMATCH');
      if (s.targets.some((t) => t.outcome === 'MISSING_BASELINE'))
        throw new Error('VALID_BASELINE_MARKED_MISSING');
    } else if (
      s.availableAtMs !== null ||
      s.targets.some(
        (t) =>
          t.outcome !== 'MISSING_BASELINE' &&
          !(s.baselineStatus === 'PENDING' && t.outcome === 'CENSORED')
      )
    )
      throw new Error('UNVERIFIED_BASELINE_HAS_OUTCOME');
    measured.set(key(s), s);
  }
  type Outcome = (typeof outcomes)[number];
  const groups = new Map<
    string,
    {
      runId: string;
      modelHash: string;
      track: Expected['track'];
      protocolHash: string;
      confirmationKind: Expected['confirmationKind'];
      horizonMs: number;
      target: number;
      counts: Record<Outcome, number>;
      baselineValid: number;
      baselinePending: number;
      missingMeasurements: number;
      reasons: Record<string, number>;
      waitsMs: number[];
      tokens: Set<string>;
    }
  >();
  for (const s of input.expected) {
    const observed = measured.get(key(s));
    for (const target of measurementProtocol.targets) {
      const id = groupKey(s, target);
      const group = groups.get(id) ?? {
        runId: s.runId,
        modelHash: s.modelHash,
        track: s.track,
        protocolHash: s.protocolHash,
        confirmationKind: s.confirmationKind,
        horizonMs: s.horizonMs,
        target,
        counts: Object.fromEntries(outcomes.map((o) => [o, 0])) as Record<Outcome, number>,
        baselineValid: 0,
        baselinePending: 0,
        missingMeasurements: 0,
        reasons: Object.create(null) as Record<string, number>,
        waitsMs: [],
        tokens: new Set<string>()
      };
      const targetResult = observed?.targets.find((t) => t.target === target);
      const result = targetResult ?? {
        outcome:
          observed?.baselineStatus === 'VALID' || observed?.baselineStatus === 'PENDING'
            ? 'CENSORED'
            : 'MISSING_BASELINE',
        reason:
          observed?.baselineStatus === 'VALID'
            ? 'OUTCOME_NOT_RECORDED'
            : (observed?.baselineReason ?? 'MEASUREMENT_NOT_RECORDED')
      };
      group.counts[result.outcome]++;
      group.reasons[result.reason] = (group.reasons[result.reason] ?? 0) + 1;
      group.tokens.add(s.token.toLowerCase());
      if (!observed) group.missingMeasurements++;
      if (observed?.baselineStatus === 'PENDING') group.baselinePending++;
      if (observed?.baselineStatus === 'VALID') {
        group.baselineValid++;
        // The card coordinate precedes confirmation; never report that as post-confirmation wait.
        if (s.track !== 'card_reference_legacy')
          group.waitsMs.push(observed.availableAtMs! - s.confirmationAtMs!);
      }
      groups.set(id, group);
    }
  }
  const report = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => {
      const { waitsMs, tokens, ...details } = g;
      const all = Object.values(g.counts).reduce((a, b) => a + b, 0);
      const determined = g.counts.TP + g.counts.SL + g.counts.NOT_TOUCHED;
      const uncertain = g.counts.UNKNOWN + g.counts.MISSING_BASELINE + g.counts.CENSORED;
      return {
        ...details,
        all,
        independentTokens: tokens.size,
        baselineCoverage: g.baselineValid / all,
        determinationCoverage: determined / all,
        tpAll: g.counts.TP / all,
        tpConditional: g.counts.TP + g.counts.SL ? g.counts.TP / (g.counts.TP + g.counts.SL) : null,
        successInterval: [g.counts.TP / all, (g.counts.TP + uncertain) / all],
        waitMs: {
          p50: percentile(waitsMs, 0.5),
          p95: percentile(waitsMs, 0.95),
          max: waitsMs.length ? Math.max(...waitsMs) : null
        }
      };
    });
  return {
    status: input.expected.length ? 'DIAGNOSTIC_REPORT' : 'NO_REGISTERED_SAMPLES',
    promotionCertificate: false,
    denominator: 'ALL_REGISTERED_SAMPLES_INCLUDING_MISSING',
    inputHash: hashValue(input),
    groups: report
  };
}

export function measurementReportMarkdown(report: ReturnType<typeof measurementReport>): string {
  return (
    `# 分轨测量报告\n\n状态：${report.status}。本报告不构成晋级凭据。\n\n` +
    '每个 run、模型、轨道、协议、确认类型、观察上限与目标独立统计；缺失测量保留在注册分母中。\n\n' +
    `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
  );
}
