import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OutboxDeliveryService } from '../../src/delivery/outbox.js';
import { TelegramClient, TelegramError } from '../../src/delivery/telegram.js';
import { Storage } from '../../src/storage/database.js';

async function withOutbox(
  responder: (attempt: number) => Promise<unknown>,
  run: (input: {
    storage: Storage;
    service: OutboxDeliveryService;
    sent: () => number;
  }) => Promise<void>,
  prepareBeforeDelivery?: ConstructorParameters<
    typeof OutboxDeliveryService
  >[0]['prepareBeforeDelivery']
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-outbox-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  let attempt = 0;
  try {
    const now = 1_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xoutbox-delivery', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-delivery', 'bsc', '0xoutbox-delivery', 'continuation', 'READY', 'cfg', ?, ?)"
      )
      .run(now, now);
    await storage.createSignalOutbox({
      signalId: 'sig-delivery',
      episodeId: 'ep-delivery',
      configRevisionId: 'cfg',
      quoteSnapshot: { tier: 10 },
      decision: { score: 80 },
      nowMs: now
    });
    const telegram = new TelegramClient({
      botToken: 'token',
      transport: () => {
        attempt += 1;
        return responder(attempt).then((body) => {
          if (
            body &&
            typeof body === 'object' &&
            'transportStatus' in body &&
            'transportBody' in body
          ) {
            const response = body as { transportStatus: number; transportBody: unknown };
            return { status: response.transportStatus, body: response.transportBody };
          }
          return { status: 200, body };
        });
      }
    });
    const service = new OutboxDeliveryService({
      storage,
      telegram,
      chatId: '-100',
      render: (signal) => ({ text: `signal:${signal.id}` }),
      ...(prepareBeforeDelivery === undefined ? {} : { prepareBeforeDelivery }),
      revalidateBeforeUnknownRetry: () => Promise.resolve(true),
      now: () => now + attempt
    });
    await run({ storage, service, sent: () => attempt });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void test('confirms a pending Outbox message atomically with its Telegram message identity', async () => {
  await withOutbox(
    () => Promise.resolve({ ok: true, result: { message_id: 99, chat: { id: '-100' } } }),
    async ({ storage, service, sent }) => {
      await storage.updatePendingSignalMarket(
        'sig-delivery',
        { priceUsd: '0.42' },
        undefined,
        1_000
      );
      await service.recoverAndDeliver();
      assert.equal(sent(), 1);
      assert.deepEqual(
        storage.db
          .prepare(
            'SELECT delivery_state AS state, telegram_chat_id AS chatId, telegram_message_id AS messageId FROM signals'
          )
          .get(),
        { state: 'SENT', chatId: '-100', messageId: '99' }
      );
      assert.deepEqual(storage.db.prepare('SELECT state FROM episodes').get(), { state: 'SENT' });
      assert.deepEqual(storage.db.prepare('SELECT ended_at_ms AS endedAtMs FROM episodes').get(), {
        endedAtMs: 1_001
      });
      assert.throws(
        () =>
          storage.db
            .prepare(
              "UPDATE signals SET decision_json=json_set(decision_json,'$.presentation.priceUsd','0.84')"
            )
            .run(),
        /immutable/
      );
      const decision = JSON.parse(
        (
          storage.db.prepare('SELECT decision_json AS decision FROM signals').get() as {
            decision: string;
          }
        ).decision
      ) as {
        score: number;
        marketEntryPriceUsd: string;
        marketEntryAtMs: number;
        presentation: { priceUsd: string };
      };
      assert.deepEqual(decision, {
        score: 80,
        marketEntryPriceUsd: '0.42',
        marketEntryAtMs: 1_001,
        presentation: { priceUsd: '0.42' }
      });
    }
  );
});

void test('prepares refreshed signal data before rendering and sending', async () => {
  let preparedDecision: unknown;
  let activeStorage: Storage | undefined;
  await withOutbox(
    () => Promise.resolve({ ok: true, result: { message_id: 99, chat: { id: '-100' } } }),
    async ({ storage, service }) => {
      activeStorage = storage;
      assert.equal(await service.deliver((await storage.pendingOutboxSignals(1_000))[0]!), 'sent');
      const stored = storage.db.prepare('SELECT decision_json AS decision FROM signals').get() as {
        decision: string;
      };
      assert.equal(
        (JSON.parse(stored.decision) as { presentation?: { priceUsd?: string } }).presentation
          ?.priceUsd,
        '2'
      );
      assert.equal(
        (preparedDecision as { presentation?: { priceUsd?: string } }).presentation?.priceUsd,
        '2'
      );
    },
    async (signal) => {
      const decision = { ...(signal.decision as object), presentation: { priceUsd: '2' } };
      preparedDecision = decision;
      if (!activeStorage) throw new Error('storage not initialized');
      return activeStorage.updatePendingSignalMarket(
        signal.id,
        { priceUsd: '2' },
        undefined,
        1_000
      );
    }
  );
});

