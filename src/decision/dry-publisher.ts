import { Decimal } from 'decimal.js';
import { validateModel, fieldSamples, type ModelManifest } from './model.js';
import { evaluateOpportunity, type OpportunityState } from './opportunity.js';
import type { MarketFact } from '../gmgn/facts.js';
import { decimalValue } from '../gmgn/facts.js';
import { hashValue } from '../research/protocol.js';

export interface DecisionContext {
  format: 'opportunity-v1';
  modelHash: string;
  riskHash: string;
  token: string;
  poolRevision: string;
  opportunityId: string;
  activationFactId: string;
  anchorPrice: string;
  anchorAtMs: number;
}
export interface DryPreparation {
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  riskHash: string;
  checkedAtMs: number;
  latestFacts: MarketFact[];
  reason: string;
  buyUsd: string;
  sellUsd: string;
  tokenQuantity: string;
  quoteReceivedAtMs: number;
}
export function decisionContext(
  state: OpportunityState,
  riskHash: string
): Readonly<DecisionContext> {
  if (
    !state.opportunityId ||
    !state.activationFactId ||
    !state.anchorPrice ||
    state.anchorAtMs === null ||
    !/^[a-f0-9]{64}$/.test(riskHash)
  )
    throw new Error('DECISION_CONTEXT_INCOMPLETE');
  return Object.freeze({
    format: 'opportunity-v1',
    modelHash: state.modelHash,
    riskHash,
    token: state.token,
    poolRevision: state.poolRevision,
    opportunityId: state.opportunityId,
    activationFactId: state.activationFactId,
    anchorPrice: state.anchorPrice,
    anchorAtMs: state.anchorAtMs
  });
}
/** Preparation adapter interface only: this module has no Telegram client and never creates a live outbox. */
export async function dryPublish(input: {
  manifest: ModelManifest;
  state: OpportunityState;
  riskHash: string;
  now: () => number;
  prepare: (context: Readonly<DecisionContext>) => Promise<DryPreparation>;
}) {
  const model = validateModel(input.manifest);
  if (model.hash !== input.state.modelHash || input.state.status !== 'READY')
    throw new Error('MODEL_OR_STATE_NOT_READY');
  const original = structuredClone(input.state);
  const context = decisionContext(original, input.riskHash);
  const cancelled = (reason: string) => ({
    status: 'CANCELLED' as const,
    context,
    state: {
      ...original,
      status: 'INVALIDATED' as const,
      resetArmed: false,
      version: original.version + 1
    },
    reason,
    outbox: null
  });
  let prepared: DryPreparation;
  try {
    prepared = await input.prepare(context);
  } catch {
    return cancelled('MISSING_PREPARATION');
  }
  const now = input.now();
  if (
    prepared.riskHash !== context.riskHash ||
    prepared.status !== 'PASS' ||
    prepared.checkedAtMs > now ||
    now - prepared.checkedAtMs > 2000 ||
    prepared.quoteReceivedAtMs > now ||
    now - prepared.quoteReceivedAtMs > 2000
  )
    return cancelled(prepared.reason || 'FINAL_RISK_OR_QUOTE_UNVERIFIED');
  const evaluateInput = {
    model: model.manifest,
    facts: prepared.latestFacts,
    evaluationAtMs: now,
    token: context.token,
    poolRevision: context.poolRevision
  };
  const decision = evaluateOpportunity(original, evaluateInput, model.hash);
  if (
    decision.state.status !== 'READY' ||
    decision.reason === 'DATA_WAIT' ||
    decision.stageResults.entry !== 'PASS' ||
    decision.stageResults.confirmation !== 'PASS' ||
    decision.stageResults.invalidation !== 'FAIL'
  )
    return cancelled('FINAL_MARKET_RECHECK_FAILED');
  const latest = fieldSamples(model.manifest.price_field, evaluateInput).at(-1);
  if (!latest) return cancelled('ENTRY_PRICE_MISSING');
  let cost: Decimal;
  try {
    if (
      !decimalValue(prepared.buyUsd)?.eq(10) ||
      !decimalValue(prepared.tokenQuantity)?.gt(0) ||
      !decimalValue(prepared.sellUsd)?.gte(0)
    )
      return cancelled('PREPARATION_QUANTITY_INVALID');
    cost = Decimal.max(
      0,
      new Decimal(prepared.buyUsd).minus(prepared.sellUsd).div(prepared.buyUsd)
    );
  } catch {
    return cancelled('PREPARATION_QUANTITY_INVALID');
  }
  const outbox = {
    format: 'opportunity-v1',
    publisherVersion: 'dry-publisher-v1',
    sendEnabled: false,
    context,
    entry: {
      price: latest.value.toString(),
      availableAtMs: latest.fact.receivedAtMs,
      factId: latest.fact.factId
    },
    preparation: {
      buyUsd: prepared.buyUsd,
      tokenQuantity: prepared.tokenQuantity,
      roundTripLoss: cost.toString()
    },
    template: 'opportunity-card-v1',
    content: `BSC ${context.token}\n信号参考价 $${latest.value.toString()}\n模型 ${context.modelHash}\n机会 ${context.opportunityId}`
  };
  // Canonical serialized snapshot is the immutable review artifact. A caller cannot mutate its price later.
  return {
    status: 'DRY_READY' as const,
    context,
    state: decision.state,
    reason: 'SIMULATED_ONLY',
    outbox: JSON.stringify(outbox),
    snapshotHash: hashValue(outbox)
  };
}
