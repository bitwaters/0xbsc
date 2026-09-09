import type { MarketFact } from '../../src/gmgn/facts.js';
import { trialReport } from '../../src/research/trial-report.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { runtimeConfigSchema } from '../../src/config/load.js';
import { validateModel } from '../../src/decision/model.js';
import { GmgnApi } from '../../src/gmgn/api.js';
import { GmgnClient } from '../../src/gmgn/client.js';
import { Storage } from '../../src/storage/database.js';
import { TrialRuntime } from '../../src/decision/trial-runtime.js';
import { OutboxDeliveryService } from '../../src/delivery/outbox.js';
import { PublicationGuard } from '../../src/delivery/publication-guard.js';
import { TelegramClient } from '../../src/delivery/telegram.js';
import {
  prepareTrialDelivery,
  renderTrial,
  loadPublicationModel
} from '../../src/delivery/trial-publication.js';
import type { NormalizedEvent } from '../../src/discovery/events.js';
const token = '0x' + 'a'.repeat(40),
  pool = '0x' + 'b'.repeat(40),
  creator = '0x' + 'c'.repeat(40);
const manifestPath = 'models/flow-momentum-trial-v1.json';
const model = validateModel(JSON.parse(readFileSync(manifestPath, 'utf8')));
async function fixture(
  change: {
    unsafe?: boolean;
    falling?: boolean;
    entrapment?: number;
    missingCreator?: boolean;
    missingVolume?: boolean;
  } = {}
) {
  let now = 20000,
    infoCount = 0,
    quoteCount = 0;
  let currentPool = pool;
  const calls: string[] = [];
  const config = runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')));
  config.publication = { engine: 'trial', manifest_path: manifestPath, model_hash: model.hash };
  const storage = await Storage.open(':memory:');
  await storage.recordConfigRevision('cfg', {}, now);
  const api = new GmgnApi(
    new GmgnClient({
      baseUrl: 'https://example.invalid',
      apiKey: 'fake',
      now: () => now,
      onFact: () => {},
      transport: (input) => {
        now += 50;
        calls.push(input.path);
        let data: unknown;
        switch (input.path) {
          case '/v1/token/info':
            data = {
              biggest_pool_address: currentPool,
              liquidity: 100000,
              dev: { creator_address: change.missingCreator ? '' : creator },
              price: {
                price: String(1 + (change.falling ? -1 : 1) * ++infoCount * 0.001),
                volume_1m: change.missingVolume ? undefined : 5000,
                volume_5m: 15000,
                buy_volume_1m: 4000,
                sell_volume_1m: 1000,
                swaps_1m: 60
              },
              stat: {
                dev_team_hold_rate: 0,
                top_entrapment_trader_percentage: change.entrapment ?? 0,
                top_bundler_trader_percentage: 0,
                top70_sniper_hold_rate: 0,
                creator_hold_rate: 0.01,
                creator_created_count: 2
              }
            };
            break;
          case '/v1/token/security':
            data = {
              buy_tax: 0,
              sell_tax: 0,
              top_10_holder_rate: 0.01,
              can_not_sell: change.unsafe ?? false,
              is_renounced: true,
              renounced_mint: true,
              lock_summary: { lock_percent: 1 }
            };
            break;
          case '/v1/token/pool_info':
            data = { address: currentPool };
            break;
          case '/v1/market/token_top_holders':
            data = { list: [{ address: creator, amount_percentage: 0.01, is_suspicious: false }] };
            break;
          case '/v1/market/token_top_traders':
            data = { list: [] };
            break;
          case '/v1/user/created_tokens':
            data = { open_ratio: 0.9 };
            break;
          case '/v1/trade/gas_price':
            data = { native_token_usd_price: '600' };
            break;
          case '/v1/trade/quote':
            quoteCount++;
            data = {
              output_amount: input.query?.input_token === token ? '10000000000000000' : '7',
              slippage: input.query?.slippage,
              tx: {
                amount_in_usd: input.query?.input_token === token ? '9.99' : '10',
                amount_out_usd: input.query?.input_token === token ? '9.9' : '9.99',
                gas_limit: 100000
              }
            };
            break;
          default:
            throw new Error('UNEXPECTED_REQUEST:' + input.path);
        }
        return Promise.resolve({ status: 200, headers: {}, body: { code: 0, data } });
      }
    }),
    5000,
    () => now
  );
  const clock = {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
    random: () => 0.5
  };
  const runtime = new TrialRuntime(storage, config, 'cfg', api, clock);
  await runtime.start();
  runtime.observe({ tokenAddress: token, decisionEligible: true } as NormalizedEvent);
  return {
    storage,
    runtime,
    api,
    clock,
    calls,
    config,
    now: () => now,
    advance: () => {
      now += 11000;
    },
    setPool: (value: string) => {
      currentPool = value;
    },
    quotes: () => quoteCount
  };
}
void test('activated candidate completes confirmation ahead of the untouched discovery backlog', async () => {
  const f = await fixture();
  try {
    await f.runtime.tick();
    assert.equal(f.runtime.snapshot().activatedWatching, 1);
    for (let i = 1; i < 50; i++) {
      f.runtime.observe({
        tokenAddress: '0x' + i.toString(16).padStart(40, '0'),
        decisionEligible: true
      } as NormalizedEvent);
    }
    for (let i = 0; i < 2; i++) {
      f.advance();
      await f.runtime.tick();
    }
    const pending = await f.storage.pendingOutboxSignals(f.now(), true, 'opportunity-v1');
    assert.equal(pending.length, 1, JSON.stringify(f.runtime.snapshot()));
    assert.ok(
      (
        f.storage.db
          .prepare('SELECT COUNT(*) AS n FROM research_fact_references WHERE run_id=?')
          .get(f.runtime.runId) as { n: number }
      ).n > 0
    );
    assert.equal(
      (
        f.storage.db
          .prepare(
            'SELECT COUNT(*) AS n FROM research_facts f WHERE NOT EXISTS(SELECT 1 FROM research_fact_references r WHERE r.fact_id=f.fact_id AND r.run_id=?)'
          )
          .get(f.runtime.runId) as { n: number }
      ).n,
      0
    );
    assert.equal(f.runtime.snapshot().counts.MARKET_READY_RESEARCH_ONLY, 2);
  } finally {
    await f.runtime.close();
    f.storage.close();
  }
});

