import { ResearchArchive } from './archive.js';
import { dirname, join } from 'node:path';
import type { DatasetManifest } from './ledger.js';
import { z } from 'zod';
import { validateModel, fieldSamples } from '../decision/model.js';
import { hashValue } from './protocol.js';
import { quantile } from './validation.js';
import type { Storage } from '../storage/database.js';
import { ResearchStorage } from './storage.js';
const point = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('business'),
      value: z.number().finite(),
      rationale: z.string().min(1)
    })
    .strict(),
  z
    .object({ kind: z.literal('quantile'), field: z.string().min(1), q: z.number().min(0).max(1) })
    .strict()
]);
const schema = z
  .object({
    developmentDatasetHash: z.string().regex(/^[a-f0-9]{64}$/),
    cutoffAtMs: z.number().int().nonnegative().safe(),
    observations: z
      .array(
        z
          .object({
            field: z.string().min(1),
            factId: z.string().min(1).optional(),
            value: z.number().finite(),
            availableAtMs: z.number().int().nonnegative().safe()
          })
          .strict()
      )
      .max(100000),
    groups: z
      .array(
        z
          .object({
            method: z.enum(['immediate', 'short_confirmation', 'pullback']),
            template: z.unknown(),
            combinations: z.array(z.record(point)).min(1).max(4)
          })
          .strict()
      )
      .min(1)
      .max(3)
  })
  .strict();
/** A finite registered grid. No optimization against selection/final labels is performed here. */
export function generateCandidates(raw: unknown) {
  const plan = schema.parse(raw);
  if (new Set(plan.groups.map((g) => g.method)).size !== plan.groups.length)
    throw new Error('DUPLICATE_CONFIRMATION_METHOD');
  if (plan.observations.some((o) => o.availableAtMs > plan.cutoffAtMs))
    throw new Error('FUTURE_DEVELOPMENT_INPUT');
  const distributions = Object.fromEntries(
    [...new Set(plan.observations.map((o) => o.field))].sort().map((field) => {
      const values = plan.observations.filter((o) => o.field === field).map((o) => o.value);
      return [
        field,
        {
          n: values.length,
          min: quantile(values, 0),
          p25: quantile(values, 0.25),
          p50: quantile(values, 0.5),
          p75: quantile(values, 0.75),
          max: quantile(values, 1)
        }
      ];
    })
  );
  const candidates: {
    method: string;
    hash: string;
    manifest: ReturnType<typeof validateModel>['manifest'];
    derivation: unknown;
  }[] = [];
  const rejected: { method: string; combination: number; reason: string }[] = [];
  for (const group of plan.groups)
    for (const [index, combination] of group.combinations.entries()) {
      try {
        const template = validateModel(group.template).manifest;
        if (
          Object.keys(combination).sort().join(',') !==
          Object.keys(template.parameters).sort().join(',')
        )
          throw new Error('COMPLETE_PARAMETER_GRID_REQUIRED');
        const parameters: Record<string, number> = {};
        for (const [name, p] of Object.entries(combination)) {
          const value =
            p.kind === 'business'
              ? p.value
              : quantile(
                  plan.observations.filter((o) => o.field === p.field).map((o) => o.value),
                  p.q
                );
          if (value === null) throw new Error('UNSUPPORTED_PARAMETER_DISTRIBUTION');
          parameters[name] = value;
        }
        const model = validateModel({ ...template, parameters });
        if (candidates.some((c) => c.hash === model.hash)) throw new Error('DUPLICATE_MODEL');
        candidates.push({
          method: group.method,
          hash: model.hash,
          manifest: model.manifest,
          derivation: combination
        });
      } catch (error) {
        rejected.push({
          method: group.method,
          combination: index,
          reason:
            error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
              ? error.message
              : 'INVALID_MODEL_CONTRACT'
        });
      }
    }
  return {
    version: 'finite-candidates-v1',
    status: candidates.length ? 'GENERATED_CANDIDATES' : 'NO_PROMOTABLE_MODEL',
    developmentDatasetHash: plan.developmentDatasetHash,
    planHash: hashValue(plan),
    distributions,
    candidates,
    rejected,
    sampleRule: 'FIRST_MARKET_QUALIFIED_OPPORTUNITY_PER_TOKEN',
    promotionCertificate: false,
    limitation:
      'Overlapping rolling-window observations are dependent; quantiles do not imply independent samples.'
  };
}

export async function registerCandidates(storage: Storage, raw: unknown) {
  const plan = schema.parse(raw),
    report = generateCandidates(plan);
  const datasetRow = storage.db
    .prepare(
      "SELECT manifest_json FROM research_datasets WHERE manifest_hash=? AND use_group='development'"
    )
    .get(plan.developmentDatasetHash) as { manifest_json: string } | undefined;
  if (!datasetRow) throw new Error('DEVELOPMENT_DATASET_REQUIRED');
  const datasetManifest = JSON.parse(datasetRow.manifest_json) as DatasetManifest;
  const archive = new ResearchArchive(
    new ResearchStorage(storage),
    join(dirname(storage.db.name), 'research-archives')
  );
  const templates = plan.groups.map((g) => validateModel(g.template).manifest);
  for (const o of plan.observations) {
    if (!o.factId || !datasetManifest.facts.some((f) => f.fact_id === o.factId))
      throw new Error('DEVELOPMENT_OBSERVATION_PROVENANCE_REQUIRED');
    const fact = await archive.resolve(o.factId);
    const sources = templates.filter((t) => o.field in t.fields);
    if (
      !sources.length ||
      sources.some(
        (t) =>
          !fieldSamples(o.field, {
            model: t,
            token: fact.token ?? '',
            poolRevision: fact.poolRevision,
            evaluationAtMs: o.availableAtMs,
            facts: [fact]
          }).some((s) => s.fact.factId === o.factId && s.value.eq(o.value))
      )
    )
      throw new Error('DEVELOPMENT_OBSERVATION_CHANGED');
  }
  return storage.transaction(() => {
    const db = storage.db;
    const dataset = db
      .prepare(
        "SELECT cutoff_at_ms FROM research_datasets WHERE manifest_hash=? AND use_group='development'"
      )
      .get(plan.developmentDatasetHash) as { cutoff_at_ms: number } | undefined;
    if (!dataset || plan.cutoffAtMs > dataset.cutoff_at_ms)
      throw new Error('DEVELOPMENT_DATASET_REQUIRED');
    const text = JSON.stringify(report),
      hash = hashValue(report);
    if (
      new ResearchStorage(storage).estimatedBytes() + Buffer.byteLength(text) + 16384 >
      2 * 1024 ** 3
    )
      throw new Error('RESEARCH_STORAGE_BUDGET');
    db.prepare('INSERT OR IGNORE INTO research_registrations VALUES (?,?,?,?,?,?)').run(
      report.planHash,
      'candidate_plan',
      plan.developmentDatasetHash,
      Date.now(),
      hash,
      text
    );
    return { ...report, registrationId: report.planHash };
  });
}
