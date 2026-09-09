import { Decimal } from 'decimal.js';

export class NormalizationError extends Error {}

function decimal(value: unknown, field: string): Decimal {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new NormalizationError(`${field} must be a numeric string or number`);
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error();
    return parsed;
  } catch {
    throw new NormalizationError(`${field} is not finite`);
  }
}

export function normalizeRate(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.isNegative()) throw new NormalizationError(`${field} cannot be negative`);
  const normalized = parsed.gt(1) ? parsed.div(100) : parsed;
  if (normalized.gt(1)) throw new NormalizationError(`${field} exceeds 100 percent`);
  return normalized;
}

/** GMGN ratio fields have an explicit 0..1 contract; never guess a percentage unit. */
export function normalizeRatio(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.lt(0) || parsed.gt(1))
    throw new NormalizationError(`${field} must be a ratio from 0 to 1`);
  return parsed;
}

export function normalizeUsd(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.isNegative()) throw new NormalizationError(`${field} cannot be negative`);
  return parsed;
}

export function normalizeTokenAmount(value: unknown, decimals: unknown, field: string): Decimal {
  const raw = decimal(value, field);
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new NormalizationError(`${field} has invalid token decimals`);
  if (raw.isNegative() || !raw.isInteger())
    throw new NormalizationError(`${field} must be a non-negative integer raw amount`);
  return raw.div(new Decimal(10).pow(decimals));
}

export function normalizeWei(value: unknown, field: string): Decimal {
  const raw = decimal(value, field);
  if (raw.isNegative() || !raw.isInteger())
    throw new NormalizationError(`${field} must be a non-negative integer Wei amount`);
  return raw.div(new Decimal(10).pow(18));
}
