import type { RuntimeConfig } from '../config/types.js';
import type { NormalizedEvent } from '../discovery/events.js';
import { validateModel } from '../decision/model.js';
import {
  evaluateOpportunity,
  watchingState,
  type OpportunityState
} from '../decision/opportunity.js';
import { RouteRuntime } from '../decision/runtime.js';
import type { MarketFact } from '../gmgn/facts.js';
import { hashValue } from './protocol.js';

export interface ReplayFrame {
  token: string;
  poolRevision: string;
  atMs: number;
}
export interface ReplayInput {
  models: unknown[];
  facts: MarketFact[];
  frames: ReplayFrame[];
  events: NormalizedEvent[];
  legacyConfig: RuntimeConfig;
}
export type StageStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_EVALUATED';
/** Frozen legacy code, virtual clock, fact-backed API only. No transports are constructed. */
export async function replay(input: ReplayInput) {
  if (
    !input.models.length ||
    input.models.length > 12 ||
    input.frames.length > 100000 ||
    input.facts.length > 100000
  )
    throw new Error('REPLAY_INPUT_BOUND');
  const models = input.models.map(validateModel).sort((a, b) => a.hash.localeCompare(b.hash));
  if (new Set(models.map((m) => m.hash)).size !== models.length) throw new Error('DUPLICATE_MODEL');
  if (
    input.frames.some(
      (f) => !Number.isSafeInteger(f.atMs) || f.atMs < 0 || !/^0x[a-f0-9]{40}$/.test(f.token)
    )
  )
    throw new Error('INVALID_REPLAY_FRAME');
  const factsById = new Map<string, MarketFact>();
  for (const f of input.facts) {
    if (f.requestedAtMs > f.receivedAtMs || f.queuedAtMs > f.requestedAtMs)
      throw new Error('INVALID_FACT_TIMING');
    const prior = factsById.get(f.factId);
    if (prior && hashValue(prior) !== hashValue(f)) throw new Error('CONFLICTING_FACT');
    factsById.set(f.factId, f);
  }
  const facts = [...factsById.values()].sort(
    (a, b) => a.receivedAtMs - b.receivedAtMs || a.factId.localeCompare(b.factId)
  );
  const frames = [...input.frames].sort(
    (a, b) =>
      a.atMs - b.atMs ||
      a.token.localeCompare(b.token) ||
      a.poolRevision.localeCompare(b.poolRevision)
  );
  let now = 0;
  let current: ReplayFrame;
  let used: string[] = [];
  const at = (endpoint: string, resolution?: string): MarketFact => {
    const ttl =
      (endpoint === 'kline'
        ? input.legacyConfig.scoring.data_ttl_seconds.kline
        : endpoint === 'pool'
          ? input.legacyConfig.scoring.data_ttl_seconds.pool
          : input.legacyConfig.scoring.data_ttl_seconds.info) * 1000;
    const f = facts
      .filter(
        (f) =>
          f.token === current.token &&
          f.poolRevision === current.poolRevision &&
          f.endpoint === endpoint &&
          f.receivedAtMs <= now &&
          f.receivedAtMs >= now - ttl &&
          f.qualityFlags.every((flag) => flag === 'PRICE_SOURCE_TIME_UNVERIFIED') &&
          (!resolution || f.request.resolution === resolution)
      )
      .at(-1);
    if (!f) throw new Error(`LEGACY_FACT_MISSING:${endpoint}:${resolution ?? ''}`);
    used.push(f.factId);
    return f;
  };
  const legacy = new RouteRuntime(
    input.legacyConfig,
    {
      token: (path) =>
        Promise.resolve(at(path === '/v1/token/pool_info' ? 'pool' : 'info').payload),
      kline: (_token, resolution) => Promise.resolve(at('kline', resolution).payload),
      holders: () => Promise.reject(new Error('OFFLINE_EXECUTION_DISABLED')),
      traders: () => Promise.reject(new Error('OFFLINE_EXECUTION_DISABLED')),
      createdTokens: () => Promise.reject(new Error('OFFLINE_EXECUTION_DISABLED')),
      gas: () => Promise.reject(new Error('OFFLINE_EXECUTION_DISABLED')),
      quote: () => Promise.reject(new Error('OFFLINE_EXECUTION_DISABLED'))
    },
    () => now
  );
  const states = new Map<string, OpportunityState>();
  const seenEvents = new Set<string>();
  const decisions: unknown[] = [];
  let reportBytes = 0;
  const append = (decision: unknown) => {
    reportBytes += Buffer.byteLength(JSON.stringify(decision));
    if (reportBytes > 32 * 1024 ** 2) throw new Error('REPLAY_REPORT_STORAGE_BOUND');
    decisions.push(decision);
  };
  for (current of frames) {
    now = current.atMs;
    const available = facts.filter((f) => f.receivedAtMs <= now && f.token === current.token);
    const events = input.events
      .filter((e) => e.observedAtMs <= now && e.tokenAddress === current.token)
      .sort((a, b) => a.observedAtMs - b.observedAtMs || a.key.localeCompare(b.key));
    for (const e of events)
      if (!seenEvents.has(e.key)) {
        legacy.observe(e);
        seenEvents.add(e.key);
      }
    used = [];
    let legacyResult: unknown = { market: 'UNKNOWN', reason: 'LEGACY_EVENTS_MISSING' };
    const event = events.at(-1);
    if (event) {
      try {
        const info = at('info'),
          pool = at('pool');
        const r = await legacy.classify(event, info.payload, {
          eventAlreadyObserved: true,
          forceKline: true,
          infoObservedAtMs: info.receivedAtMs,
          pool: pool.payload,
          poolObservedAtMs: pool.receivedAtMs
        });
        legacyResult = {
          market: r.decision === 'formal' ? 'PASS' : 'FAIL',
          reason: r.decision ?? 'LEGACY_EVIDENCE_OR_ROUTE',
          result: r
        };
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith('LEGACY_FACT_MISSING:')) throw e;
        legacyResult = { market: 'UNKNOWN', reason: e.message };
      }
    }
    append({
      ...current,
      model: 'legacy',
      decision: legacyResult,
      factIds: [...new Set(used)].sort(),
      safety: 'NOT_EVALUATED',
      execution: 'NOT_EVALUATED',
      publication: 'DISABLED'
    });
    for (const model of models) {
      const key = `${model.hash}:${current.token}`;
      let previous =
        states.get(key) ?? watchingState(current.token, current.poolRevision, model.hash);
      if (previous.poolRevision !== current.poolRevision) {
        const invalidated = evaluateOpportunity(
          previous,
          {
            model: model.manifest,
            facts: available,
            evaluationAtMs: now,
            token: current.token,
            poolRevision: current.poolRevision
          },
          model.hash
        );
        append({
          ...current,
          model: model.hash,
          decision: invalidated,
          publication: 'DISABLED'
        });
        previous = watchingState(current.token, current.poolRevision, model.hash);
      }
      const decision = evaluateOpportunity(
        previous,
        {
          model: model.manifest,
          facts: available,
          evaluationAtMs: now,
          token: current.token,
          poolRevision: current.poolRevision
        },
        model.hash
      );
      states.set(key, decision.state);
      append({
        ...current,
        model: model.hash,
        decision,
        factIds: available
          .filter((f) => f.poolRevision === current.poolRevision)
          .map((f) => f.factId),
        safety: 'NOT_EVALUATED',
        execution: 'NOT_EVALUATED',
        publication: 'DISABLED'
      });
    }
  }
  return {
    version: 'offline-replay-v1',
    riskHash: hashValue(input.legacyConfig.security),
    legacyHash: hashValue({
      strategy: input.legacyConfig.strategy,
      scoring: input.legacyConfig.scoring,
      evidence: input.legacyConfig.evidence
    }),
    modelHashes: models.map((m) => m.hash),
    decisions,
    decisionHash: hashValue(decisions),
    marketBaseline: 'UNAVAILABLE',
    promotion: 'NOT_EVALUATED',
    networkRequests: 0
  };
}