void test('trial runs actual fact adapter to safety, immutable new-format outbox, mock send and separate baselines', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i++) {
      await f.runtime.tick();
      if (i < 2) f.advance();
    }
    const pending = await f.storage.pendingOutboxSignals(f.now(), true, 'opportunity-v1');
    assert.equal(pending.length, 1, JSON.stringify(f.runtime.snapshot()));
    assert.equal((await f.storage.pendingOutboxSignals(f.now(), true)).length, 0);
    let sends = 0;
    const service = new OutboxDeliveryService({
      storage: f.storage,
      decisionFormat: 'opportunity-v1',
      publicationGuard: new PublicationGuard(f.storage, f.now, 'opportunity-v1'),
      chatId: '-100',
      now: f.now,
      telegram: new TelegramClient({
        botToken: 'fake',
        transport: () => {
          sends++;
          return Promise.resolve({
            status: 200,
            body: { ok: true, result: { message_id: 1, chat: { id: '-100' } } }
          });
        }
      }),
      render: (s) => renderTrial(s, f.config),
      prepareBeforeDelivery: (s) =>
        prepareTrialDelivery(f.storage, s, f.config, model.hash, f.now()),
      revalidateBeforeUnknownRetry: () => Promise.resolve(false)
    });
    assert.equal(await service.deliver(pending[0]!), 'sent');
    const confirmedAt = f.now();
    await f.runtime.confirmed(pending[0]!, confirmedAt);
    const report = trialReport(f.storage.db, f.runtime.runId);
    assert.equal(report.promotionCertificate, false);
    assert.equal(report.cardReference.targets[0]?.counts.CENSORED, 1);
    assert.equal(report.postConfirmationMarket.status, 'UNVERIFIED');
    assert.equal(sends, 1);
    await service.recoverAndDeliver();
    assert.equal(sends, 1);
    assert.equal(
      (f.storage.db.prepare('SELECT state FROM publication_token_locks').get() as { state: string })
        .state,
      'SENT'
    );
    const baselines = f.storage.db
      .prepare('SELECT track,status,reason FROM evaluation_baselines')
      .all() as { track: string; status: string; reason: string }[];
    assert.equal(
      baselines.find((b) => b.track === 'post_confirmation_market_v1')?.status,
      'UNVERIFIED'
    );
    assert.equal(baselines.find((b) => b.track === 'post_confirmation_quote_v1')?.status, 'VALID');
    assert.equal(baselines.find((b) => b.track === 'trial_card_reference_v1')?.status, 'VALID');
    assert.equal(
      (f.storage.db.prepare('SELECT COUNT(*) AS n FROM price_samples').get() as { n: number }).n,
      0
    );
    assert.equal(
      (
        f.storage.db.prepare('SELECT COUNT(*) AS n FROM research_outcome_tasks').get() as {
          n: number;
        }
      ).n,
      4
    );
    const frozen = f.storage.db.prepare('SELECT decision_json FROM signals').get();
    f.advance();
    await f.runtime.confirmed(pending[0]!, confirmedAt);
    assert.deepEqual(f.storage.db.prepare('SELECT decision_json FROM signals').get(), frozen);
  } finally {
    await f.runtime.close();
    f.storage.close();
  }
});
void test('falling prices and unsafe contracts cannot create trial signals; unsafe never quotes', async () => {
  for (const change of [{ falling: true }, { unsafe: true }]) {
    const f = await fixture(change);
    try {
      for (let i = 0; i < 4; i++) {
        await f.runtime.tick();
        f.advance();
      }
      assert.equal(
        (await f.storage.pendingOutboxSignals(f.now(), false, 'opportunity-v1')).length,
        0,
        JSON.stringify(f.runtime.snapshot())
      );
      assert.equal(f.quotes(), 0);
    } finally {
      await f.runtime.close();
      f.storage.close();
    }
  }
});
void test('stale prepared card cancels without repricing; model hash mismatch refuses startup', async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        loadPublicationModel({
          ...f.config,
          publication: { engine: 'trial', manifest_path: manifestPath, model_hash: 'a'.repeat(64) }
        }),
      /HASH_MISMATCH/
    );
    for (let i = 0; i < 3; i++) {
      await f.runtime.tick();
      if (i < 2) f.advance();
    }
    const [signal] = await f.storage.pendingOutboxSignals(f.now(), true, 'opportunity-v1');
    assert.ok(signal, JSON.stringify(f.runtime.snapshot()));
    const old = structuredClone(signal.decision);
    f.advance();
    assert.equal(
      await prepareTrialDelivery(f.storage, signal, f.config, model.hash, f.now()),
      null
    );
    assert.deepEqual(signal.decision, old);
    assert.equal(
      (
        f.storage.db.prepare('SELECT delivery_state FROM signals').get() as {
          delivery_state: string;
        }
      ).delivery_state,
      'SEND_FAILED'
    );
  } finally {
    await f.runtime.close();
    f.storage.close();
  }
});

