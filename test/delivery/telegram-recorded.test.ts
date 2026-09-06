import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TelegramClient } from '../../src/delivery/telegram.js';

const fixture = JSON.parse(
  await readFile(
    fileURLToPath(new URL('../fixtures/telegram-recorded-response.json', import.meta.url)),
    'utf8'
  )
) as { ok: boolean };

void test('replays a scrubbed Telegram response through send and edit operations', async () => {
  const methods: string[] = [];
  const client = new TelegramClient({
    botToken: 'recorded-token',
    transport: (method) => {
      methods.push(method);
      return Promise.resolve({ status: 200, body: fixture });
    }
  });
  assert.deepEqual(await client.sendMessage({ chatId: '-100REDACTED', text: 'signal' }), {
    messageId: 42,
    chatId: '-100REDACTED'
  });
  assert.deepEqual(
    await client.editMessageText({ chatId: '-100REDACTED', messageId: 42, text: 'updated' }),
    { messageId: 42, chatId: '-100REDACTED' }
  );
  assert.deepEqual(methods, ['sendMessage', 'editMessageText']);
  assert.equal(JSON.stringify(fixture).includes('recorded-token'), false);
});
