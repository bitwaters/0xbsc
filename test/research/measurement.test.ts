import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstTouch,
  marketBaseline,
  quoteBaseline,
  pairedQuoteReturn,
  quoteReuseKey,
  outcomeSummary,
  observationCoordinates,
  type BaselineValue,
  type PathCandle,
  type QuoteObservation
} from '../../src/research/measurement.js';
import { createMarketFact } from '../../src/gmgn/facts.js';
const baseline: BaselineValue = {
  status: 'VALID',
  reason: 'fixture',
  price: '1.30',
  availableAtMs: 1000,
  sourceAtMs: 1000,
  factId: 'f'
};
const candle = (
  startMs: number,
  low: string,
  high: string,
  endMs = startMs + 30000
): PathCandle => ({ startMs, endMs, receivedAtMs: endMs, open: low, close: high, low, high });
void test('confirmed price excludes pre-confirmation gain and a later rally cannot erase an earlier stop', () => {
  const path = [candle(1000, '1.30', '1.31')];
  assert.equal(firstTouch(baseline, 1.3, path, 31000).outcome, 'CENSORED');
  assert.equal(firstTouch({ ...baseline, price: '1.00' }, 1.3, path, 31000).outcome, 'TP');
  assert.equal(
    firstTouch(baseline, 2, [candle(1000, '1.16', '1.31'), candle(31000, '1.31', '3')], 61000)
      .outcome,
    'SL'
  );
});
void test('same candle, boundary, missing interval and conflicting observations remain unknown', () => {
  assert.equal(
    firstTouch(baseline, 1.3, [candle(1000, '1', '2')], 31000).reason,
    'SAME_CANDLE_ORDER'
  );
  assert.equal(
    firstTouch(baseline, 1.3, [candle(0, '1.30', '2')], 31000).reason,
    'BOUNDARY_TOUCH_ORDER'
  );
  assert.equal(
    firstTouch(baseline, 1.3, [candle(31000, '1.30', '2')], 61000).reason,
    'PATH_GAP_OR_OVERLAP'
  );
  assert.equal(
    firstTouch(baseline, 1.3, [candle(1000, '1.30', '1.31'), candle(1000, '1.30', '2')], 31000)
      .reason,
    'CONFLICTING_CANDLE'
  );
  assert.equal(
    firstTouch(baseline, 1.3, [candle(1000, '1.30', '1.31', 86401000)], 86401000).outcome,
    'NOT_TOUCHED'
  );
  assert.equal(firstTouch(baseline, 1.3, [], 86401000).outcome, 'UNKNOWN');
});
void test('unverified Info never falls back to the card; late physical response cannot reset baseline', () => {
  const f = createMarketFact({
    request: { method: 'GET', path: '/v1/token/info', query: { address: '0x' + 'a'.repeat(40) } },
    response: { data: { price: { price: '1.3' }, liquidity: '100' } },
    attemptId: 'x',
    purpose: 'baseline',
    queuedAtMs: 1100,
    requestedAtMs: 1200,
    receivedAtMs: 1300
  });
  const input = {
    token: f.token!,
    poolRevision: f.poolRevision,
    confirmationAtMs: 1000,
    nowMs: 6000,
    facts: [f],
    preparationComplete: true,
    track: 'post_confirmation_market_v1' as const
  };
  assert.equal(marketBaseline(input).status, 'UNVERIFIED');
  assert.equal(
    marketBaseline({ ...input, preparationComplete: false }).reason,
    'MISSING_PREPARATION'
  );
  assert.equal(
    marketBaseline({ ...input, facts: [{ ...f, requestedAtMs: 7000, receivedAtMs: 7100 }] }).status,
    'MISSING'
  );
});
const buy: QuoteObservation = {
  factId: 'buy',
  chain: 'bsc',
  token: 'token',
  poolRevision: 'pool',
  wallet: 'wallet',
  inputAsset: 'usd',
  outputAsset: 'token',
  direction: 'buy',
  inputAmount: '10000000',
  outputAmount: '40',
  inputUsd: '10',
  outputUsd: '9.9',
  slippage: '1',
  semantics: 'net-usd-v1',
  requestedAtMs: 2000,
  receivedAtMs: 2100
};
void test('quote baseline uses physical deadlines and exact quantity paired sell', () => {
  assert.equal(quoteBaseline(buy, 1000).status, 'VALID');
  assert.equal(
    quoteBaseline({ ...buy, requestedAtMs: 7000, receivedAtMs: 7100 }, 1000).status,
    'MISSING'
  );
  const sell: QuoteObservation = {
    ...buy,
    factId: 'sell',
    direction: 'sell',
    inputAsset: 'token',
    outputAsset: 'usd',
    inputAmount: '40',
    outputAmount: '12000000',
    inputUsd: '12',
    outputUsd: '12',
    requestedAtMs: 5000,
    receivedAtMs: 5100
  };
  assert.equal(pairedQuoteReturn(buy, sell), '1.2');
  assert.equal(pairedQuoteReturn(buy, { ...sell, inputAmount: '39' }), null);
  assert.equal(pairedQuoteReturn(buy, { ...sell, wallet: 'different' }), null);
  assert.notEqual(quoteReuseKey(buy), quoteReuseKey({ ...buy, inputAmount: '20000000' }));
  assert.notEqual(quoteReuseKey(buy), quoteReuseKey({ ...buy, poolRevision: 'new' }));
});
void test('denominators conserve missing samples and protocol versions never mix', () => {
  const rows = ['TP', 'SL', 'NOT_TOUCHED', 'CENSORED', 'UNKNOWN', 'MISSING_BASELINE'].map(
    (outcome) => ({
      track: 'post_confirmation_market_v1' as const,
      protocolHash: 'v1',
      target: 1.3,
      outcome: outcome as Parameters<typeof outcomeSummary>[0][number]['outcome']
    })
  );
  const summary = outcomeSummary([...rows, { ...rows[0]!, protocolHash: 'old' }]);
  assert.equal(summary.length, 2);
  assert.equal(summary[0]!.all, 6);
  assert.equal(summary[0]!.tpAll, 1 / 6);
  assert.equal(summary[0]!.tpConditional, 0.5);
  const coordinates = observationCoordinates(1000);
  assert.equal(coordinates[0], 31000);
  assert.equal(coordinates.at(-1), 86401000);
  assert.equal(new Set(coordinates).size, coordinates.length);
});