void test('pool migration invalidates the persisted old opportunity before any new preparation', async () => {
  const f = await fixture();
  try {
    await f.runtime.tick();
    f.advance();
    await f.runtime.tick();
    const old = f.storage.db
      .prepare('SELECT state,anchor_price FROM market_opportunities')
      .get() as { state: string; anchor_price: string };
    assert.equal(old.state, 'READY');
    f.setPool('0x' + 'd'.repeat(40));
    f.advance();
    await f.runtime.tick();
    const after = f.storage.db
      .prepare('SELECT state,anchor_price FROM market_opportunities WHERE pool_revision=?')
      .get(pool) as { state: string; anchor_price: string };
    assert.equal(after.state, 'INVALIDATED');
    assert.equal(after.anchor_price, old.anchor_price);
    assert.equal(f.quotes(), 0);
  } finally {
    await f.runtime.close();
    f.storage.close();
  }
});

void test('a failed preparation evidence batch rolls back every fact instead of leaving a partial batch', async () => {
  const f = await fixture();
  try {
    await f.runtime.tick();
    const row = f.storage.db
      .prepare('SELECT envelope_json,payload_json FROM research_facts LIMIT 1')
      .get() as { envelope_json: string; payload_json: string };
    const first = {
      ...(JSON.parse(row.envelope_json) as Omit<MarketFact, 'payload'>),
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      factId: 'batch-first',
      attemptId: 'batch-attempt'
    };
    const conflict = { ...first, factId: 'batch-conflict' };
    await assert.rejects(
      f.runtime.research.recordFactsBatch([first, conflict], f.runtime.runId, 2 * 1024 ** 3, true),
      /conflicting physical response/
    );
    assert.equal(
      f.storage.db.prepare("SELECT 1 FROM research_facts WHERE attempt_id='batch-attempt'").get(),
      undefined
    );
    assert.equal(
      f.storage.db
        .prepare("SELECT 1 FROM research_fact_references WHERE fact_id='batch-first'")
        .get(),
      undefined
    );
    assert.deepEqual(
      await f.runtime.research.recordFactsBatch([first], f.runtime.runId, 2 * 1024 ** 3, true),
      [true]
    );
    assert.deepEqual(
      await f.runtime.research.recordFactsBatch([first], f.runtime.runId, 2 * 1024 ** 3, true),
      [false]
    );
    assert.equal(
      (
        f.storage.db
          .prepare("SELECT COUNT(*) AS n FROM research_fact_references WHERE fact_id='batch-first'")
          .get() as { n: number }
      ).n,
      1
    );
  } finally {
    await f.runtime.close();
    f.storage.close();
  }
});

