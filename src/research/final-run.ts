import { z } from 'zod';
import type { Storage, SqliteDatabase } from '../storage/database.js';
import { hashValue } from './protocol.js';
import { semanticBuild, type FrozenContracts } from './contracts.js';
import { researchBudgetContractHash } from './budget-check.js';
import { evaluatePaired } from './validation.js';
import { pairedLedger, type DatasetManifest } from './ledger.js';
import { ResearchStorage } from './storage.js';

const planSchema = z
  .object({
    runId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    selectionId: z.string().regex(/^[a-f0-9]{64}$/),
    budgetEvidenceId: z.string().regex(/^[a-f0-9]{64}$/),
    startAtMs: z.number().int().nonnegative().safe()
  })
  .strict();
const DAY = 86400000;
export async function registerBudgetEvidence(storage: Storage, raw: unknown, now = Date.now()) {
  const report = raw as Record<string, unknown>;
  const { evidenceHash, ...body } = report;
  if (
    evidenceHash !== hashValue(body) ||
    body.status !== 'PASS' ||
    body.productionEnablement !== true ||
    body.scope !== 'RECORDED_ARRIVAL_MOCK_TRANSPORT' ||
    body.runtimeContractHash !== researchBudgetContractHash()
  )
    throw new Error('LIVE_BUDGET_EVIDENCE_REQUIRED');
  await storage.write(() =>
    storage.db
      .prepare('INSERT OR IGNORE INTO research_registrations VALUES (?,?,?,?,?,?)')
      .run(
        String(evidenceHash),
        'budget_evidence',
        String(body.workloadHash),
        now,
        hashValue(report),
        JSON.stringify(report)
      )
  );
  return { registrationId: evidenceHash };
}
export async function registerFinal(storage: Storage, raw: unknown, now = Date.now()) {
  const plan = planSchema.parse(raw);
  if (plan.startAtMs < now) throw new Error('FINAL_MUST_START_AFTER_REGISTRATION');
  return storage.transaction(() => {
    const db = storage.db;
    const selected = db
      .prepare(
        "SELECT manifest_json,manifest_hash FROM research_registrations WHERE registration_id=? AND kind='selection_result'"
      )
      .get(plan.selectionId) as { manifest_json: string; manifest_hash: string } | undefined;
    if (!selected) throw new Error('UNIQUE_SELECTION_REQUIRED');
    const selection = JSON.parse(selected.manifest_json) as {
      status: string;
      selectedHash: string;
      contracts: FrozenContracts | null;
    };
    if (
      hashValue(selection) !== selected.manifest_hash ||
      selection.status !== 'MARKET_MODEL_SELECTED' ||
      !selection.contracts ||
      selection.contracts.modelHash !== selection.selectedHash
    )
      throw new Error('NO_PROMOTABLE_MODEL');
    const contracts = selection.contracts;
    if (
      contracts.codeHash !== semanticBuild().hash ||
      contracts.budgetContractHash !== researchBudgetContractHash()
    )
      throw new Error('FROZEN_BUILD_CHANGED');
    const budget = db
      .prepare(
        "SELECT manifest_json FROM research_registrations WHERE registration_id=? AND kind='budget_evidence'"
      )
      .get(plan.budgetEvidenceId) as { manifest_json: string } | undefined;
    if (!budget) throw new Error('FINAL_BUDGET_REQUIRED');
    const budgetReport = JSON.parse(budget.manifest_json) as {
      runtimeContractHash: string;
      productionEnablement: boolean;
    };
    if (
      !budgetReport.productionEnablement ||
      budgetReport.runtimeContractHash !== contracts.budgetContractHash
    )
      throw new Error('FINAL_BUDGET_CHANGED');
    const manifest = {
      version: 1,
      ...plan,
      contracts,
      cutoffAtMs: plan.startAtMs + 30 * DAY,
      unsealAtMs: plan.startAtMs + 31 * DAY + 7200000,
      stopRule: 'FIXED_CUTOFF_NO_EXTENSION',
      unsealLimit: 1,
      independence: 'BSC_TOKEN_ACROSS_POOLS',
      confirmation: 'SIMULATED_1000MS_AND_ACTUAL_SEPARATE',
      publisherEnabled: false
    };
    const manifestHash = hashValue(manifest);
    if (
      new ResearchStorage(storage).estimatedBytes() +
        Buffer.byteLength(JSON.stringify(manifest)) +
        16384 >
      2 * 1024 ** 3
    )
      throw new Error('RESEARCH_STORAGE_BUDGET');
    db.prepare(
      "INSERT INTO research_runs(run_id,stage,manifest_json,manifest_hash,created_at_ms,cutoff_at_ms) VALUES (?,'D',?,?,?,?)"
    ).run(plan.runId, JSON.stringify(manifest), manifestHash, now, manifest.cutoffAtMs);
    return { runId: plan.runId, manifestHash, manifest };
  });
}
interface FinalManifest {
  version: number;
  runId: string;
  startAtMs: number;
  cutoffAtMs: number;
  unsealAtMs: number;
  contracts: FrozenContracts;
}
/** Early access is irrevocably a selection use; no independent certificate can survive it. */
export async function exposeFinal(storage: Storage, runId: string, now = Date.now()) {
  return storage.transaction(() => {
    const db = storage.db;
    const row = db
      .prepare("SELECT manifest_json FROM research_runs WHERE run_id=? AND stage='D'")
      .get(runId) as { manifest_json: string } | undefined;
    if (!row) throw new Error('FINAL_RUN_REQUIRED');
    db.prepare(
      "UPDATE research_runs SET consumed=1,status='CONSUMED_FOR_SELECTION' WHERE run_id=?"
    ).run(runId);
    db.prepare('UPDATE research_datasets SET consumed=1 WHERE run_id=?').run(runId);
    db.prepare('UPDATE dataset_memberships SET consumed=1 WHERE run_id=?').run(runId);
    db.prepare('UPDATE promotion_certificates SET revoked=1 WHERE run_id=?').run(runId);
    return { runId, status: 'CONSUMED_FOR_SELECTION', atMs: now };
  });
}
export async function closeDueFinalRuns(storage: Storage, now = Date.now()) {
  return storage.write(
    () =>
      storage.db
        .prepare(
          "UPDATE research_runs SET status='CLOSED' WHERE stage='D' AND status='ACTIVE' AND cutoff_at_ms<=?"
        )
        .run(now).changes
  );
}
export async function evaluateFinal(
  storage: Storage,
  runId: string,
  datasetId: string,
  now = Date.now()
) {
  // Hold the writer transaction through the single evaluation: concurrent unseals cannot both succeed.
  return storage.transaction(() => {
    const db = storage.db;
    const row = db
      .prepare(
        "SELECT manifest_json,manifest_hash,status,consumed FROM research_runs WHERE run_id=? AND stage='D'"
      )
      .get(runId) as
      | { manifest_json: string; manifest_hash: string; status: string; consumed: number }
      | undefined;
    if (!row || row.consumed || !['ACTIVE', 'CLOSED'].includes(row.status))
      throw new Error('FINAL_ALREADY_CONSUMED_OR_STOPPED');
    const manifest = JSON.parse(row.manifest_json) as FinalManifest;
    if (hashValue(manifest) !== row.manifest_hash || now < manifest.unsealAtMs)
      throw new Error('FINAL_NOT_MATURE');
    const dataset = db
      .prepare(
        "SELECT manifest_json,manifest_hash,consumed FROM research_datasets WHERE dataset_id=? AND run_id=? AND use_group='final'"
      )
      .get(datasetId, runId) as
      { manifest_json: string; manifest_hash: string; consumed: number } | undefined;
    if (!dataset || dataset.consumed) throw new Error('FINAL_DATASET_REQUIRED');
    const d = JSON.parse(dataset.manifest_json) as DatasetManifest;
    if (
      hashValue(d) !== dataset.manifest_hash ||
      d.plan.startAtMs !== manifest.startAtMs ||
      d.plan.cutoffAtMs !== manifest.cutoffAtMs ||
      d.plan.frozenAtMs < manifest.unsealAtMs
    )
      throw new Error('FINAL_WINDOW_CHANGED');
    const ledger = pairedLedger(
      db,
      d,
      manifest.contracts.modelHash,
      manifest.contracts.controlHash
    );
    const changed =
      manifest.contracts.codeHash !== semanticBuild().hash ||
      manifest.contracts.budgetContractHash !== researchBudgetContractHash();
    const statistical = evaluatePaired(ledger.pairs, row.manifest_hash);
    // Current facts-v1 explicitly cannot attest a market price clock. A statistical PASS alone cannot promote it.
    const missingSourceClock = db
      .prepare(
        `SELECT COUNT(*) AS n FROM evaluation_baselines b JOIN market_opportunities o ON o.opportunity_id=b.opportunity_id
      JOIN dataset_memberships m ON m.chain=o.chain AND m.token=o.token WHERE b.run_id=? AND m.dataset_hash=? AND b.track='post_confirmation_market_v1'
      AND b.status='VALID' AND (json_extract((SELECT envelope_json FROM research_facts WHERE fact_id=b.fact_id),'$.sourceAtMs') IS NULL
      OR json_extract((SELECT envelope_json FROM research_facts WHERE fact_id=b.fact_id),'$.sourceTimeStatus')!='VERIFIED')`
      )
      .get(runId, dataset.manifest_hash) as { n: number };
    const status = changed ? 'FAIL' : missingSourceClock.n ? 'INCONCLUSIVE' : statistical.status;
    const report = {
      version: 'final-evaluation-v1',
      runId,
      datasetId,
      datasetHash: dataset.manifest_hash,
      runHash: row.manifest_hash,
      contracts: manifest.contracts,
      ledgerHash: ledger.evidenceHash,
      statistical,
      status,
      reason: changed
        ? 'FROZEN_BUILD_CHANGED'
        : missingSourceClock.n
          ? 'PRICE_SOURCE_TIME_UNVERIFIED'
          : statistical.reason,
      evaluatedAtMs: now,
      datasetConsumed: true,
      promotionCertificate: status === 'PASS'
    };
    const id = hashValue(report);
    db.prepare('UPDATE research_runs SET consumed=1,status=? WHERE run_id=? AND consumed=0').run(
      status,
      runId
    );
    db.prepare('UPDATE research_datasets SET consumed=1 WHERE dataset_id=?').run(datasetId);
    db.prepare('UPDATE dataset_memberships SET consumed=1 WHERE dataset_hash=?').run(
      dataset.manifest_hash
    );
    db.prepare(
      'INSERT INTO promotion_certificates(certificate_id,run_id,manifest_hash,evidence_json,status) VALUES (?,?,?,?,?)'
    ).run(id, runId, hashValue(manifest.contracts), JSON.stringify(report), status);
    return { certificateId: id, ...report };
  });
}
/** Read-only check against local immutable DB evidence and the current semantic build. */
export function verifyPromotion(
  db: SqliteDatabase,
  certificateId: string,
  expected: FrozenContracts
) {
  const row = db
    .prepare(
      'SELECT run_id,manifest_hash,evidence_json,status,revoked FROM promotion_certificates WHERE certificate_id=?'
    )
    .get(certificateId) as
    | {
        run_id: string;
        manifest_hash: string;
        evidence_json: string;
        status: string;
        revoked: number;
      }
    | undefined;
  if (!row) return { status: 'INVALID', reason: 'CERTIFICATE_NOT_FOUND' };
  const report = JSON.parse(row.evidence_json) as {
    datasetId: string;
    datasetHash: string;
    contracts: FrozenContracts;
    promotionCertificate: boolean;
  };
  const run = db
    .prepare('SELECT status,consumed FROM research_runs WHERE run_id=?')
    .get(row.run_id) as { status: string; consumed: number } | undefined;
  const dataset = db
    .prepare('SELECT manifest_hash,consumed FROM research_datasets WHERE dataset_id=? AND run_id=?')
    .get(report.datasetId, row.run_id) as { manifest_hash: string; consumed: number } | undefined;
  if (
    row.status !== 'PASS' ||
    row.revoked ||
    hashValue(report) !== certificateId ||
    row.manifest_hash !== hashValue(expected) ||
    hashValue(report.contracts) !== hashValue(expected) ||
    expected.codeHash !== semanticBuild().hash ||
    expected.budgetContractHash !== researchBudgetContractHash() ||
    !report.promotionCertificate ||
    run?.status !== 'PASS' ||
    run.consumed !== 1 ||
    !dataset ||
    dataset.consumed !== 1 ||
    dataset.manifest_hash !== report.datasetHash
  )
    return { status: 'INVALID', reason: 'CERTIFICATE_PROVENANCE_OR_CONTRACT_MISMATCH' };
  return { status: 'VALID', certificateId, runId: row.run_id, contracts: expected };
}