void test('retries only preparation failures explicitly classified as transient', async () => {
  await withOutbox(
    () => Promise.reject(new Error('should not reach Telegram')),
    async ({ storage, service }) => {
      assert.equal(
        await service.deliver((await storage.pendingOutboxSignals(1_000))[0]!),
        'failed'
      );
      assert.deepEqual(storage.db.prepare('SELECT delivery_state AS state FROM signals').get(), {
        state: 'SEND_FAILED'
      });
    },
    () => Promise.reject(new TypeError('invalid pending signal'))
  );

  const directory = await mkdtemp(join(tmpdir(), 'gmgn-outbox-preparation-retry-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    const now = 1_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xretry', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-retry', 'bsc', '0xretry', 'continuation', 'READY', 'cfg', ?, ?)"
      )
      .run(now, now);
    await storage.createSignalOutbox({
      signalId: 'sig-retry',
      episodeId: 'ep-retry',
      configRevisionId: 'cfg',
      quoteSnapshot: {},
      decision: {},
      nowMs: now
    });
    const service = new OutboxDeliveryService({
      storage,
      telegram: new TelegramClient({ botToken: 'token' }),
      chatId: '-100',
      render: () => ({ text: 'unused' }),
      prepareBeforeDelivery: () => Promise.reject(new Error('temporary source failure')),
      preparationRetryAt: (_error, currentMs) => currentMs + 5_000,
      revalidateBeforeUnknownRetry: () => Promise.resolve(true),
      now: () => now
    });
    assert.equal(await service.deliver((await storage.pendingOutboxSignals(now))[0]!), 'deferred');
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT delivery_state AS state, next_delivery_attempt_at_ms AS retryAt FROM signals'
        )
        .get(),
      { state: 'PENDING', retryAt: 6_000 }
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('schedules follow-up work only after Telegram confirmation', async () => {
  await withOutbox(
    () => Promise.resolve({ ok: true, result: { message_id: 99, chat: { id: '-100' } } }),
    async ({ storage }) => {
      await storage.scheduleResultTasks({
        episodeId: 'ep-delivery',
        signalId: null,
        score: 70,
        hardSafetyPassed: true,
        formal: false,
        narrative: false,
        fromMs: 500,
        checkpointsMinutes: [1, 3],
        narrativeCheckpointsMinutes: []
      });
      const observed = new OutboxDeliveryService({
        storage,
        telegram: new TelegramClient({
          botToken: 'token',
          transport: () =>
            Promise.resolve({
              status: 200,
              body: { ok: true, result: { message_id: 100, chat: { id: '-100' } } }
            })
        }),
        chatId: '-100',
        render: () => ({ text: 'unused' }),
        revalidateBeforeUnknownRetry: () => Promise.resolve(true),
        outcomeCheckpointsMinutes: [1, 3],
        narrativeOutcomeCheckpointsMinutes: [5]
      });
      await observed.recoverAndDeliver();
      assert.equal(
        (
          storage.db
            .prepare(
              "SELECT COUNT(*) AS count FROM price_samples WHERE task_kind LIKE 'telegram_edit_%'"
            )
            .get() as { count: number }
        ).count,
        0
      );
      assert.equal(
        (
          storage.db
            .prepare("SELECT COUNT(*) AS count FROM price_samples WHERE task_kind LIKE 'outcome_%'")
            .get() as { count: number }
        ).count,
        4
      );
      assert.deepEqual(
        storage.db
          .prepare(
            "SELECT DISTINCT signal_id AS signalId, status FROM price_samples WHERE task_kind LIKE 'outcome_%'"
          )
          .all(),
        [
          { signalId: null, status: 'PENDING' },
          { signalId: 'sig-delivery', status: 'PENDING' }
        ]
      );
    }
  );
});

void test('records unknown delivery, validates freshness once, and marks the retry as a possible duplicate', async () => {
  await withOutbox(
    (attempt) =>
      attempt === 1
        ? Promise.reject(new TelegramError('timeout', 'Telegram request timed out'))
        : Promise.resolve({ ok: true, result: { message_id: 99, chat: { id: '-100' } } }),
    async ({ storage, service, sent }) => {
      await service.recoverAndDeliver();
      assert.equal(sent(), 1);
      assert.deepEqual(
        storage.db
          .prepare('SELECT delivery_state AS state, retry_count AS retries FROM signals')
          .get(),
        {
          state: 'DELIVERY_UNKNOWN',
          retries: 0
        }
      );
      await service.recoverAndDeliver();
      assert.equal(sent(), 2);
      assert.deepEqual(
        storage.db
          .prepare(
            'SELECT delivery_state AS state, retry_count AS retries, possible_duplicate AS duplicate FROM signals'
          )
          .get(),
        { state: 'SENT', retries: 1, duplicate: 1 }
      );
    }
  );
});

void test('defers a rate-limited send without losing the formal signal', async () => {
  await withOutbox(
    () =>
      Promise.resolve({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 30 }
      }),
    async ({ storage, service, sent }) => {
      assert.equal(
        await service.deliver((await storage.pendingOutboxSignals(1_000))[0]!),
        'deferred'
      );
      assert.equal(sent(), 1);
      assert.deepEqual(
        storage.db
          .prepare(
            'SELECT delivery_state AS state, next_delivery_attempt_at_ms AS retryAt FROM signals'
          )
          .get(),
        { state: 'PENDING', retryAt: 31_001 }
      );
      await service.recoverAndDeliver();
      assert.equal(sent(), 1);
    }
  );
});

void test('treats an HTTP 429 response as retryable rate limiting', async () => {
  await withOutbox(
    () =>
      Promise.resolve({
        transportStatus: 429,
        transportBody: { description: 'Too Many Requests' }
      }),
    async ({ storage, service }) => {
      assert.equal(
        await service.deliver((await storage.pendingOutboxSignals(1_000))[0]!),
        'deferred'
      );
      assert.deepEqual(
        storage.db
          .prepare(
            'SELECT delivery_state AS state, next_delivery_attempt_at_ms AS retryAt FROM signals'
          )
          .get(),
        { state: 'PENDING', retryAt: 31_001 }
      );
    }
  );
});

void test('does not retry stale unknown delivery and preserves known API rejection as a failed send', async () => {
  await withOutbox(
    () => Promise.reject(new TelegramError('timeout', 'Telegram request timed out')),
    async ({ storage, service }) => {
      await service.recoverAndDeliver();
      const stale = new OutboxDeliveryService({
        storage,
        telegram: new TelegramClient({
          botToken: 'token',
          transport: () => Promise.reject(new Error('should not send'))
        }),
        chatId: '-100',
        render: () => ({ text: 'unused' }),
        revalidateBeforeUnknownRetry: () => Promise.resolve(false),
        now: () => 2_000
      });
      await stale.recoverAndDeliver();
      assert.deepEqual(storage.db.prepare('SELECT delivery_state AS state FROM signals').get(), {
        state: 'SEND_FAILED'
      });
    }
  );
  await withOutbox(
    () => Promise.resolve({ ok: false, description: 'chat not found' }),
    async ({ storage, service, sent }) => {
      await service.recoverAndDeliver();
      assert.equal(sent(), 1);
      assert.deepEqual(storage.db.prepare('SELECT delivery_state AS state FROM signals').get(), {
        state: 'SEND_FAILED'
      });
    }
  );
});

void test('has no delivery count quota and never auto-deletes confirmed formal signals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-outbox-burst-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    const now = 1_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
    for (const index of [1, 2, 3]) {
      const token = `0xburst${index}`;
      const episode = `ep-burst-${index}`;
      storage.db
        .prepare(
          "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', ?, ?, ?)"
        )
        .run(token, now, now);
      storage.db
        .prepare(
          "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES (?, 'bsc', ?, 'continuation', 'READY', 'cfg', ?, ?)"
        )
        .run(episode, token, now, now);
      assert.equal(
        await storage.createSignalOutbox({
          signalId: `sig-burst-${index}`,
          episodeId: episode,
          configRevisionId: 'cfg',
          quoteSnapshot: {},
          decision: {},
          nowMs: now
        }),
        'created'
      );
      assert.equal(
        await storage.confirmTelegramDelivery({
          signalId: `sig-burst-${index}`,
          chatId: '-100',
          messageId: index,
          nowMs: now
        }),
        true
      );
    }
    assert.equal(
      (
        storage.db
          .prepare("SELECT COUNT(*) AS count FROM signals WHERE delivery_state = 'SENT'")
          .get() as { count: number }
      ).count,
      3
    );
    assert.equal(
      (
        storage.db
          .prepare('SELECT COUNT(*) AS count FROM signals WHERE telegram_deleted = 1')
          .get() as { count: number }
      ).count,
      0
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('persists exact rich payload before HTTP and keeps it immutable through later risk tracking', async () => {
  await withOutbox(
    () => Promise.resolve({}),
    async ({ storage }) => {
      const payload = {
        richMessage: { html: '<p>推送参考价：$0.42</p>', skip_entity_detection: true },
        replyMarkup: { inline_keyboard: [[{ text: 'GMGN', url: 'https://gmgn.ai/' }]] }
      };
      const service = new OutboxDeliveryService({
        storage,
        chatId: '-100',
        render: () => payload,
        prepareBeforeDelivery: (signal) =>
          storage.updatePendingSignalMarket(
            signal.id,
            { priceUsd: '0.42' },
            { accepted: true },
            1000
          ),
        revalidateBeforeUnknownRetry: () => Promise.resolve(true),
        outcomeCheckpointsMinutes: [1, 3],
        now: () => 1000,
        telegram: new TelegramClient({
          botToken: 'token',
          transport: () => {
            const snapshot = storage.db
              .prepare('SELECT payload_json AS payload FROM signal_delivery_snapshots')
              .get() as { payload: string };
            assert.deepEqual(JSON.parse(snapshot.payload), payload);
            return Promise.resolve({
              status: 200,
              body: { ok: true, result: { message_id: 99, chat: { id: '-100' } } }
            });
          }
        })
      });
      assert.equal(await service.deliver((await storage.pendingOutboxSignals(1000))[0]!), 'sent');
      const before = storage.db.prepare('SELECT * FROM signal_delivery_snapshots').all();
      await storage.recordSentRisk('0xoutbox-delivery', 'failed', 'honeypot', 2000);
      assert.deepEqual(storage.db.prepare('SELECT * FROM signal_delivery_snapshots').all(), before);
      assert.throws(
        () => storage.db.prepare("UPDATE signal_delivery_snapshots SET payload_json='{}'").run(),
        /immutable/
      );
      assert.throws(
        () => storage.db.prepare('DELETE FROM signal_delivery_snapshots').run(),
        /immutable/
      );
      assert.throws(
        () => storage.db.prepare('UPDATE signals SET confirmed_snapshot_id=NULL').run(),
        /immutable/
      );
      assert.deepEqual(
        storage.db
          .prepare(
            "SELECT DISTINCT entry_market_price AS price,entry_at_ms AS time FROM price_samples WHERE task_kind LIKE 'outcome_%'"
          )
          .all(),
        [{ price: '0.42', time: 1000 }]
      );
      assert.equal(
        (
          storage.db
            .prepare(
              "SELECT count(*) AS n FROM price_samples WHERE task_kind LIKE 'telegram_edit_%'"
            )
            .get() as { n: number }
        ).n,
        0
      );
      assert.equal(
        (
          storage.db
            .prepare(
              'SELECT count(*) AS n FROM signals s JOIN signal_delivery_snapshots d ON d.id=s.confirmed_snapshot_id AND d.signal_id=s.id'
            )
            .get() as { n: number }
        ).n,
        1
      );
    }
  );
});

void test('unknown delivery retry preserves both attempts and links only the confirmed snapshot', async () => {
  let attemptStorage: Storage;
  await withOutbox(
    (attempt) => {
      assert.equal(
        (
          attemptStorage.db
            .prepare('SELECT count(*) AS n FROM signal_delivery_snapshots')
            .get() as { n: number }
        ).n,
        attempt
      );
      if (attempt === 1) return Promise.reject(new TelegramError('timeout', 'unknown response'));
      return Promise.resolve({ ok: true, result: { message_id: 99, chat: { id: '-100' } } });
    },
    async ({ storage, service }) => {
      attemptStorage = storage;
      assert.equal(
        await service.deliver((await storage.pendingOutboxSignals(1000))[0]!),
        'unknown'
      );
      const first = storage.db.prepare('SELECT * FROM signal_delivery_snapshots').get() as {
        id: string;
      };
      await service.recoverAndDeliver();
      assert.deepEqual(
        storage.db.prepare('SELECT * FROM signal_delivery_snapshots WHERE id=?').get(first.id),
        first
      );
      const signal = storage.db
        .prepare('SELECT delivery_state AS state,confirmed_snapshot_id AS id FROM signals')
        .get() as { state: string; id: string };
      assert.equal(signal.state, 'SENT');
      assert.notEqual(signal.id, first.id);
      assert.equal(
        (
          storage.db.prepare('SELECT count(*) AS n FROM signal_delivery_snapshots').get() as {
            n: number;
          }
        ).n,
        2
      );
    }
  );
});
