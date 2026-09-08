import assert from 'node:assert/strict';
import test from 'node:test';
import { Storage } from '../../src/storage/database.js';
import { hashValue } from '../../src/research/protocol.js';
import { frozenContracts, semanticBuild } from '../../src/research/contracts.js';
import { budgetCheck } from '../../src/research/budget-check.js';
import {
  registerBudgetEvidence,
  registerFinal,
  evaluateFinal,
  exposeFinal,
  verifyPromotion,
  closeDueFinalRuns
} from '../../src/research/final-run.js';
import { registerSelection, runSelection } from '../../src/research/selection.js';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { runtimeConfigSchema } from '../../src/config/load.js';
const hash = (s: string) => hashValue(s),
  start = 1800000000000,
  DAY = 86400000;
async function fixture() {
  const storage = await Storage.open(':memory:');
  const contracts = frozenContracts(hash('model'), hash('risk'), hash('control'));
  const selection = {
    status: 'MARKET_MODEL_SELECTED',
    selectedHash: contracts.modelHash,
    contracts
  };
  storage.db
    .prepare('INSERT INTO research_registrations VALUES (?,?,?,?,?,?)')
    .run(
      hash('selected'),
      'selection_result',
      hash('selection-data'),
      start - 1000,
      hashValue(selection),
      JSON.stringify(selection)
    );
  const evidence = await budgetCheck(1000, undefined, 'RECORDED');
  await registerBudgetEvidence(storage, evidence, start - 1000);
  const registered = await registerFinal(
    storage,
    {
      runId: 'final',
      selectionId: hash('selected'),
      budgetEvidenceId: evidence.evidenceHash,
      startAtMs: start
    },
    start - 500
  );
  const manifest = {
    plan: {
      runId: 'final',
      use: 'final',
      startAtMs: start,
      cutoffAtMs: start + 30 * DAY,
      frozenAtMs: registered.manifest.unsealAtMs
    },
    tokens: [],
    facts: []
  };
  storage.db
    .prepare(
      "INSERT INTO research_datasets(dataset_id,run_id,use_group,start_at_ms,cutoff_at_ms,frozen_at_ms,manifest_hash,manifest_json) VALUES ('d','final','final',?,?,?,?,?)"
    )
    .run(
      start,
      manifest.plan.cutoffAtMs,
      manifest.plan.frozenAtMs,
      hashValue(manifest),
      JSON.stringify(manifest)
    );
  return { storage, registered, contracts };
}
void test('final fixes 30 days and 26-hour maturity; early evaluate leaves it sealed; only one mature evaluation consumes data', async () => {
  const { storage, registered, contracts } = await fixture();
  try {
    assert.equal(registered.manifest.cutoffAtMs, start + 30 * DAY);
    assert.equal(registered.manifest.unsealAtMs, start + 31 * DAY + 7200000);
    await assert.rejects(
      evaluateFinal(storage, 'final', 'd', registered.manifest.unsealAtMs - 1),
      /NOT_MATURE/
    );
    assert.equal(
      (
        storage.db.prepare("SELECT consumed FROM research_runs WHERE run_id='final'").get() as {
          consumed: number;
        }
      ).consumed,
      0
    );
    assert.equal(await closeDueFinalRuns(storage, start + 30 * DAY), 1);
    const result = await evaluateFinal(storage, 'final', 'd', registered.manifest.unsealAtMs);
    assert.equal(result.status, 'INCONCLUSIVE');
    assert.equal(result.promotionCertificate, false);
    assert.equal(verifyPromotion(storage.db, result.certificateId, contracts).status, 'INVALID');
    await assert.rejects(
      evaluateFinal(storage, 'final', 'd', registered.manifest.unsealAtMs + 1),
      /ALREADY_CONSUMED/
    );
  } finally {
    storage.close();
  }
});
void test('early exposure consumes the run; invalid and synthetic provenance cannot activate a final model', async () => {
  const { storage, registered, contracts } = await fixture();
  try {
    await exposeFinal(storage, 'final', start + 1000);
    await assert.rejects(
      evaluateFinal(storage, 'final', 'd', registered.manifest.unsealAtMs),
      /ALREADY_CONSUMED/
    );
    await assert.rejects(registerBudgetEvidence(storage, await budgetCheck()), /LIVE_BUDGET/);
    await assert.rejects(
      registerFinal(
        storage,
        {
          runId: 'x',
          selectionId: hash('missing'),
          budgetEvidenceId: hash('budget'),
          startAtMs: start
        },
        start - 1
      ),
      /UNIQUE_SELECTION/
    );
    assert.equal(verifyPromotion(storage.db, hash('arbitrary-stats'), contracts).status, 'INVALID');
    assert.equal(semanticBuild().hash, semanticBuild().hash);
  } finally {
    storage.close();
  }
});
void test('selection consumes a registered independent dataset and reports no model for unsupported/no evidence', async () => {
  const storage = await Storage.open(':memory:');
  const config = runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')));
  try {
    const candidate = { candidates: [] };
    storage.db
      .prepare('INSERT INTO research_registrations VALUES (?,?,?,?,?,?)')
      .run(
        hash('c'),
        'candidate_plan',
        hash('dev'),
        start - 1000,
        hashValue(candidate),
        JSON.stringify(candidate)
      );
    await assert.rejects(
      registerSelection(storage, hash('c'), start - 2, config, start),
      /PREREGISTERED/
    );
    const registration = await registerSelection(storage, hash('c'), start, config, start - 1);
    storage.db
      .prepare(
        "INSERT INTO research_runs(run_id,stage,manifest_json,manifest_hash,created_at_ms) VALUES ('selection','C','{}',?,?)"
      )
      .run(hashValue({}), start);
    const manifest = {
      plan: {
        runId: 'selection',
        use: 'selection',
        startAtMs: start,
        cutoffAtMs: start + DAY,
        frozenAtMs: start + 2 * DAY
      },
      tokens: [],
      facts: []
    };
    storage.db
      .prepare(
        "INSERT INTO research_datasets(dataset_id,run_id,use_group,start_at_ms,cutoff_at_ms,frozen_at_ms,manifest_hash,manifest_json) VALUES ('s','selection','selection',?,?,?,?,?)"
      )
      .run(start, start + DAY, start + 2 * DAY, hashValue(manifest), JSON.stringify(manifest));
    const changed = structuredClone(config);
    changed.security.max_buy_tax = 0.9;
    await assert.rejects(
      runSelection(storage, registration.registrationId, 's', changed),
      /FROZEN_POLICY_CHANGED/
    );
    const result = await runSelection(storage, registration.registrationId, 's', config);
    assert.equal(result.status, 'NO_PROMOTABLE_MODEL');
    assert.equal(result.model, null);
    assert.equal(result.contracts, null);
    await assert.rejects(
      runSelection(storage, registration.registrationId, 's', config),
      /UNCONSUMED/
    );
  } finally {
    storage.close();
  }
});

