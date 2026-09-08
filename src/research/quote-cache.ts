import { hashValue } from './protocol.js';
import { quoteReuseKey, type QuoteObservation } from './measurement.js';

export interface QuoteRequest {
  quote: Parameters<typeof quoteReuseKey>[0];
  decisionAtMs: number;
  requestedMaxAgeMs: number;
  marketRevision: string;
  minimumRequestedAtMs?: number;
}
/** Bounded physical-response cache. A later response can never serve an earlier decision. */
export class ResearchQuoteCache {
  private readonly entries = new Map<string, { quote: QuoteObservation; marketRevision: string }>();
  constructor(private readonly capacity = 200) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 200)
      throw new Error('QUOTE_CACHE_CAPACITY');
  }
  record(quote: QuoteObservation, marketRevision: string) {
    if (
      !marketRevision ||
      !Number.isSafeInteger(quote.requestedAtMs) ||
      !Number.isSafeInteger(quote.receivedAtMs) ||
      quote.receivedAtMs < quote.requestedAtMs
    )
      throw new Error('QUOTE_CACHE_PHYSICAL_COORDINATES');
    const id = quoteReuseKey(quote);
    const prior = this.entries.get(id);
    if (prior && prior.quote.receivedAtMs > quote.receivedAtMs) return;
    this.entries.delete(id);
    this.entries.set(id, { quote: structuredClone(quote), marketRevision });
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
  find(request: QuoteRequest): QuoteObservation | null {
    if (
      !Number.isSafeInteger(request.decisionAtMs) ||
      request.requestedMaxAgeMs <= 0 ||
      !Number.isFinite(request.requestedMaxAgeMs)
    )
      return null;
    const entry = this.entries.get(quoteReuseKey(request.quote));
    if (
      !entry ||
      entry.marketRevision !== request.marketRevision ||
      entry.quote.receivedAtMs > request.decisionAtMs ||
      entry.quote.requestedAtMs < (request.minimumRequestedAtMs ?? 0) ||
      entry.quote.requestedAtMs > request.decisionAtMs ||
      request.decisionAtMs - entry.quote.requestedAtMs > request.requestedMaxAgeMs
    )
      return null;
    return structuredClone(entry.quote);
  }
}
export function resourceExclusion(
  opportunityId: string,
  decisionAtMs: number,
  leg: string,
  reason: string
) {
  if (!Number.isSafeInteger(decisionAtMs) || decisionAtMs < 0) throw new Error('RESOURCE_TIME');
  return Object.freeze({
    id: hashValue([opportunityId, decisionAtMs, leg]),
    opportunityId,
    decisionAtMs,
    leg,
    status: 'EXECUTION_NOT_EVALUATED_RESOURCE',
    reason
  });
}
