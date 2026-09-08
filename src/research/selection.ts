import type { Storage } from '../storage/database.js';
import type { RuntimeConfig } from '../config/types.js';
import { hashValue } from './protocol.js';
import { frozenContracts } from './contracts.js';
import { riskPolicyHash, assessRiskBundle, type RiskBundle } from '../decision/preparation.js';
import { replay } from './replay.js';
import type { ModelManifest } from '../decision/model.js';
import type { MarketFact } from '../gmgn/facts.js';
import type { NormalizedEvent } from '../discovery/events.js';
import { ResearchStorage } from './storage.js';
import { ResearchArchive } from './archive.js';
import { dirname, join } from 'node:path';
import { selectModel, type ValidationPair, type ValidationArm } from './validation.js';
import { marketBaseline, firstTouch, type PathCandle } from './measurement.js';
import type { DatasetManifest } from './ledger.js';
import { assessCoordinatedExit } from '../safety/coordinated-exit.js';

export const controlPolicyHash = (config: RuntimeConfig) =>
  hashValue({
    strategy: config.strategy,
    scoring: config.scoring,
    evidence: config.evidence,
    optimization: config.optimization
  });
export async function registerSelection(
  storage: Storage,
  candidatePlanId: string,
  startAtMs: number,
  config: RuntimeConfig,
  now = Date.now()
) {
  if (!Number.isSafeInteger(startAtMs) || startAtMs < now)
    throw new Error('SELECTION_MUST_BE_PREREGISTERED');
  return storage.transaction(() => {
    const row = storage.db
      .prepare(
        "SELECT manifest_hash,created_at_ms FROM research_registrations WHERE registration_id=? AND kind='candidate_plan'"
      )
      .get(candidatePlanId) as { manifest_hash: string; created_at_ms: number } | undefined;
    if (!row || row.created_at_ms > now) throw new Error('CANDIDATE_PLAN_REQUIRED');
    const manifest = {
      candidatePlanId,
      candidateReportHash: row.manifest_hash,
      startAtMs,
      createdAtMs: now,
      controlHash: controlPolicyHash(config),
      riskHash: riskPolicyHash(config),
      codeHash: frozenContracts(
        hashValue('selection'),
        riskPolicyHash(config),
        controlPolicyHash(config)
      ).codeHash
    };
    const id = hashValue(manifest);
    storage.db
      .prepare('INSERT INTO research_registrations VALUES (?,?,?,?,?,?)')
      .run(id, 'selection_plan', candidatePlanId, now, id, JSON.stringify(manifest));
    return { registrationId: id, ...manifest };
  });
}
function riskBundle(
  facts: MarketFact[],
  token: string,
  poolRevision: string,
  atMs: number,
  config: RuntimeConfig
): RiskBundle | null {
  const available = facts.filter((f) => f.receivedAtMs <= atMs);
  const get = (endpoint: string) =>
    available
      .filter(
        (f) => f.token === token && f.poolRevision === poolRevision && f.endpoint === endpoint
      )
      .at(-1);
  const info = get('info'),
    security = get('security'),
    pool = get('pool'),
    holders = get('holders'),
    traders = get('traders');
  if (!info || !security || !pool || !holders || !traders) return null;
  const creator =
    (info.payload.dev as { creator_address?: string } | undefined)?.creator_address ??
    (info.payload.pool as { creator?: string } | undefined)?.creator;
  const created = available
    .filter((f) => f.endpoint === 'created_tokens' && f.request.wallet_address === creator)
    .at(-1);
  if (!created) return null;
  const prior = available
    .filter(
      (f) =>
        f.token === token &&
        f.poolRevision === poolRevision &&
        f.endpoint === 'traders' &&
        f.receivedAtMs < traders.requestedAtMs
    )
    .at(-1);
  return {
    token,
    poolRevision,
    info,
    security,
    pool,
    holders,
    traders,
    created,
    facts: available,
    ...(prior
      ? {
          traderBaseline: assessCoordinatedExit(
            Array.isArray(prior.payload.list)
              ? (prior.payload.list as Record<string, unknown>[])
              : [],
            undefined,
            prior.receivedAtMs,
            config.security.lazy_deep.coordinated_exit
          ).snapshot
        }
      : {})
  };
}
/** Offline selection from a pre-registered finite candidate set and frozen facts. No clients/transports. */
export async function runSelection(
  storage: Storage,
  registrationId: string,
  datasetId: string,
  config: RuntimeConfig
) {
  const db = storage.db;
  const registration = db
    .prepare(
      "SELECT manifest_json FROM research_registrations WHERE registration_id=? AND kind='selection_plan'"
    )
    .get(registrationId) as { manifest_json: string } | undefined;
  if (!registration) throw new Error('SELECTION_PREREGISTRATION_REQUIRED');
  const plan = JSON.parse(registration.manifest_json) as {
    candidatePlanId: string;
    candidateReportHash: string;
    startAtMs: number;
    controlHash: string;
    riskHash: string;
    codeHash: string;
  };
  if (
    plan.controlHash !== controlPolicyHash(config) ||
    plan.riskHash !== riskPolicyHash(config) ||
    plan.codeHash !==
      frozenContracts(hashValue('selection'), riskPolicyHash(config), controlPolicyHash(config))
        .codeHash
  )
    throw new Error('SELECTION_FROZEN_POLICY_CHANGED');
  const dataset = db
    .prepare(
      "SELECT manifest_json,manifest_hash,consumed FROM research_datasets WHERE dataset_id=? AND use_group='selection'"
    )
    .get(datasetId) as
    { manifest_json: string; manifest_hash: string; consumed: number } | undefined;
  if (!dataset || dataset.consumed) throw new Error('UNCONSUMED_SELECTION_DATA_REQUIRED');
  const manifest = JSON.parse(dataset.manifest_json) as DatasetManifest;
  if (manifest.plan.startAtMs < plan.startAtMs)
    throw new Error('SELECTION_DATA_PRECEDES_REGISTRATION');
  const candidateRow = db
    .prepare(
      "SELECT manifest_json,manifest_hash FROM research_registrations WHERE registration_id=? AND kind='candidate_plan'"
    )
    .get(plan.candidatePlanId) as { manifest_json: string; manifest_hash: string } | undefined;
  if (!candidateRow || candidateRow.manifest_hash !== plan.candidateReportHash)
    throw new Error('CANDIDATE_PLAN_CHANGED');
  const candidateReport = JSON.parse(candidateRow.manifest_json) as {
    candidates: { hash: string; manifest: ModelManifest }[];
  };
  const archive = new ResearchArchive(
    new ResearchStorage(storage),
    join(dirname(db.name), 'research-archives')
  );
  const facts: MarketFact[] = [];
  for (const f of manifest.facts) {
    const fact = await archive.resolve(f.fact_id);
    if (fact.semanticHash !== f.semantic_hash) throw new Error('FROZEN_FACT_CHANGED');
    facts.push(fact);
  }
  facts.sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.factId.localeCompare(b.factId));
  const tokenSet = new Set(manifest.tokens.map((t) => t.token));
  const frames = facts
    .filter(
      (f) =>
        f.endpoint === 'info' &&
        f.token &&
        tokenSet.has(f.token) &&
        f.receivedAtMs >= manifest.plan.startAtMs &&
        f.receivedAtMs < manifest.plan.cutoffAtMs
    )
    .map((f) => ({ token: f.token!, poolRevision: f.poolRevision, atMs: f.receivedAtMs }));
  // The immutable event envelopes were persisted before legacy market qualification.
  const rows = db
    .prepare(
      'SELECT normalized_json FROM events WHERE observed_at_ms>=? AND observed_at_ms<? ORDER BY observed_at_ms,event_key'
    )
    .all(manifest.plan.startAtMs, manifest.plan.cutoffAtMs) as { normalized_json: string }[];
  const events = rows
    .map((r) => JSON.parse(r.normalized_json) as NormalizedEvent)
    .filter((e) => tokenSet.has(e.tokenAddress));
  const replayed = candidateReport.candidates.length
    ? await replay({
        models: candidateReport.candidates.map((c) => c.manifest),
        facts,
        frames,
        events,
        legacyConfig: config
      })
    : null;
  const arms = new Map<string, ValidationArm>();
  let safetyUnknown = 0;
  for (const unknown of replayed?.decisions ?? []) {
    const d = unknown as {
      token: string;
      poolRevision: string;
      atMs: number;
      model: string;
      decision: {
        market?: string;
        state?: {
          status: string;
          opportunityId: string;
          activationFactId: string;
          anchorPrice: string;
          anchorAtMs: number;
        };
      };
    };
    const key = d.model + ':' + d.token;
    if (
      arms.has(key) ||
      !(d.model === 'legacy' ? d.decision.market === 'PASS' : d.decision.state?.status === 'READY')
    )
      continue;
    const b = riskBundle(facts, d.token, d.poolRevision, d.atMs, config);
    if (!b) {
      safetyUnknown++;
      continue;
    }
    const ctx = {
      format: 'opportunity-v1' as const,
      token: d.token,
      poolRevision: d.poolRevision,
      modelHash: d.model === 'legacy' ? controlPolicyHash(config) : d.model,
      riskHash: riskPolicyHash(config),
      opportunityId: d.decision.state?.opportunityId ?? hashValue(key),
      activationFactId: b.info.factId,
      anchorPrice: d.decision.state?.anchorPrice ?? '1',
      anchorAtMs: d.atMs
    };
    if (await assessRiskBundle(b, ctx, config, d.atMs)) {
      safetyUnknown++;
      continue;
    }
    const baseline = marketBaseline({
      token: d.token,
      poolRevision: d.poolRevision,
      confirmationAtMs: d.atMs,
      nowMs: d.atMs,
      facts: b.facts,
      preparationComplete: true,
      track: 'decision_market_replay_v1'
    });
    const candles: PathCandle[] = facts
      .filter(
        (f) =>
          f.token === d.token &&
          f.poolRevision === d.poolRevision &&
          f.endpoint === 'kline' &&
          f.request.resolution === '30s' &&
          !f.qualityFlags.length
      )
      .flatMap((f) =>
        (Array.isArray(f.payload.list) ? (f.payload.list as Record<string, unknown>[]) : []).map(
          (c) => ({
            startMs: Number(c.time),
            endMs: Number(c.time) + 30000,
            receivedAtMs: f.receivedAtMs,
            open: String(c.open),
            close: String(c.close),
            high: String(c.high),
            low: String(c.low)
          })
        )
      );
    arms.set(key, {
      baselineValid: baseline.status === 'VALID',
      tp13: firstTouch(baseline, 1.3, candles, manifest.plan.frozenAtMs).outcome,
      tp2: firstTouch(baseline, 2, candles, manifest.plan.frozenAtMs).outcome,
      preparationFailed: false,
      roundTripLoss: null,
      costEvidenceValid: false,
      postBuyValid: false,
      safetyBypassed: false
    });
  }
  const candidates = candidateReport.candidates.map((c) => ({
    hash: c.hash,
    conditions: JSON.stringify([
      c.manifest.activation,
      c.manifest.confirmation,
      c.manifest.entry,
      c.manifest.invalidation,
      c.manifest.reset
    ]).split('"op"').length,
    pairs: manifest.tokens.map((t) => ({
      token: t.token,
      model: arms.get(c.hash + ':' + t.token) ?? null,
      control: arms.get('legacy:' + t.token) ?? null
    })) satisfies ValidationPair[]
  }));
  const selected = selectModel(candidates);
  const chosen = candidateReport.candidates.find((c) => c.hash === selected.selectedHash);
  const report = {
    ...selected,
    registrationId,
    datasetId,
    datasetHash: dataset.manifest_hash,
    replayHash: replayed?.decisionHash ?? null,
    safetyUnknown,
    execution: 'NOT_EVALUATED',
    model: chosen?.manifest ?? null,
    contracts: chosen
      ? frozenContracts(chosen.hash, riskPolicyHash(config), controlPolicyHash(config))
      : null
  };
  const id = hashValue([registrationId, dataset.manifest_hash, 'selection_result']);
  await storage.transaction(() => {
    if (
      db
        .prepare('UPDATE research_datasets SET consumed=1 WHERE dataset_id=? AND consumed=0')
        .run(datasetId).changes !== 1
    )
      throw new Error('SELECTION_ALREADY_CONSUMED');
    db.prepare('UPDATE dataset_memberships SET consumed=1 WHERE dataset_hash=?').run(
      dataset.manifest_hash
    );
    db.prepare('INSERT INTO research_registrations VALUES (?,?,?,?,?,?)').run(
      id,
      'selection_result',
      dataset.manifest_hash,
      Date.now(),
      hashValue(report),
      JSON.stringify(report)
    );
  });
  return { selectionId: id, ...report };
}
