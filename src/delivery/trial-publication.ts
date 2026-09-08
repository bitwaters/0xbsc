import { readFileSync } from 'node:fs';
import type { RuntimeConfig } from '../config/types.js';
import { validateModel } from '../decision/model.js';
import type { PendingOutboxSignal, Storage } from '../storage/database.js';
import { hashValue } from '../research/protocol.js';
import type { prepareDryOpportunity } from '../decision/preparation.js';
import { riskPolicyHash } from '../decision/preparation.js';
import { inlineKeyboard, buttonLabelsFromConfig } from './template.js';

export const TRIAL_PUBLISHER = 'opportunity-trial-v1';
export function loadPublicationModel(config: RuntimeConfig) {
  const p = config.publication;
  if (!p || p.engine === 'legacy') return null;
  if (p.engine !== 'trial') throw new Error('VALIDATED_PROMOTION_REQUIRED');
  const model = validateModel(JSON.parse(readFileSync(p.manifest_path, 'utf8')));
  if (model.hash !== p.model_hash) throw new Error('PUBLICATION_MODEL_HASH_MISMATCH');
  return model;
}
type Prepared = Extract<Awaited<ReturnType<typeof prepareDryOpportunity>>, { status: 'DRY_READY' }>;
export interface TrialDecision {
  format: 'opportunity-v1';
  publisherVersion: typeof TRIAL_PUBLISHER;
  validation: 'UNVALIDATED_TRIAL';
  runId: string;
  tokenAddress: string;
  modelId: string;
  modelHash: string;
  riskHash: string;
  preparedAtMs: number;
  referenceAtMs: number;
  referencePrice: string;
  context: Prepared['context'];
  preparation: unknown;
  frozenContent: string;
  evidence: unknown;
  snapshotHash: string;
}
export function trialDecision(input: {
  runId: string;
  prepared: Prepared;
  modelId: string;
  preparedAtMs: number;
  evidence: unknown;
}): TrialDecision {
  const s = JSON.parse(input.prepared.outbox) as {
    entry: { price: string; availableAtMs: number };
    preparation: unknown;
  };
  const ctx = input.prepared.context;
  const body = {
    runId: input.runId,
    format: 'opportunity-v1' as const,
    publisherVersion: TRIAL_PUBLISHER as typeof TRIAL_PUBLISHER,
    validation: 'UNVALIDATED_TRIAL' as const,
    tokenAddress: ctx.token,
    modelId: input.modelId,
    modelHash: ctx.modelHash,
    riskHash: ctx.riskHash,
    preparedAtMs: input.preparedAtMs,
    referenceAtMs: s.entry.availableAtMs,
    referencePrice: s.entry.price,
    context: ctx,
    preparation: s.preparation,
    evidence: input.evidence,
    frozenContent: `BSC 潜力信号 · 新规则试运行\n\n${ctx.token}\n信号参考价：$${s.entry.price}\n行情收到时间：${new Date(s.entry.availableAtMs).toISOString()}\n\n买压与短周期动量通过，安全及 10U 双向报价复核通过。\n策略：${input.modelId} / ${ctx.modelHash.slice(0, 12)}\n效果尚未验证；卡片价格发布后固定。`
  };
  return { ...body, snapshotHash: hashValue(body) };
}
export function readTrialDecision(raw: unknown): TrialDecision {
  if (!raw || typeof raw !== 'object') throw new Error('TRIAL_SNAPSHOT_INVALID');
  const d = raw as TrialDecision,
    { snapshotHash, ...body } = d;
  if (
    d.format !== 'opportunity-v1' ||
    d.publisherVersion !== TRIAL_PUBLISHER ||
    d.validation !== 'UNVALIDATED_TRIAL' ||
    hashValue(body) !== snapshotHash
  )
    throw new Error('TRIAL_SNAPSHOT_INVALID');
  return d;
}
export async function enqueueTrial(storage: Storage, decision: TrialDecision, revision: string) {
  const id = hashValue([decision.context.opportunityId, TRIAL_PUBLISHER]);
  return storage.transaction(() => {
    const d = readTrialDecision(decision),
      db = storage.db;
    if (
      db
        .prepare("SELECT 1 FROM publication_token_locks WHERE chain='bsc' AND token=?")
        .get(d.tokenAddress)
    )
      return null;
    if (db.prepare('SELECT 1 FROM signals WHERE id=?').get(id)) return null;
    // Transport compatibility only. This route is never evaluated/scored by the legacy engine.
    if (
      db
        .prepare(
          "SELECT 1 FROM episodes WHERE token_address=? AND route='continuation' AND ended_at_ms IS NULL"
        )
        .get(d.tokenAddress)
    )
      return null;
    db.prepare(
      "INSERT OR IGNORE INTO tokens(chain,address,first_seen_at_ms,updated_at_ms) VALUES ('bsc',?,?,?)"
    ).run(d.tokenAddress, d.preparedAtMs, d.preparedAtMs);
    db.prepare(
      `INSERT INTO episodes(id,chain,token_address,route,state,config_revision_id,feature_snapshot_json,created_at_ms,updated_at_ms)
      VALUES (?,'bsc',?,'continuation','DELIVERY_PENDING',?,?,?,?)`
    ).run(
      id,
      d.tokenAddress,
      revision,
      JSON.stringify({ decision_format: d.format, model_hash: d.modelHash }),
      d.preparedAtMs,
      d.preparedAtMs
    );
    db.prepare(
      `INSERT INTO signals(id,episode_id,config_revision_id,delivery_state,quote_snapshot_json,decision_json,created_at_ms,updated_at_ms,decision_format,publisher_version)
      VALUES (?,?,?,'PENDING',?,?,?,?,?,?)`
    ).run(
      id,
      id,
      revision,
      JSON.stringify(d.preparation),
      JSON.stringify(d),
      d.preparedAtMs,
      d.preparedAtMs,
      d.format,
      TRIAL_PUBLISHER
    );
    return id;
  });
}
export async function prepareTrialDelivery(
  storage: Storage,
  signal: PendingOutboxSignal,
  config: RuntimeConfig,
  modelHash: string,
  nowMs: number
) {
  const d = readTrialDecision(signal.decision);
  const quotes = (d.evidence as { quotes: { requestedAtMs: number; receivedAtMs: number }[] })
    .quotes;
  if (
    quotes.length !== 2 ||
    quotes.some(
      (q) => q.receivedAtMs > nowMs || nowMs - q.requestedAtMs > config.quote.max_age_seconds * 1000
    ) ||
    d.modelHash !== modelHash ||
    d.riskHash !== riskPolicyHash(config) ||
    nowMs < d.preparedAtMs ||
    nowMs - d.preparedAtMs > 2000 ||
    nowMs < d.referenceAtMs ||
    nowMs - d.referenceAtMs > 2000
  ) {
    await storage.recordPreSendCancellation(signal.id, 'trial_snapshot_stale_or_changed', nowMs);
    return null;
  }
  return signal;
}
export function renderTrial(signal: PendingOutboxSignal, config: RuntimeConfig) {
  const d = readTrialDecision(signal.decision);
  return {
    text: d.frozenContent,
    replyMarkup: inlineKeyboard(d.tokenAddress, buttonLabelsFromConfig(config.telegram.buttons))
  };
}
