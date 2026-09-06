export const endpointWeights = {
  trending: 1,
  info: 1,
  security: 1,
  pool: 1,
  smartMoney: 1,
  kol: 1,
  gas: 1,
  kline: 2,
  quote: 2,
  createdTokens: 2,
  trenches: 3,
  hot: 3,
  marketSignal: 3,
  holders: 5,
  traders: 5
} as const;

export const rejectedSignalTypes = new Set([14, 15, 16]);

export function validateSignalTypes(types: number[]): void {
  if (types.some((type) => !Number.isInteger(type) || type < 1))
    throw new RangeError('Signal types must be positive integers');
  const rejected = types.filter((type) => rejectedSignalTypes.has(type));
  if (rejected.length) throw new RangeError(`GMGN rejects Signal type(s): ${rejected.join(', ')}`);
}

export function truncateRows<T>(rows: T[], limit: number): T[] {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('row limit must be a positive integer');
  return rows.slice(0, limit);
}

export const maximumRows = {
  signalGroup: 50,
  trenches: 50,
  smartMoney: 100,
  kol: 100,
  holders: 100,
  traders: 100
} as const;
