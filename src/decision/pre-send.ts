import { marketFlow } from './flow.js';
export function preSendRejection(input: {
  info: unknown;
  expectedPrice: number | null;
  supportPrice: number | null;
  maxRetrace: number;
  nowMs: number;
  triggerAtMs: number;
  triggerMaxAgeMs: number;
  securityStartedAtMs: number;
  securityMaxAgeMs: number;
  quoteAtMs: number | null;
  quoteMaxAgeMs: number;
}): string | null {
  const flow = marketFlow(input.info);
  if (
    flow.priceUsd === null ||
    flow.priceUsd <= 0 ||
    flow.buyShare1m === null ||
    flow.buyShare5m === null
  )
    return 'pre_send_flow_data_missing';
  if (flow.buyShare1m <= 0.5 || flow.buyShare5m < 0.5) return 'pre_send_buy_pressure_lost';
  if (input.supportPrice !== null && flow.priceUsd < input.supportPrice)
    return 'pre_send_structure_broken';
  if (input.expectedPrice !== null && flow.priceUsd < input.expectedPrice * (1 - input.maxRetrace))
    return 'pre_send_retrace_exceeded';
  if (input.nowMs < input.triggerAtMs || input.nowMs - input.triggerAtMs > input.triggerMaxAgeMs)
    return 'pre_send_trigger_expired';
  if (
    input.nowMs < input.securityStartedAtMs ||
    input.nowMs - input.securityStartedAtMs > input.securityMaxAgeMs
  )
    return 'pre_send_security_expired';
  if (
    input.quoteAtMs === null ||
    input.nowMs < input.quoteAtMs ||
    input.nowMs - input.quoteAtMs > input.quoteMaxAgeMs
  )
    return 'pre_send_quote_expired';
  return null;
}
