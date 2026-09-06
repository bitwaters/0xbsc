import { Decimal } from 'decimal.js';
import { evaluatePath, type PathContext, type PathResult } from './path.js';
import type { Storage } from '../storage/database.js';

export interface Candle {
  timeMs?: number;
  intervalMs?: number;
  completed?: boolean;
  high: string;
  low: string;
  close: string;
}
export interface Outcome {
  path?: PathResult;
  marketReturn: Decimal | null;
  executableReturn: Decimal | null;
  mfe: Decimal | null;
  mae: Decimal | null;
  tpSl: 'TP' | 'SL' | 'ambiguous_same_candle' | null;
}

export function evaluateOutcome(
  entryMarketPrice: string,
  exitMarketPrice: string | null,
  entryExecutableUsd: string | null,
  exitExecutableUsd: string | null,
  candles: Candle[],
  takeProfit: string,
  stopLoss: string
): Outcome {
  const entry = new Decimal(entryMarketPrice);
  if (entry.lte(0)) throw new RangeError('market entry price must be positive');
  const marketReturn =
    exitMarketPrice === null ? null : new Decimal(exitMarketPrice).minus(entry).div(entry);
  const executableReturn =
    entryExecutableUsd === null || exitExecutableUsd === null
      ? null
      : new Decimal(exitExecutableUsd).minus(entryExecutableUsd).div(entryExecutableUsd);
  const returns = candles.map((candle) => ({
    high: new Decimal(candle.high).minus(entry).div(entry),
    low: new Decimal(candle.low).minus(entry).div(entry)
  }));
  const mfe = returns.length ? Decimal.max(...returns.map((item) => item.high)) : null;
  const mae = returns.length ? Decimal.min(...returns.map((item) => item.low)) : null;
  const tp = new Decimal(takeProfit),
    sl = new Decimal(stopLoss);
  let tpSl: Outcome['tpSl'] = null;
  for (const item of returns) {
    if (item.high.gte(tp) && item.low.lte(sl)) {
      tpSl = 'ambiguous_same_candle';
      break;
    }
    if (item.high.gte(tp)) {
      tpSl = 'TP';
      break;
    }
    if (item.low.lte(sl)) {
      tpSl = 'SL';
      break;
    }
  }
  return { marketReturn, executableReturn, mfe, mae, tpSl };
}

export async function evaluateAndStoreOutcome(
  storage: Storage,
  input: {
    taskId: number;
    episodeId: string;
    signalId: string | null;
    checkpointMinutes: number;
    entryMarketPrice: string;
    exitMarketPrice: string | null;
    entryExecutableUsd: string | null;
    exitExecutableUsd: string | null;
    candles: Candle[];
    takeProfit: string;
    stopLoss: string;
    nowMs: number;
    pathContext?: PathContext;
    targetMultiples?: readonly number[];
  }
): Promise<Outcome> {
  const outcome = evaluateOutcome(
    input.entryMarketPrice,
    input.exitMarketPrice,
    input.entryExecutableUsd,
    input.exitExecutableUsd,
    input.candles,
    input.takeProfit,
    input.stopLoss
  );
  if (input.pathContext) {
    outcome.path = evaluatePath(
      input.entryMarketPrice,
      input.candles,
      input.pathContext,
      input.targetMultiples ?? [1 + Number(input.takeProfit)],
      -Number(input.stopLoss)
    );
    if (outcome.path.coverage !== 'complete') {
      outcome.mfe = null;
      outcome.mae = null;
      outcome.tpSl = null;
    }
  }
  await storage.attachOutcomeEvaluation({
    taskId: input.taskId,
    episodeId: input.episodeId,
    signalId: input.signalId,
    checkpointMinutes: input.checkpointMinutes,
    outcome,
    nowMs: input.nowMs
  });
  return outcome;
}
