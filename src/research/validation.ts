import { z } from 'zod';
import { hashValue, outcomes } from './protocol.js';

const armSchema = z
  .object({
    baselineValid: z.boolean(),
    tp13: z.enum(
      outcomes as ['TP', 'SL', 'NOT_TOUCHED', 'CENSORED', 'UNKNOWN', 'MISSING_BASELINE']
    ),
    tp2: z.enum(outcomes as ['TP', 'SL', 'NOT_TOUCHED', 'CENSORED', 'UNKNOWN', 'MISSING_BASELINE']),
    preparationFailed: z.boolean(),
    roundTripLoss: z.number().min(0).max(1).nullable(),
    costEvidenceValid: z.boolean(),
    postBuyValid: z.boolean(),
    safetyBypassed: z.boolean()
  })
  .strict();
const pairsSchema = z
  .array(
    z
      .object({
        token: z.string().regex(/^0x[a-f0-9]{40}$/),
        model: armSchema.nullable(),
        control: armSchema.nullable()
      })
      .strict()
  )
  .max(10000);
export type ValidationArm = z.infer<typeof armSchema>;
export type ValidationPair = z.infer<typeof pairsSchema>[number];
const known = (o: string) => ['TP', 'SL', 'NOT_TOUCHED'].includes(o);
const unknown = (o: string) => ['UNKNOWN', 'MISSING_BASELINE', 'CENSORED'].includes(o);
const ratio = (n: number, d: number) => (d ? n / d : null);
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(q * ordered.length) - 1)]!;
}
function summary(arms: (ValidationArm | null)[]) {
  const qualified = arms.filter((a): a is ValidationArm => a !== null);
  const n = qualified.length;
  const costs = qualified
    .filter((a) => a.costEvidenceValid && !a.preparationFailed && a.roundTripLoss !== null)
    .map((a) => a.roundTripLoss!);
  return {
    n,
    baselineCoverage: ratio(qualified.filter((a) => a.baselineValid).length, n),
    coverage13: ratio(qualified.filter((a) => a.baselineValid && known(a.tp13)).length, n),
    coverage2: ratio(qualified.filter((a) => a.baselineValid && known(a.tp2)).length, n),
    tp13: ratio(qualified.filter((a) => a.tp13 === 'TP').length, n),
    tp2: ratio(qualified.filter((a) => a.tp2 === 'TP').length, n),
    sl: ratio(qualified.filter((a) => a.tp13 === 'SL').length, n),
    unknown13: ratio(qualified.filter((a) => unknown(a.tp13)).length, n),
    capture13: ratio(qualified.filter((a) => a.tp13 === 'TP').length, arms.length),
    capture2: ratio(qualified.filter((a) => a.tp2 === 'TP').length, arms.length),
    costCoverage: ratio(costs.length, n),
    postBuyCoverage: ratio(qualified.filter((a) => a.postBuyValid).length, n),
    medianCost: quantile(costs, 0.5),
    p95Cost: quantile(costs, 0.95),
    preparationFailure: ratio(qualified.filter((a) => a.preparationFailed).length, n),
    safetyBypasses: qualified.filter((a) => a.safetyBypassed).length
  };
}
const difference = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a - b;
function metrics(pairs: ValidationPair[]) {
  const m = summary(pairs.map((p) => p.model)),
    c = summary(pairs.map((p) => p.control));
  return {
    tp13: difference(m.tp13, c.tp13),
    tp2: difference(m.tp2, c.tp2),
    capture13: difference(m.capture13, c.capture13),
    capture2: difference(m.capture2, c.capture2),
    sl: difference(m.sl, c.sl),
    medianCost: difference(m.medianCost, c.medianCost),
    p95Cost: difference(m.p95Cost, c.p95Cost),
    preparationFailure: difference(m.preparationFailure, c.preparationFailure),
    conservative13:
      m.tp13 === null || c.tp13 === null || c.unknown13 === null
        ? null
        : m.tp13 - c.tp13 - c.unknown13
  };
}
export function validatePairs(raw: unknown): ValidationPair[] {
  const pairs = pairsSchema.parse(raw);
  if (new Set(pairs.map((p) => p.token)).size !== pairs.length)
    throw new Error('DUPLICATE_TOKEN_ACROSS_POOLS');
  for (const pair of pairs)
    for (const arm of [pair.model, pair.control]) {
      if (!arm) continue;
      if (
        (!arm.baselineValid && (known(arm.tp13) || known(arm.tp2))) ||
        (arm.preparationFailed &&
          (arm.baselineValid || arm.costEvidenceValid || arm.postBuyValid)) ||
        (arm.costEvidenceValid && arm.roundTripLoss === null)
      )
        throw new Error('INCONSISTENT_VALIDATION_EVIDENCE');
    }
  return [...pairs].sort((a, b) => a.token.localeCompare(b.token));
}
/** Statistical calculation is not a promotion certificate. Production additionally requires frozen run provenance. */
export function evaluatePaired(raw: unknown, runHash: string) {
  if (!/^[a-f0-9]{64}$/.test(runHash)) throw new Error('INVALID_RUN_HASH');
  const pairs = validatePairs(raw);
  const model = summary(pairs.map((p) => p.model)),
    control = summary(pairs.map((p) => p.control));
  const coverage = [model, control].every(
    (a) =>
      a.n >= 100 &&
      [a.baselineCoverage, a.coverage13, a.coverage2, a.costCoverage, a.postBuyCoverage].every(
        (v) => v !== null && v >= 0.8
      )
  );
  const base = {
    version: 'paired-bootstrap-v1',
    runHash,
    datasetHash: hashValue(pairs),
    universeTokens: pairs.length,
    model,
    control,
    promotionCertificate: false as const
  };
  if (model.safetyBypasses + control.safetyBypasses)
    return { ...base, status: 'FAIL', reason: 'SAFETY_BYPASS', bounds: null };
  if (!coverage)
    return { ...base, status: 'INCONCLUSIVE', reason: 'SAMPLE_OR_COVERAGE', bounds: null };
  let seed = parseInt(runHash.slice(0, 8), 16) || 1;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const distributions: Record<string, number[]> = {};
  for (let iteration = 0; iteration < 10000; iteration++) {
    const sample = Array.from(
      { length: pairs.length },
      () => pairs[Math.floor(random() * pairs.length)]!
    );
    for (const [key, value] of Object.entries(metrics(sample))) {
      if (value === null || !Number.isFinite(value))
        return {
          ...base,
          status: 'INCONCLUSIVE',
          reason: 'UNDEFINED_BOOTSTRAP_DENOMINATOR',
          bounds: null
        };
      (distributions[key] ??= []).push(value);
    }
  }
  const bounds = Object.fromEntries(
    Object.entries(distributions).map(([key, values]) => [
      key,
      { lower95: quantile(values, 0.05)!, upper95: quantile(values, 0.95)! }
    ])
  );
  if (bounds.conservative13!.lower95 <= 0)
    return { ...base, status: 'INCONCLUSIVE', reason: 'INCONCLUSIVE_MISSINGNESS', bounds };
  const pass =
    bounds.tp13!.lower95 > 0 &&
    bounds.tp2!.lower95 >= -0.05 &&
    bounds.capture13!.lower95 >= -0.02 &&
    bounds.capture2!.lower95 >= -0.02 &&
    bounds.sl!.upper95 <= 0.02 &&
    bounds.medianCost!.upper95 <= 0.01 &&
    bounds.p95Cost!.upper95 <= 0.01 &&
    bounds.preparationFailure!.upper95 <= 0.02;
  return {
    ...base,
    status: pass ? 'PASS' : 'FAIL',
    reason: pass ? 'STATISTICAL_GATES_ONLY' : 'JOINT_GATE_FAILED',
    bounds
  };
}