void test('known Info risk releases its slot without security, traders or quotes and persists cooldown across restart', async () => {
  const change = { entrapment: 0.5 };
  const f = await fixture(change);
  let restarted: TrialRuntime | undefined;
  try {
    await f.runtime.tick();
    assert.deepEqual(f.calls, ['/v1/token/info']);
    assert.equal(f.runtime.snapshot().watching, 0);
    assert.equal(f.runtime.snapshot().counts.entrapment_limit, 1);
    const row = f.storage.db.prepare('SELECT details_json FROM trial_risk_rejections').get() as {
      details_json: string;
    };
    assert.equal((JSON.parse(row.details_json) as { actual: string }).actual, '0.5');
    await f.runtime.close();
    restarted = new TrialRuntime(f.storage, f.config, 'cfg', f.api, f.clock);
    await restarted.start();
    f.advance();
    restarted.observe({ tokenAddress: token, decisionEligible: true } as NormalizedEvent);
    await restarted.tick();
    assert.equal(f.calls.length, 1);
    f.advance();
    await restarted.tick();
    assert.equal(f.calls.length, 1);
    change.entrapment = 0;
    f.advance();
    await restarted.tick();
    assert.ok(f.calls.length > 1);
    assert.equal(f.quotes(), 0);
  } finally {
    if (restarted) await restarted.close();
    else await f.runtime.close();
    f.storage.close();
  }
});
void test('creator absence is explicit before costly requests and unsafe basic contracts never warm traders', async () => {
  for (const change of [{ missingCreator: true }, { unsafe: true }]) {
    const f = await fixture(change);
    try {
      await f.runtime.tick();
      assert.equal(f.calls.includes('/v1/market/token_top_traders'), false);
      assert.equal(f.calls.includes('/v1/market/token_top_holders'), false);
      assert.equal(f.quotes(), 0);
      if ('missingCreator' in change) assert.equal(f.runtime.snapshot().counts.CREATOR_MISSING, 1);
    } finally {
      await f.runtime.close();
      f.storage.close();
    }
  }
});
void test('missing market data rotates after a bounded retry without traders or quotes', async () => {
  const f = await fixture({ missingVolume: true });
  try {
    for (let i = 0; i < 4; i++) {
      await f.runtime.tick();
      if (i < 3) f.advance();
    }
    assert.equal(f.runtime.snapshot().watching, 0);
    assert.equal(f.runtime.snapshot().waiting, 1);
    assert.equal(f.runtime.snapshot().counts.DATA_WAIT_ROTATED, 1);
    assert.equal(f.quotes(), 0);
    assert.ok(f.calls.every((path) => path === '/v1/token/info'));
  } finally {
    await f.runtime.close();
    f.storage.close();
  }
});
void test('a new pool bypasses the previous pool rejection but is fully checked again', async () => {
  const change = { entrapment: 0.5 };
  const f = await fixture(change);
  try {
    await f.runtime.tick();
    const nextPool = '0x' + 'd'.repeat(40);
    f.setPool(nextPool);
    change.entrapment = 0;
    f.runtime.observe({
      tokenAddress: token,
      decisionEligible: true,
      payload: { biggest_pool_address: nextPool }
    } as unknown as NormalizedEvent);
    await f.runtime.tick();
    assert.equal(f.calls.filter((path) => path === '/v1/token/info').length, 2);
    assert.equal(f.runtime.snapshot().counts.BASIC_SAFETY_PASS, 1);
    assert.equal(f.quotes(), 0);
  } finally {
    await f.runtime.close();
    f.storage.close();
  }
});
void test('a discovery burst beyond the old 2000 audit limit stays bounded and drains without stopping', async () => {
  const f = await fixture({ entrapment: 0.5 });
  try {
    for (let i = 1; i <= 2500; i++)
      f.runtime.observe({
        tokenAddress: '0x' + i.toString(16).padStart(40, '0'),
        decisionEligible: true
      } as NormalizedEvent);
    assert.equal(f.runtime.snapshot().waiting, 2501);
    assert.equal(f.runtime.snapshot().failure, null);
    await f.runtime.tick();
    assert.equal(f.runtime.snapshot().failure, null);
    assert.ok(f.runtime.snapshot().pendingUniverseWrites < 2501);
  } finally {
    await f.runtime.close();
    f.storage.close();
  }
});
