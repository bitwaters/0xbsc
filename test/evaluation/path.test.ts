import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePath, summarizePathStatuses } from '../../src/evaluation/path.js';
import { fetchMarketPath } from '../../src/evaluation/market-path.js';
const candle = (timeMs: number, high: string, low: string, close = high) => ({
  timeMs,
  intervalMs: 30_000,
  completed: true,
  high,
  low,
  close
});
const context = { entryAtMs: 0, targetAtMs: 90_000, horizonAtMs: 90_000 };
void test('distinguishes an early double followed by a crash from a crash followed by a double', () => {
  const up = evaluatePath(
    '100',
    [candle(0, '120', '95'), candle(30_000, '200', '115'), candle(60_000, '200', '40', '70')],
    context,
    [2],
    0.2
  );
  const down = evaluatePath(
    '100',
    [candle(0, '100', '40'), candle(30_000, '200', '100'), candle(60_000, '200', '150')],
    context,
    [2],
    0.2
  );
  assert.equal(up.maxMultiple, '2');
  assert.equal(down.maxMultiple, '2');
  assert.equal(up.barriers[0]?.status, 'TP');
  assert.equal(down.barriers[0]?.status, 'SL');
  assert.equal(up.targets[0]?.preTargetDropUpper, '0.05');
  assert.equal(down.targets[0]?.preTargetDropUpper, '0.6');
});
void test('reports same-candle ordering and pre-target drop as uncertainty', () => {
  const result = evaluatePath(
    '100',
    [candle(0, '200', '70', '160')],
    { ...context, targetAtMs: 30_000 },
    [2],
    0.2
  );
  assert.equal(result.barriers[0]?.status, 'ambiguous_same_candle');
  assert.equal(result.targets[0]?.preTargetDropLower, '0');
  assert.equal(result.targets[0]?.preTargetDropUpper, '0.3');
});
void test('sorts timestamps, excludes pre-entry price and does not classify gaps as losses', () => {
  const a = evaluatePath(
    '100',
    [candle(60_000, '120', '90'), candle(0, '110', '95')],
    context,
    [2],
    0.2
  );
  assert.equal(a.coverage, 'incomplete');
  assert.equal(a.maxMultiple, null);
  assert.equal(a.barriers[0]?.status, 'unknown');
  const b = evaluatePath(
    '100',
    [candle(0, '400', '20'), candle(30_000, '110', '95')],
    { entryAtMs: 15_000, targetAtMs: 60_000, horizonAtMs: 60_000 },
    [2],
    0.2
  );
  assert.equal(b.observedMaxMultiple, '1.1');
  assert.ok(b.reasons.includes('entry_candle_ambiguous'));
});
void test('separates unfinished observation from completed no-touch and keeps MFE monotonic on covered paths', () => {
  const first = evaluatePath(
    '100',
    [candle(0, '150', '95')],
    { ...context, targetAtMs: 30_000 },
    [2],
    0.2
  );
  const last = evaluatePath(
    '100',
    [candle(0, '150', '95'), candle(30_000, '140', '100'), candle(60_000, '130', '100')],
    context,
    [2],
    0.2
  );
  assert.equal(first.barriers[0]?.status, 'pending');
  assert.equal(last.barriers[0]?.status, 'not_touched');
  assert.equal(first.maxMultiple, last.maxMultiple);
  assert.deepEqual(
    summarizePathStatuses([
      'TP',
      'SL',
      'not_touched',
      'pending',
      'unknown',
      'ambiguous_same_candle'
    ]),
    {
      total: 6,
      hit: 1,
      loss: 1,
      notTouched: 1,
      pending: 1,
      unknown: 2,
      adjudicable: 3,
      coverage: 0.5,
      hitRate: 1 / 3,
      conditionalHitRate: 0.5
    }
  );
});
void test('fetches a long path in bounded ranges without silently accepting the latest hundred rows', async () => {
  const ranges: Array<{ fromMs: number; toMs: number }> = [];
  const api = {
    kline: (_token: string, _resolution: string, range: { fromMs: number; toMs: number }) => {
      ranges.push(range);
      return Promise.resolve({
        data: {
          list: Array.from({ length: (range.toMs - range.fromMs) / 30_000 }, (_, i) => ({
            time: range.fromMs + i * 30_000,
            open: '1',
            high: '1',
            low: '1',
            close: '1',
            volume: '1'
          }))
        }
      });
    }
  };
  const rows = await fetchMarketPath(api as never, '0xtoken', 0, 240 * 60_000);
  assert.equal(rows.length, 480);
  assert.equal(ranges.length, 6);
  assert.equal(rows.at(-1)?.timeMs, 240 * 60_000 - 30_000);
});
void test('a proven first touch survives a missing later segment; harmless entry overlap can prove no earlier barrier', () => {
  const prefix = [candle(0, '110', '95'), candle(30_000, '200', '100')];
  const result = evaluatePath('100', prefix, context, [2], 0.2);
  assert.equal(result.coverage, 'incomplete');
  assert.equal(result.barriers[0]?.status, 'TP');
  const overlapped = evaluatePath(
    '100',
    prefix,
    { entryAtMs: 15_000, targetAtMs: 90_000, horizonAtMs: 90_000 },
    [2],
    0.2
  );
  assert.equal(overlapped.barriers[0]?.status, 'TP');
  assert.equal(overlapped.maxMultiple, null);
});

