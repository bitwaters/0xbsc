import type { Candle } from '../../src/evaluation/outcomes.js';

export const outcomeFixtures: ReadonlyArray<{
  name: 'profit' | 'loss' | 'rug_no_exit' | 'ambiguous_tp_sl';
  entryMarketPrice: string;
  exitMarketPrice: string | null;
  entryExecutableUsd: string | null;
  exitExecutableUsd: string | null;
  candles: Candle[];
  takeProfit: string;
  stopLoss: string;
  expected: { marketReturn: string | null; executableReturn: string | null; tpSl: string | null };
}> = [
  {
    name: 'profit',
    entryMarketPrice: '100',
    exitMarketPrice: '130',
    entryExecutableUsd: '10',
    exitExecutableUsd: '12',
    candles: [{ high: '135', low: '99', close: '130' }],
    takeProfit: '0.3',
    stopLoss: '-0.1',
    expected: { marketReturn: '0.3', executableReturn: '0.2', tpSl: 'TP' }
  },
  {
    name: 'loss',
    entryMarketPrice: '100',
    exitMarketPrice: '80',
    entryExecutableUsd: '10',
    exitExecutableUsd: '8',
    candles: [{ high: '101', low: '79', close: '80' }],
    takeProfit: '0.3',
    stopLoss: '-0.1',
    expected: { marketReturn: '-0.2', executableReturn: '-0.2', tpSl: 'SL' }
  },
  {
    name: 'rug_no_exit',
    entryMarketPrice: '100',
    exitMarketPrice: '1',
    entryExecutableUsd: '10',
    exitExecutableUsd: null,
    candles: [{ high: '105', low: '1', close: '1' }],
    takeProfit: '0.3',
    stopLoss: '-0.1',
    expected: { marketReturn: '-0.99', executableReturn: null, tpSl: 'SL' }
  },
  {
    name: 'ambiguous_tp_sl',
    entryMarketPrice: '100',
    exitMarketPrice: null,
    entryExecutableUsd: null,
    exitExecutableUsd: null,
    candles: [{ high: '120', low: '80', close: '100' }],
    takeProfit: '0.1',
    stopLoss: '-0.1',
    expected: { marketReturn: null, executableReturn: null, tpSl: 'ambiguous_same_candle' }
  }
];

export const timingFixtures = {
  lateEntry: { confirmedAtMs: 1_000, requestedAtMs: 6_001 },
  lateExit: { targetAtMs: 1_000, requestedAtMs: 12_000 }
} as const;
