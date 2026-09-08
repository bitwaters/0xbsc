import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFixture, token, pool, epoch } from './capture-fixture.js';
import { MeasurementStore } from '../../src/research/measurement-store.js';
import { QuoteExitCollector } from '../../src/research/quote-exits.js';
import {
  quoteBaseline,
  pairedQuoteReturn,
  type QuoteObservation
} from '../../src/research/measurement.js';
import { hashValue } from '../../src/research/protocol.js';
void test('quote exit retains original quantity, actual late time and one capture; no market high substitutes proceeds', async () => {
  const { storage, fact } = await captureFixture();
  let now = epoch,
    calls = 0;
  try {
    const buy: QuoteObservation = {
      requestedNotionalUsd: '10',
      factId: fact.factId,
      chain: 'bsc',
      token,
      poolRevision: pool,
      wallet: token,
      inputAsset: pool,
      outputAsset: token,
      direction: 'buy',
      inputAmount: '10',
      outputAmount: '7',
      inputUsd: '9.999999',
      outputUsd: '9.9',
      slippage: '1',
      semantics: 'v1',
      requestedAtMs: epoch,
      receivedAtMs: epoch + 100
    };
    const m = new MeasurementStore(storage),
      id = await m.begin({
        runId: 'run',
        opportunityId: 'op',
        track: 'post_confirmation_quote_v1',
        confirmationAtMs: epoch,
        confirmationKind: 'ACTUAL'
      });
    const baseline = quoteBaseline(buy, epoch);
    assert.equal(baseline.status, 'VALID');
    await m.settle(id, baseline);
    const text = JSON.stringify([buy]);
    storage.db
      .prepare('INSERT INTO research_registrations VALUES (?,?,?,?,?,?)')
      .run(
        hashValue(['run', 'op', 'baseline_quotes']),
        'baseline_quotes',
        'run',
        epoch,
        hashValue([buy]),
        text
      );
    const collector = new QuoteExitCollector(
      storage,
      () => now,
      (_op, b) => {
        calls++;
        assert.equal(b.outputAmount, '7');
        return Promise.resolve({
          ...b,
          factId: 'sell',
          inputAsset: token,
          outputAsset: pool,
          direction: 'sell',
          inputAmount: '7',
          outputAmount: '15',
          outputUsd: '14.9999985',
          requestedAtMs: now,
          receivedAtMs: now + 100
        });
      }
    );
    assert.equal(await collector.schedule(id, 'audit60s', epoch + 60100), true);
    assert.equal(await collector.tick(), false);
    now = epoch + 120000;
    assert.equal(await collector.tick(), true);
    assert.equal(await collector.tick(), false);
    assert.equal(calls, 1);
    const result = JSON.parse(
      (
        storage.db.prepare('SELECT result_json FROM research_quote_exits').get() as {
          result_json: string;
        }
      ).result_json
    ) as { multiple: string; lateByMs: number; availableAtMs: number };
    assert.equal(result.multiple, '1.5');
    assert.equal(result.availableAtMs, now + 100);
    assert.equal(result.lateByMs, 60000);
    assert.equal(
      pairedQuoteReturn({ ...buy, requestedAtMs: NaN }, { ...buy, direction: 'sell' }),
      null
    );
    assert.equal(quoteBaseline({ ...buy, requestedAtMs: NaN }, epoch).status, 'MISSING');
  } finally {
    storage.close();
  }
});
