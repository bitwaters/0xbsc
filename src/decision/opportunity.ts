import { createHash } from 'node:crypto';
import { canonicalJson } from '../discovery/events.js';
import { evaluateExpression, fieldSamples, type ModelInputs } from './model.js';

export type OpportunityStatus =
  'WATCHING' | 'START_CANDIDATE' | 'READY' | 'CONSUMED' | 'INVALIDATED' | 'MISSED';
export interface OpportunityState {
  modelHash: string;
  token: string;
  poolRevision: string;
  status: OpportunityStatus;
  opportunityId: string | null;
  activationFactId: string | null;
  anchorPrice: string | null;
  anchorAtMs: number | null;
  lastFactId: string | null;
  lastSemanticHash: string | null;
  lastEvaluationAtMs: number;
  lastActivation: boolean;
  resetArmed: boolean;
  version: number;
}
export interface OpportunityDecision {
  state: OpportunityState;
  stageResults: Record<
    'activation' | 'confirmation' | 'invalidation' | 'reset' | 'entry',
    'PASS' | 'FAIL' | 'UNKNOWN'
  >;
  reason: string;
  requiredFacts: string[];
}
export function watchingState(
  token: string,
  poolRevision: string,
  modelHash: string
): OpportunityState {
  return {
    modelHash,
    token,
    poolRevision,
    status: 'WATCHING',
    opportunityId: null,
    activationFactId: null,
    anchorPrice: null,
    anchorAtMs: null,
    lastFactId: null,
    lastSemanticHash: null,
    lastEvaluationAtMs: 0,
    lastActivation: false,
    resetArmed: true,
    version: 0
  };
}
export function evaluateOpportunity(
  previous: OpportunityState,
  input: ModelInputs,
  modelHash: string
): OpportunityDecision {
  if (previous.modelHash !== modelHash || previous.token !== input.token)
    throw new Error('OPPORTUNITY_MODEL_CONTEXT_CHANGED');
  if (input.evaluationAtMs < previous.lastEvaluationAtMs)
    throw new Error('OPPORTUNITY_TIME_REVERSED');
  const predicates = {} as OpportunityDecision['stageResults'];
  for (const name of ['activation', 'confirmation', 'invalidation', 'reset', 'entry'] as const) {
    const value = evaluateExpression(input.model[name], input);
    predicates[name] = value === true ? 'PASS' : value === false ? 'FAIL' : 'UNKNOWN';
  }
  const result = (
    state: OpportunityState,
    reason: string,
    requiredFacts: string[] = []
  ): OpportunityDecision => ({ state, reason, requiredFacts, stageResults: predicates });
  if (previous.poolRevision !== input.poolRevision)
    return result(
      {
        ...previous,
        status: previous.status === 'CONSUMED' ? 'CONSUMED' : 'INVALIDATED',
        resetArmed: false,
        version: previous.version + 1,
        lastEvaluationAtMs: input.evaluationAtMs
      },
      'POOL_CHANGED'
    );
  const missing = Object.keys(input.model.fields).filter((f) => !fieldSamples(f, input).length);
  if (
    previous.anchorAtMs !== null &&
    ['START_CANDIDATE', 'READY'].includes(previous.status) &&
    input.evaluationAtMs - previous.anchorAtMs >= input.model.max_opportunity_ms
  )
    return result(
      {
        ...previous,
        status: 'MISSED',
        resetArmed: false,
        version: previous.version + 1,
        lastEvaluationAtMs: input.evaluationAtMs
      },
      'OPPORTUNITY_DEADLINE'
    );
  if (missing.length || Object.values(predicates).includes('UNKNOWN'))
    return result(previous, 'DATA_WAIT', missing);
  const latest = fieldSamples(input.model.price_field, input).at(-1)!;
  if (
    previous.lastFactId === latest.fact.factId ||
    previous.lastSemanticHash === latest.fact.semanticHash
  ) {
    // Window membership can change with time even when no new price response arrives.
    if (
      ['START_CANDIDATE', 'READY'].includes(previous.status) &&
      (predicates.invalidation === 'PASS' ||
        predicates.entry === 'FAIL' ||
        (previous.status === 'READY' && predicates.confirmation === 'FAIL'))
    )
      return result(
        {
          ...previous,
          status: 'INVALIDATED',
          resetArmed: false,
          version: previous.version + 1,
          lastEvaluationAtMs: input.evaluationAtMs
        },
        'CACHED_MARKET_INVALIDATED'
      );
    return result(previous, 'NO_NEW_FACT');
  }
  const state = {
    ...previous,
    lastFactId: latest.fact.factId,
    lastSemanticHash: latest.fact.semanticHash,
    lastEvaluationAtMs: input.evaluationAtMs,
    version: previous.version + 1
  };
  if (['INVALIDATED', 'MISSED', 'CONSUMED'].includes(state.status)) {
    if (predicates.reset === 'PASS' && predicates.activation === 'FAIL')
      return result(
        { ...state, status: 'WATCHING', resetArmed: true, lastActivation: false },
        'RESET_OBSERVED'
      );
    return result(state, 'RESET_REQUIRED');
  }
  if (state.status === 'WATCHING') {
    if (predicates.activation !== 'PASS' || state.lastActivation || !state.resetArmed)
      return result({ ...state, lastActivation: predicates.activation === 'PASS' }, 'WATCHING');
    if (!latest.value.gt(0)) return result(previous, 'DATA_WAIT', [input.model.price_field]);
    state.status = 'START_CANDIDATE';
    state.activationFactId = latest.fact.factId;
    state.anchorPrice = latest.value.toString();
    state.anchorAtMs = input.evaluationAtMs;
    state.opportunityId = createHash('sha256')
      .update(canonicalJson([input.token, input.poolRevision, modelHash, latest.fact.factId]))
      .digest('hex');
    state.lastActivation = true;
    state.resetArmed = false;
  }
  if (predicates.invalidation === 'PASS' || predicates.entry === 'FAIL')
    return result({ ...state, status: 'INVALIDATED', resetArmed: false }, 'MARKET_INVALIDATED');
  if (predicates.confirmation === 'PASS')
    return result({ ...state, status: 'READY' }, 'MARKET_READY_RESEARCH_ONLY');
  if (previous.status === 'READY')
    return result({ ...state, status: 'INVALIDATED', resetArmed: false }, 'CONFIRMATION_LOST');
  return result({ ...state, status: 'START_CANDIDATE' }, 'CONFIRMATION_WAIT');
}