export function selectModel(candidates: { hash: string; conditions: number; pairs: unknown }[]) {
  if (candidates.length > 12 || new Set(candidates.map((c) => c.hash)).size !== candidates.length)
    throw new Error('CANDIDATE_REGISTRATION_BOUND');
  let controlHash: string | null = null;
  const reports = candidates.map((candidate) => {
    if (
      !/^[a-f0-9]{64}$/.test(candidate.hash) ||
      !Number.isInteger(candidate.conditions) ||
      candidate.conditions < 1
    )
      throw new Error('INVALID_CANDIDATE_IDENTITY');
    const pairs = validatePairs(candidate.pairs);
    const commonHash = hashValue(pairs.map((p) => ({ token: p.token, control: p.control })));
    if (controlHash !== null && controlHash !== commonHash)
      throw new Error('CONTROL_OR_UNIVERSE_CHANGED');
    controlHash = commonHash;
    const model = summary(pairs.map((p) => p.model)),
      control = summary(pairs.map((p) => p.control));
    const eligible =
      [model, control].every(
        (a) =>
          a.n >= 100 &&
          [a.baselineCoverage, a.coverage13, a.coverage2].every((v) => v !== null && v >= 0.8)
      ) &&
      model.capture13! >= control.capture13! &&
      model.capture2! >= control.capture2!;
    return {
      hash: candidate.hash,
      conditions: candidate.conditions,
      eligible,
      delta13: difference(model.tp13, control.tp13),
      delta2: difference(model.tp2, control.tp2)
    };
  });
  const selected = reports
    .filter((r) => r.eligible)
    .sort(
      (a, b) =>
        b.delta13! - a.delta13! ||
        b.delta2! - a.delta2! ||
        a.conditions - b.conditions ||
        a.hash.localeCompare(b.hash)
    )[0];
  return {
    status: selected ? 'MARKET_MODEL_SELECTED' : 'NO_PROMOTABLE_MODEL',
    selectedHash: selected?.hash ?? null,
    reports,
    promotionCertificate: false
  };
}