void test('promotion is bound to DB evidence, all semantic hashes and revocation; a copied JSON PASS is insufficient', async () => {
  const { storage, registered, contracts } = await fixture();
  try {
    const dataset = storage.db
      .prepare("SELECT manifest_hash FROM research_datasets WHERE dataset_id='d'")
      .get() as { manifest_hash: string };
    // A trusted DB fixture, not an evaluation result or a deployable production certificate.
    const report = {
      datasetId: 'd',
      datasetHash: dataset.manifest_hash,
      contracts,
      promotionCertificate: true
    };
    const id = hashValue(report);
    storage.db
      .prepare("UPDATE research_runs SET consumed=1,status='PASS' WHERE run_id='final'")
      .run();
    storage.db.prepare("UPDATE research_datasets SET consumed=1 WHERE dataset_id='d'").run();
    storage.db
      .prepare("INSERT INTO promotion_certificates VALUES (?,'final',?,?,'PASS',0)")
      .run(id, hashValue(contracts), JSON.stringify(report));
    assert.equal(verifyPromotion(storage.db, id, contracts).status, 'VALID');
    for (const key of [
      'modelHash',
      'riskHash',
      'controlHash',
      'codeHash',
      'marketProtocolHash',
      'quoteProtocolHash',
      'budgetContractHash'
    ] as const)
      assert.equal(
        verifyPromotion(storage.db, id, { ...contracts, [key]: hash('changed') }).status,
        'INVALID'
      );
    await exposeFinal(storage, 'final', registered.manifest.unsealAtMs + 1);
    assert.equal(verifyPromotion(storage.db, id, contracts).status, 'INVALID');
  } finally {
    storage.close();
  }
});