void test('continuous off-grid OHLC produces conservative bounds instead of an internal-gap diagnosis', () => {
  const result = evaluatePath(
    '100',
    [
      candle(0, '120', '80', '105'),
      candle(30_000, '130', '95', '110'),
      candle(60_000, '500', '10', '200')
    ],
    { entryAtMs: 15_000, targetAtMs: 75_000, horizonAtMs: 75_000 },
    [2],
    0.2
  );
  assert.equal(result.coverage, 'bounded');
  assert.deepEqual(result.diagnostics.missingRanges, []);
  assert.equal(result.maxMultiple, null);
  assert.deepEqual(result.bounds.maxMultiple, { lower: '1.3', upper: '5' });
  assert.deepEqual(result.bounds.maxEntryDrop, { lower: '0.05', upper: '0.9' });
  assert.equal(result.barriers[0]?.status, 'unknown');
  const harmless = evaluatePath(
    '100',
    [candle(0, '110', '95'), candle(30_000, '110', '95'), candle(60_000, '110', '95')],
    { entryAtMs: 15_000, targetAtMs: 75_000, horizonAtMs: 75_000 },
    [2],
    0.2
  );
  assert.equal(harmless.barriers[0]?.status, 'not_touched');
});

void test('missing and still-open candles remain distinct and bounded repair attempts eventually stop', async () => {
  const { pathRepairAt } = await import('../../src/evaluation/outcomes.js');
  const incomplete = evaluatePath(
    '100',
    [candle(0, '110', '95'), { ...candle(60_000, '110', '95'), completed: false }],
    context,
    [2],
    0.2
  );
  assert.deepEqual(incomplete.diagnostics.missingRanges, [{ fromMs: 30_000, toMs: 60_000 }]);
  assert.deepEqual(incomplete.diagnostics.pendingRanges, [{ fromMs: 60_000, toMs: 90_000 }]);
  assert.equal(incomplete.bounds.maxMultiple.upper, null);
  assert.equal(
    pathRepairAt(incomplete, 90_000, 100_000, { attempt: 1, maxAttempts: 3, retryDelayMs: 30_000 }),
    130_000
  );
  assert.equal(
    pathRepairAt(incomplete, 90_000, 100_000, { attempt: 3, maxAttempts: 3, retryDelayMs: 30_000 }),
    null
  );
});

void test('market path refetches missing settled intervals within a bounded API budget', async () => {
  const ranges: Array<{ fromMs: number; toMs: number }> = [];
  const api = {
    kline: (_t: string, _r: string, range: { fromMs: number; toMs: number }) => {
      ranges.push(range);
      return Promise.resolve({
        data: {
          list: (ranges.length === 1 ? [0, 60_000] : [30_000]).map((time) => ({
            time,
            open: '1',
            high: '1',
            low: '1',
            close: '1',
            volume: '1'
          }))
        }
      });
    }
  };
  const rows = await fetchMarketPath(api as never, '0xtoken', 15_000, 75_000, {
    now: () => 100_000
  });
  assert.deepEqual(ranges, [
    { fromMs: 0, toMs: 90_000 },
    { fromMs: 30_000, toMs: 60_000 }
  ]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((c) => c.completed));
  assert.equal(
    evaluatePath(
      '1',
      rows,
      { entryAtMs: 15_000, targetAtMs: 75_000, horizonAtMs: 75_000 },
      [2],
      0.2
    ).coverage,
    'bounded'
  );
});

void test('merge keeps completed data, upgrades open candles and exposes historical conflicts', async () => {
  const { mergeMarketPaths } = await import('../../src/evaluation/path-coverage.js');
  const initial = [{ ...candle(0, '110', '95'), completed: false }];
  const merged = mergeMarketPaths(initial, [candle(0, '115', '95')]);
  assert.deepEqual(merged, [candle(0, '115', '95')]);
  assert.deepEqual(mergeMarketPaths(merged, initial), merged);
  const conflict = mergeMarketPaths(merged, [candle(0, '120', '95')]);
  assert.equal(conflict.length, 2);
  const result = evaluatePath(
    '100',
    conflict,
    { entryAtMs: 0, targetAtMs: 30_000, horizonAtMs: 30_000 },
    [2],
    0.2
  );
  assert.ok(result.reasons.includes('conflicting_duplicate'));
  assert.equal(result.barriers[0]?.status, 'unknown');
});

void test('conflicting history cannot claim a price bound or a first touch', () => {
  const result = evaluatePath(
    '1',
    [
      { timeMs: 0, intervalMs: 30000, completed: true, high: '2', low: '0.8', close: '1' },
      { timeMs: 0, intervalMs: 30000, completed: true, high: '4', low: '0.2', close: '1' }
    ],
    { entryAtMs: 0, targetAtMs: 30000, horizonAtMs: 30000 },
    [1.3],
    0.1
  );
  assert.equal(result.coverage, 'incomplete');
  assert.equal(result.barriers[0]?.status, 'unknown');
  assert.deepEqual(result.bounds.maxMultiple, { lower: '1', upper: null });
  assert.deepEqual(result.bounds.maxEntryDrop, { lower: '0', upper: null });
  assert.equal(result.observedMaxMultiple, null);
});
