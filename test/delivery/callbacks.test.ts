import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TelegramCallbackHandler, TelegramLongPoller } from '../../src/delivery/callbacks.js';
import { TelegramClient } from '../../src/delivery/telegram.js';
import { Storage } from '../../src/storage/database.js';

async function withHandler(
  run: (input: {
    handler: TelegramCallbackHandler;
    storage: Storage;
    calls: string[];
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-callback-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  const calls: string[] = [];
  try {
    const now = 1_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xcallback', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-callback', 'bsc', '0xcallback', 'continuation', 'SENT', 'cfg', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, telegram_chat_id, telegram_message_id, created_at_ms, updated_at_ms) VALUES ('sig-callback', 'ep-callback', 'cfg', 'SENT', '{}', '{}', '-100', '8', ?, ?)"
      )
      .run(now, now);
    const telegram = new TelegramClient({
      botToken: 'token',
      transport: (method) => {
        calls.push(method);
        return Promise.resolve({ status: 200, body: { ok: true, result: true } });
      }
    });
    const handler = new TelegramCallbackHandler({
      storage,
      telegram,
      allowedChatIds: ['-100'],
      allowedUserIds: ['7'],
      now: () => now,
      onRefresh: () => Promise.resolve(calls.push('refresh-work')).then(() => undefined),
      onBought: () => Promise.resolve(calls.push('bought-note')).then(() => undefined)
    });
    await run({ handler, storage, calls });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const callback = (updateId: number, data: string, userId = 7, chatId = -100, messageId = 8) => ({
  updateId,
  callbackQuery: { id: `cb-${updateId}`, fromUserId: userId, chatId, messageId, data }
});

void test('authorizes, associates and makes repeated callback updates idempotent', async () => {
  await withHandler(async ({ handler, storage, calls }) => {
    assert.equal(await handler.handle(callback(1, 'refresh:sig-callback')), 'handled');
    assert.equal(await handler.handle(callback(1, 'refresh:sig-callback')), 'duplicate');
    assert.equal(await handler.handle(callback(2, 'refresh:sig-callback')), 'handled');
    assert.deepEqual(calls, [
      'refresh-work',
      'answerCallbackQuery',
      'answerCallbackQuery',
      'refresh-work',
      'answerCallbackQuery'
    ]);
    assert.equal(
      (
        storage.db.prepare('SELECT COUNT(*) AS count FROM telegram_updates').get() as {
          count: number;
        }
      ).count,
      2
    );
  });
});

void test('rejects unauthorized and unassociated callbacks without state changes', async () => {
  await withHandler(async ({ handler, storage, calls }) => {
    assert.equal(await handler.handle(callback(2, 'stop:sig-callback', 99)), 'unauthorized');
    assert.equal(
      await handler.handle(callback(3, 'stop:sig-callback', 7, -100, 99)),
      'unassociated'
    );
    assert.deepEqual(calls, ['answerCallbackQuery', 'answerCallbackQuery']);
    assert.equal(
      (
        storage.db.prepare('SELECT COUNT(*) AS count FROM telegram_updates').get() as {
          count: number;
        }
      ).count,
      2
    );
    assert.equal(
      (
        storage.db.prepare('SELECT COUNT(*) AS count FROM signal_actions').get() as {
          count: number;
        }
      ).count,
      0
    );
  });
});

void test('durably consumes unsupported callbacks so long polling cannot replay them', async () => {
  await withHandler(async ({ handler, storage, calls }) => {
    assert.equal(await handler.handle(callback(9, 'unknown:sig-callback')), 'ignored');
    assert.deepEqual(calls, ['answerCallbackQuery']);
    assert.equal(await storage.lastTelegramUpdateId(), 9);
  });
});

void test('persists bought/stop annotations and deletes only the Telegram message', async () => {
  await withHandler(async ({ handler, storage, calls }) => {
    assert.equal(await handler.handle(callback(4, 'bought:sig-callback')), 'handled');
    assert.equal(await handler.handle(callback(5, 'stop:sig-callback')), 'handled');
    assert.equal(await handler.handle(callback(6, 'delete:sig-callback')), 'handled');
    assert.deepEqual(calls, [
      'bought-note',
      'answerCallbackQuery',
      'answerCallbackQuery',
      'deleteMessage',
      'answerCallbackQuery'
    ]);
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT telegram_tracking_stopped AS stopped, telegram_deleted AS deleted FROM signals'
        )
        .get(),
      { stopped: 1, deleted: 1 }
    );
    assert.equal(
      (storage.db.prepare('SELECT COUNT(*) AS count FROM price_samples').get() as { count: number })
        .count,
      0
    );
  });
});

void test('does not stop message tracking when Telegram rejects deletion', async () => {
  await withHandler(async ({ storage }) => {
    const telegram = new TelegramClient({
      botToken: 'token',
      transport: (method) =>
        Promise.resolve({
          status: 200,
          body: { ok: true, result: method === 'deleteMessage' ? false : true }
        })
    });
    const handler = new TelegramCallbackHandler({
      storage,
      telegram,
      allowedChatIds: ['-100'],
      allowedUserIds: ['7'],
      now: () => 1_000
    });
    await assert.rejects(handler.handle(callback(7, 'delete:sig-callback')), /not true/);
    assert.deepEqual(storage.db.prepare('SELECT telegram_deleted AS deleted FROM signals').get(), {
      deleted: 0
    });
    assert.equal(
      (
        storage.db
          .prepare("SELECT COUNT(*) AS count FROM signal_actions WHERE action = 'delete'")
          .get() as { count: number }
      ).count,
      0
    );
  });
});

void test('returns the contract for copy and lets failed actions be retried', async () => {
  await withHandler(async ({ handler, calls }) => {
    assert.equal(await handler.handle(callback(8, 'copy:sig-callback')), 'handled');
    assert.deepEqual(calls, ['answerCallbackQuery']);
  });
});

void test('long polling resumes after the persisted Telegram update offset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-long-poll-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  const bodies: Array<Record<string, unknown>> = [];
  try {
    const telegram = new TelegramClient({
      botToken: 'token',
      transport: (method, body) => {
        bodies.push({ method, ...body });
        return Promise.resolve({ status: 200, body: { ok: true, result: [] } });
      }
    });
    const handler = new TelegramCallbackHandler({
      storage,
      telegram,
      allowedChatIds: [],
      allowedUserIds: []
    });
    storage.db.prepare('INSERT INTO telegram_updates VALUES (?, ?)').run(123, 1);
    const poller = new TelegramLongPoller({ storage, telegram, handler, timeoutSeconds: 20 });
    assert.equal(await poller.pollOnce(), 0);
    assert.deepEqual(bodies, [
      { method: 'getUpdates', offset: 124, timeout: 20, allowed_updates: ['callback_query'] }
    ]);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
