import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { runtimeConfigSchema } from '../../src/config/load.js';
import { ResearchRuntime, loadResearchModel } from '../../src/research/runtime.js';
import { ResearchRecorder } from '../../src/research/recorder.js';
import { Storage } from '../../src/storage/database.js';
import { GmgnApi } from '../../src/gmgn/api.js';
import { GmgnClient } from '../../src/gmgn/client.js';
import { GmgnScheduler } from '../../src/gmgn/scheduler.js';
import { normalizeEvent } from '../../src/discovery/events.js';
import { token, pool, epoch } from './capture-fixture.js';
void test('collect uses common physical scheduler while observe adds no requests', async () => {
  for (const mode of ['collect', 'observe'] as const) {
    const storage = await Storage.open(':memory:');
    let now = epoch,
      calls = 0;
    const config = runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')));
    config.research = { mode, run_id: 'run', max_storage_bytes: 2 ** 30 };
    const recorder = new ResearchRecorder(storage, config.research, () => undefined);
    try {
      await recorder.start(now);
      const clock = {
        now: () => now,
        random: () => 0.5,
        sleep: (ms: number) => {
          now += ms;
          return Promise.resolve();
        }
      };
      const scheduler = new GmgnScheduler(clock, 14, 20, 6, {
        paced: true,
        researchEnabled: mode === 'collect',
        maxConcurrent: 4
      });
      const api = new GmgnApi(
        new GmgnClient({
          baseUrl: 'https://example.invalid',
          apiKey: 'fixture',
          now: () => now,
          scheduler,
          weights: { info: 1 },
          onFact: (f) => recorder.fact(f),
          transport: () => {
            calls++;
            return Promise.resolve({
              status: 200,
              headers: {},
              body: {
                data: { price: { price: '1' }, liquidity: '1000', biggest_pool_address: pool }
              }
            });
          }
        })
      );
      await recorder.research.recordUniverse(
        normalizeEvent({
          chain: 'bsc',
          tokenAddress: token,
          source: 'trending',
          sourceEventAtMs: null,
          observedAtMs: now,
          evidenceFamily: 'attention',
          strength: 'weak',
          expiresAtMs: now + 60000,
          rawPayloadRef: 'ref',
          payload: {},
          decisionEligible: false
        }),
        'run',
        'run',
        20,
        2 ** 30
      );
      const runtime = new ResearchRuntime(recorder, config, api, clock);
      await runtime.start();
      await runtime.tick();
      assert.equal(calls, mode === 'collect' ? 1 : 0);
      await runtime.tick();
      assert.equal(calls, mode === 'collect' ? 1 : 0);
      assert.equal(scheduler.snapshot().researchInFlight, 0);
      assert.equal(recorder.stoppedReason, null);
      assert.equal(
        (storage.db.prepare('SELECT COUNT(*) AS n FROM research_facts').get() as { n: number }).n,
        mode === 'collect' ? 1 : 0
      );
    } finally {
      recorder.close();
      storage.close();
    }
  }
});
void test('execute shadow refuses missing budget evidence and incorrect shared limits', () => {
  const config = runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')));
  config.research = { mode: 'execute_shadow', run_id: 'r', max_storage_bytes: 2 ** 30 };
  assert.throws(() => loadResearchModel(config), /MANIFEST_AND_BUDGET_REQUIRED/);
  config.research.mode = 'collect';
  config.gmgn.rate_limit.soft_weight_per_second = 20;
  assert.throws(() => loadResearchModel(config), /RESOURCE_POLICY_MISMATCH/);
});

void test('restart after durable preparation preserves the original simulated confirmation and performs no re-pricing requests', async () => {
  const { captureFixture } = await import('./capture-fixture.js');
  const { hashValue } = await import('../../src/research/protocol.js');
  const { watchingState } = await import('../../src/decision/opportunity.js');
  const { storage, fact } = await captureFixture();
  let calls = 0;
  const config = runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')));
  config.research = { mode: 'collect', run_id: 'run', max_storage_bytes: 2 ** 30 };
  const recorder = new ResearchRecorder(storage, config.research, () => undefined);
  try {
    const state = {
      ...watchingState(token, pool, 'model'),
      opportunityId: 'op',
      activationFactId: fact.factId,
      anchorPrice: '1',
      anchorAtMs: epoch,
      status: 'READY',
      version: 1
    };
    storage.db
      .prepare("UPDATE market_opportunities SET state_json=? WHERE opportunity_id='op'")
      .run(JSON.stringify(state));
    storage.db
      .prepare('INSERT INTO research_engine_states VALUES (?,?,?,?,?,?)')
      .run('run', 'model', token, pool, 1, JSON.stringify(state));
    const record = {
      preparedAtMs: epoch,
      result: {
        status: 'DRY_READY',
        context: { modelHash: 'model', token, poolRevision: pool, opportunityId: 'op' }
      }
    };
    storage.db
      .prepare('INSERT INTO research_registrations VALUES (?,?,?,?,?,?)')
      .run('prep', 'dry_preparation', 'run', epoch, hashValue(record), JSON.stringify(record));
    const unavailable = () => {
      calls++;
      return Promise.reject(new Error('unexpected request'));
    };
    const runtime = new ResearchRuntime(
      recorder,
      config,
      {
        token: unavailable,
        kline: unavailable,
        gas: unavailable,
        quote: unavailable,
        holders: unavailable,
        traders: unavailable,
        createdTokens: unavailable
      },
      { now: () => epoch + 10000, random: () => 0.5, sleep: () => Promise.resolve() }
    );
    await runtime.start();
    await runtime.start();
    assert.equal(calls, 0);
    assert.deepEqual(
      storage.db
        .prepare('SELECT DISTINCT confirmation_at_ms,status,reason FROM evaluation_baselines')
        .all(),
      [{ confirmation_at_ms: epoch + 1000, status: 'MISSING', reason: 'RESTART_AFTER_PREPARATION' }]
    );
    assert.equal(
      (
        storage.db
          .prepare("SELECT state FROM market_opportunities WHERE opportunity_id='op'")
          .get() as { state: string }
      ).state,
      'CONSUMED'
    );
  } finally {
    recorder.close();
    storage.close();
  }
});

void test('research capture owns retries and audits each physical attempt separately from formal traffic', async () => {
  let calls = 0;
  const observations: boolean[] = [];
  const { withGmgnContext } = await import('../../src/gmgn/context.js');
  const client = new GmgnClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'fixture',
    now: () => epoch,
    transport: () => {
      calls++;
      return Promise.reject(new Error('network unavailable'));
    },
    onObservation: (o) => observations.push(o.attempt?.research ?? false)
  });
  await assert.rejects(
    withGmgnContext({ research: true, purpose: 'baseline' }, () =>
      client.read({ method: 'GET', path: '/v1/token/info', query: { address: token } })
    )
  );
  assert.equal(calls, 1);
  assert.deepEqual(observations, [true]);
  await assert.rejects(
    client.read({ method: 'GET', path: '/v1/token/info', query: { address: token } })
  );
  assert.equal(calls, 3);
  assert.deepEqual(observations, [true, false, false]);
});
