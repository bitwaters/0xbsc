import assert from 'node:assert/strict';
import test from 'node:test';
import { Storage } from '../../src/storage/database.js';
import {
  PublicationGuard,
  PUBLICATION_COMPATIBILITY
} from '../../src/delivery/publication-guard.js';
import { drainPreparation, deploymentPrecheck } from '../../src/research/precheck.js';
import { ResearchQuoteCache } from '../../src/research/quote-cache.js';
import type { QuoteObservation } from '../../src/research/measurement.js';

void test('new publisher SENT and UNKNOWN locks survive draining and rollback to compatible legacy', async () => {
  const s = await Storage.open(':memory:');
  try {
    s.db.exec("INSERT INTO config_revisions VALUES ('cfg','{}',0)");
    for (const [i, format] of ['opportunity-v1', 'opportunity-v1', 'legacy-v1'].entries()) {
      s.db
        .prepare(
          "INSERT INTO tokens(chain,address,first_seen_at_ms,updated_at_ms) VALUES ('bsc',?,0,0)"
        )
        .run(`token${i}`);
      s.db
        .prepare(
          "INSERT INTO episodes(id,chain,token_address,route,state,config_revision_id,created_at_ms,updated_at_ms) VALUES (?,'bsc',?,'new_launch','DELIVERY_PENDING','cfg',0,0)"
        )
        .run(`ep${i}`, `token${i}`);
      s.db
        .prepare(
          "INSERT INTO signals(id,episode_id,config_revision_id,delivery_state,quote_snapshot_json,decision_json,created_at_ms,updated_at_ms,decision_format,publisher_version) VALUES (?,?,'cfg','PENDING','{}','{}',0,0,?,?)"
        )
        .run(`s${i}`, `ep${i}`, format, format);
    }
    const next = new PublicationGuard(s, () => 1000, 'opportunity-v1'),
      owner = await next.acquire();
    assert.ok(owner);
    assert.equal(await next.reserve(owner, 's0'), true);
    assert.equal(await next.reserve(owner, 's2'), false);
    const target = {
      imageId: 'sha256:' + 'a'.repeat(64),
      compatibility: PUBLICATION_COMPATIBILITY
    };
    assert.equal((await drainPreparation(s, target, () => 1000)).status, 'BLOCKED');
    s.db.prepare("UPDATE signals SET delivery_state='SENT' WHERE id='s0'").run();
    assert.equal(await next.reserve(owner, 's1'), true);
    s.db.prepare("UPDATE signals SET delivery_state='DELIVERY_UNKNOWN' WHERE id='s1'").run();
    await next.release(owner);
    await assert.rejects(
      drainPreparation(s, { ...target, compatibility: 'old' }, () => 1000),
      /INCOMPATIBLE/
    );
    assert.equal((await drainPreparation(s, target, () => 1000)).cancelled, 1);
    assert.deepEqual(
      s.db.prepare('SELECT state FROM publication_token_locks ORDER BY token').all(),
      [{ state: 'SENT' }, { state: 'UNKNOWN' }]
    );
    const legacy = new PublicationGuard(s, () => 1000),
      legacyOwner = await legacy.acquire();
    assert.ok(legacyOwner);
    assert.equal(await legacy.reserve(legacyOwner, 's1'), false);
    assert.equal((await s.pendingOutboxSignals(1000, true)).length, 0);
    await legacy.release(legacyOwner);
    assert.equal(deploymentPrecheck(s.db, 1000, PUBLICATION_COMPATIBILITY).status, 'READY');
  } finally {
    s.close();
  }
});

void test('quote reuse requires all identity dimensions, known-at time and unchanged market', () => {
  const quote: QuoteObservation = {
    factId: 'q',
    chain: 'bsc',
    token: 'token',
    poolRevision: 'pool',
    wallet: 'wallet',
    inputAsset: 'in',
    outputAsset: 'out',
    direction: 'sell',
    inputAmount: '100',
    outputAmount: '110',
    inputUsd: '10',
    outputUsd: '11',
    slippage: '1',
    semantics: 'v1',
    requestedAtMs: 1000,
    receivedAtMs: 1100
  };
  const cache = new ResearchQuoteCache();
  cache.record(quote, 'market1');
  const request = { quote, decisionAtMs: 1200, requestedMaxAgeMs: 500, marketRevision: 'market1' };
  assert.equal(cache.find(request)?.factId, 'q');
  for (const key of [
    'poolRevision',
    'wallet',
    'inputAsset',
    'outputAsset',
    'inputAmount',
    'slippage',
    'semantics'
  ] as const)
    assert.equal(cache.find({ ...request, quote: { ...quote, [key]: 'other' } }), null);
  assert.equal(cache.find({ ...request, decisionAtMs: 1050 }), null);
  assert.equal(cache.find({ ...request, decisionAtMs: 1600 }), null);
  assert.equal(cache.find({ ...request, minimumRequestedAtMs: 1100 }), null);
  assert.equal(cache.find({ ...request, marketRevision: 'market2' }), null);
  const reused = cache.find(request)!;
  reused.outputAmount = '0';
  assert.equal(cache.find(request)?.outputAmount, '110');
});
