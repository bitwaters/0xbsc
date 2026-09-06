/**
 * Contract frozen from the read-only BSC Quote audit:
 * - tx.amount_in_usd and tx.amount_out_usd are the only USD values used for cost.
 * - top-level slippage is the requested tolerance, not observed price impact.
 * - tax, DEX fee and a priced gas charge are not separately exposed, so none may be
 *   added or deducted a second time.
 */
export interface ParsedGmgnQuote {
  inputUsd: string;
  outputUsd: string;
  outputTokenAmount: string;
  routeAvailable: boolean;
  configuredSlippagePercent: string;
  gasLimit: string | null;
  costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1';
}

interface QuoteEnvelope {
  code?: number | string;
  data?: {
    output_amount?: unknown;
    slippage?: unknown;
    tx?: {
      amount_in_usd?: unknown;
      amount_out_usd?: unknown;
      gas_limit?: unknown;
    };
  };
}

export function parseGmgnQuote(value: unknown): ParsedGmgnQuote {
  const envelope = value as QuoteEnvelope;
  const data = envelope?.data;
  const tx = data?.tx;
  if ((envelope.code !== 0 && envelope.code !== '0') || !data || !tx)
    return unavailableQuote(data?.slippage);
  if (
    !isDecimalString(tx.amount_in_usd) ||
    !isDecimalString(tx.amount_out_usd) ||
    !isIntegerString(data.output_amount)
  )
    return unavailableQuote(data.slippage);
  return {
    inputUsd: tx.amount_in_usd,
    outputUsd: tx.amount_out_usd,
    outputTokenAmount: data.output_amount,
    routeAvailable: true,
    configuredSlippagePercent: numberString(data.slippage),
    gasLimit: isIntegerString(tx.gas_limit) ? tx.gas_limit : null,
    costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1'
  };
}

function unavailableQuote(slippage: unknown): ParsedGmgnQuote {
  return {
    inputUsd: '0',
    outputUsd: '0',
    outputTokenAmount: '0',
    routeAvailable: false,
    configuredSlippagePercent: numberString(slippage),
    gasLimit: null,
    costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1'
  };
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && value !== '0';
}

function isIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && value !== '0';
}

function numberString(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';
}
