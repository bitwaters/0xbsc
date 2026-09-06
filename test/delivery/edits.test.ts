import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TelegramEditService } from '../../src/delivery/edits.js';
import { TelegramClient } from '../../src/delivery/telegram.js';
import { Storage } from '../../src/storage/database.js';

async function withEditService(
  run: (storage: Storage, edits: TelegramEditService, calls: string[]) => Promise<void>,
  prepareBeforeEdit?: ConstructorParameters<typeof TelegramEditService>[0]['prepareBeforeEdit']
) {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-edits-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  const calls: string[] = [];
  try {
    const now = 1_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xedit', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-edit', 'bsc', '0xedit', 'revival', 'SENT', 'cfg', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, telegram_chat_id, telegram_message_id, telegram_confirmed_at_ms, created_at_ms, updated_at_ms) VALUES ('sig-edit', 'ep-edit', 'cfg', 'SENT', '{}', '{}', '-100', '12', ?, ?, ?)"
      )
      .run(now, now, now);
    const telegram = new TelegramClient({
      botToken: 'token',
      transport: (method) => {
        calls.push(method);
        return Promise.resolve({
          status: 200,
          body: { ok: true, result: { message_id: 12, chat: { id: '-100' } } }
        });
      }
    });
    const edits = new TelegramEditService({
      storage,
      telegram,
      render: (edit) => ({ text: `${edit.signalId}:${edit.taskKind}` }),
      ...(prepareBeforeEdit === undefined ? {} : { prepareBeforeEdit }),
      now: () => now
    });
    await run(storage, edits, calls);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void test('persists default and narrative message-edit checkpoints then completes due edits', async () => {
  await withEditService(async (storage, edits, calls) => {
    await edits.scheduleAfterConfirmation({
      episodeId: 'ep-edit',
      signalId: 'sig-edit',
      confirmedAtMs: 1_000,
      narrative: true
    });
    assert.equal(
      (
        storage.db
          .prepare(
            "SELECT COUNT(*) AS count FROM price_samples WHERE task_kind LIKE 'telegram_edit_%'"
          )
          .get() as { count: number }
      ).count,
      7
    );
    assert.equal(await edits.runDue(61_000), 1);
    assert.deepEqual(calls, ['editMessageText']);
    assert.deepEqual(
      storage.db
        .prepare('SELECT status FROM price_samples WHERE task_kind = ?')
        .get('telegram_edit_1m'),
      { status: 'COMPLETE' }
    );
  });
});

void test('refreshes edit data before rendering a scheduled update', async () => {
  let prepared = false;
  await withEditService(
    async (storage, edits) => {
      await edits.scheduleAfterConfirmation({
        episodeId: 'ep-edit',
        signalId: 'sig-edit',
        confirmedAtMs: 1_000,
        narrative: false
      });
      assert.equal(await edits.runDue(61_000), 1);
      assert.equal(prepared, true);
    },
    (edit) => {
      prepared = true;
      return Promise.resolve({ ...edit, decision: { presentation: { priceUsd: '2' } } });
    }
  );
});

void test('queues immediate material edits but never edits stopped or deleted messages', async () => {
  await withEditService(async (storage, edits, calls) => {
    await edits.notifyMaterialChange({
      episodeId: 'ep-edit',
      signalId: 'sig-edit',
      reason: 'risk'
    });
    assert.equal(await edits.runDue(1_000), 1);
    assert.deepEqual(calls, ['editMessageText']);
    await edits.notifyMaterialChange({
      episodeId: 'ep-edit',
      signalId: 'sig-edit',
      reason: 'quote'
    });
    storage.db.prepare('UPDATE signals SET telegram_tracking_stopped = 1').run();
    assert.equal(await edits.runDue(1_000), 0);
    storage.db
      .prepare('UPDATE signals SET telegram_tracking_stopped = 0, telegram_deleted = 1')
      .run();
    assert.equal(await edits.runDue(1_000), 0);
  });
});

void test('treats Telegram message-not-modified as an idempotent edit success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-edit-conflict-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    const now = 1_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xconflict', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-conflict', 'bsc', '0xconflict', 'revival', 'SENT', 'cfg', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, telegram_chat_id, telegram_message_id, created_at_ms, updated_at_ms) VALUES ('sig-conflict', 'ep-conflict', 'cfg', 'SENT', '{}', '{}', '-100', '12', ?, ?)"
      )
      .run(now, now);
    await storage.scheduleImmediateTelegramEdit({
      episodeId: 'ep-conflict',
      signalId: 'sig-conflict',
      reason: 'risk',
      nowMs: now
    });
    const telegram = new TelegramClient({
      botToken: 'token',
      transport: () =>
        Promise.resolve({
          status: 200,
          body: { ok: false, description: 'message is not modified' }
        })
    });
    const edits = new TelegramEditService({
      storage,
      telegram,
      render: () => ({ text: 'updated' })
    });
    assert.equal(await edits.runDue(now), 1);
    assert.deepEqual(
      storage.db
        .prepare(
          "SELECT status FROM price_samples WHERE task_kind = 'telegram_edit_immediate_risk'"
        )
        .get(),
      { status: 'COMPLETE' }
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
