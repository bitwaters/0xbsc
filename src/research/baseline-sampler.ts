import type { MarketFact } from '../gmgn/facts.js';
import type { Clock } from '../gmgn/scheduler.js';
import type { MeasurementStore } from './measurement-store.js';
import {
  marketBaseline,
  quoteBaseline,
  type BaselineValue,
  type QuoteObservation
} from './measurement.js';
import { measurementProtocol as p } from './protocol.js';

export interface ConfirmationSample {
  card?: { price: string; availableAtMs: number; factId: string };
  runId: string;
  opportunityId: string;
  token: string;
  poolRevision: string;
  confirmation: { kind: 'ACTUAL'; atMs: number } | { kind: 'SIMULATED'; preparedAtMs: number };
  preparationComplete: boolean;
}
export interface BaselineCapture {
  /** Calls must use the common scheduler's research context and persist their fact before resolving. */
  market(deadlineAtMs: number): Promise<MarketFact>;
  quote(deadlineAtMs: number): Promise<QuoteObservation>;
}
const missing = (reason: string): BaselineValue => ({
  status: 'MISSING',
  reason,
  price: null,
  availableAtMs: null,
  sourceAtMs: null,
  factId: null
});

/** One opportunity at a time. PENDING is durable before any sleep or network operation. */
export class BaselineSampler {
  private active = false;
  constructor(
    private readonly store: MeasurementStore,
    private readonly clock: Clock
  ) {}
  async sample(input: ConfirmationSample, capture: BaselineCapture) {
    if (!input.preparationComplete)
      return {
        ...(await this.store.missingPreparation(
          input.runId,
          input.opportunityId,
          input.confirmation.kind === 'ACTUAL'
            ? input.confirmation.atMs
            : input.confirmation.preparedAtMs
        )),
        confirmationAtMs: null,
        status: 'MISSING_PREPARATION'
      };
    const confirmationAtMs =
      input.confirmation.kind === 'ACTUAL'
        ? input.confirmation.atMs
        : input.confirmation.preparedAtMs + p.simulatedConfirmationDelayMs;
    const common = {
      runId: input.runId,
      opportunityId: input.opportunityId,
      confirmationAtMs,
      confirmationKind: input.confirmation.kind
    };
    const marketId = await this.store.begin({ ...common, track: 'post_confirmation_market_v1' });
    const quoteId = await this.store.begin({ ...common, track: 'post_confirmation_quote_v1' });
    const cardId = await this.store.begin({ ...common, track: 'card_reference_legacy' });
    await this.store.settle(
      cardId,
      input.card
        ? {
            status: 'VALID',
            reason: 'FROZEN_CARD_REFERENCE',
            price: input.card.price,
            availableAtMs: input.card.availableAtMs,
            factId: input.card.factId,
            sourceAtMs: null
          }
        : missing('CARD_REFERENCE_NOT_AVAILABLE')
    );
    const ids = { marketId, quoteId, cardId, confirmationAtMs };
    const finishMissing = async (reason: string) => {
      await this.store.settle(marketId, missing(reason));
      await this.store.settle(quoteId, missing(reason));
      return { ...ids, status: reason };
    };
    if (this.active) return finishMissing('MISSING_RESOURCE');
    // Terminal rows on recovery must not issue a new request or reprice.
    if (!(await this.store.isPending(marketId)) && !(await this.store.isPending(quoteId)))
      return { ...ids, status: 'ALREADY_TERMINAL' };
    this.active = true;
    try {
      if (this.clock.now() < confirmationAtMs)
        await this.clock.sleep(confirmationAtMs - this.clock.now());
      const deadline = confirmationAtMs + p.baselineDeadlineMs;
      if (this.clock.now() >= deadline) return await finishMissing('BASELINE_DEADLINE_EXPIRED');
      const facts: MarketFact[] = [];
      if (await this.store.isPending(marketId)) {
        for (
          let attempt = 0;
          attempt < p.marketAttempts && this.clock.now() < deadline;
          attempt++
        ) {
          if (!(await this.store.claimBaselineAttempt(marketId, this.clock.now()))) break;
          try {
            facts.push(await capture.market(deadline));
          } catch {
            /* Attempt stays spent; no reset. */
          }
          const value = marketBaseline({
            token: input.token,
            poolRevision: input.poolRevision,
            confirmationAtMs,
            nowMs: this.clock.now(),
            facts,
            preparationComplete: true,
            track: 'post_confirmation_market_v1'
          });
          if (value.status !== 'PENDING') {
            await this.store.settle(marketId, value);
            break;
          }
        }
        if (await this.store.isPending(marketId))
          await this.store.settle(
            marketId,
            marketBaseline({
              token: input.token,
              poolRevision: input.poolRevision,
              confirmationAtMs,
              nowMs: deadline,
              facts,
              preparationComplete: true,
              track: 'post_confirmation_market_v1'
            })
          );
      }
      if (await this.store.isPending(quoteId)) {
        if (
          this.clock.now() >= deadline ||
          !(await this.store.claimBaselineAttempt(quoteId, this.clock.now()))
        )
          await this.store.settle(quoteId, missing('MISSING_RESOURCE'));
        else {
          try {
            const quote = await capture.quote(deadline);
            if (quote.token !== input.token || quote.poolRevision !== input.poolRevision)
              await this.store.settle(quoteId, missing('QUOTE_IDENTITY_MISMATCH'));
            else await this.store.settle(quoteId, quoteBaseline(quote, confirmationAtMs));
          } catch {
            await this.store.settle(quoteId, missing('MISSING_RESOURCE'));
          }
        }
      }
      return { ...ids, status: 'BASELINES_TERMINAL' };
    } finally {
      this.active = false;
    }
  }
}
