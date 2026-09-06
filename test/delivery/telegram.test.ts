import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramClient, TelegramError } from '../../src/delivery/telegram.js';

const token = '123456:secret-token';

function clientWith(response: unknown, status = 200) {
  const calls: Array<{ method: string; body: Record<string, unknown>; timeoutMs: number }> = [];
  const client = new TelegramClient({
    botToken: token,
    timeoutMs: 321,
    transport: (method, body, timeoutMs) => {
      calls.push({ method, body, timeoutMs });
      return Promise.resolve({ status, body: response });
    }
  });
  return { client, calls };
}

void test('sends and edits messages with validated Telegram responses', async () => {
  const sent = clientWith({ ok: true, result: { message_id: 12, chat: { id: -100 } } });
  assert.deepEqual(await sent.client.sendMessage({ chatId: -100, text: 'hello' }), {
    messageId: 12,
    chatId: -100
  });
  assert.deepEqual(sent.calls, [
    { method: 'sendMessage', body: { chat_id: -100, text: 'hello' }, timeoutMs: 321 }
  ]);

  const edited = clientWith({ ok: true, result: { message_id: 12, chat: { id: '-100' } } });
  assert.deepEqual(
    await edited.client.editMessageText({ chatId: -100, messageId: 12, text: 'updated' }),
    {
      messageId: 12,
      chatId: '-100'
    }
  );
  assert.equal(edited.calls[0]?.method, 'editMessageText');
  assert.deepEqual(edited.calls[0]?.body, { chat_id: -100, message_id: 12, text: 'updated' });

  const rich = clientWith({ ok: true, result: { message_id: 13, chat: { id: -100 } } });
  await rich.client.sendRichMessage({
    chatId: -100,
    richMessage: { html: '<p>CA</p>', skip_entity_detection: true }
  });
  assert.deepEqual(rich.calls[0], {
    method: 'sendRichMessage',
    body: {
      chat_id: -100,
      rich_message: { html: '<p>CA</p>', skip_entity_detection: true }
    },
    timeoutMs: 321
  });
});

void test('edits rich messages and rejects ambiguous edit content', async () => {
  const edited = clientWith({ ok: true, result: { message_id: 12, chat: { id: -100 } } });
  await edited.client.editMessageText({
    chatId: -100,
    messageId: 12,
    richMessage: { html: '<p>updated</p>' }
  });
  assert.deepEqual(edited.calls[0]?.body, {
    chat_id: -100,
    message_id: 12,
    rich_message: { html: '<p>updated</p>' }
  });
  await assert.rejects(
    edited.client.editMessageText({ chatId: -100, messageId: 12 }),
    /exactly one/
  );
  await assert.rejects(
    edited.client.editMessageText({
      chatId: -100,
      messageId: 12,
      text: 'plain',
      richMessage: { html: '<p>rich</p>' }
    }),
    /exactly one/
  );
});

void test('deletes messages and acknowledges callbacks only on true result', async () => {
  const ok = clientWith({ ok: true, result: true });
  await ok.client.deleteMessage(-100, 9);
  await ok.client.answerCallbackQuery('callback-1', 'Done');
  assert.deepEqual(
    ok.calls.map((call) => [call.method, call.body]),
    [
      ['deleteMessage', { chat_id: -100, message_id: 9 }],
      ['answerCallbackQuery', { callback_query_id: 'callback-1', text: 'Done' }]
    ]
  );
  const malformed = clientWith({ ok: true, result: false });
  await assert.rejects(malformed.client.deleteMessage(-100, 9), /not true/);
});

void test('rejects HTTP, API and malformed responses without leaking the bot token', async () => {
  const http = clientWith({}, 502);
  await assert.rejects(http.client.sendMessage({ chatId: 1, text: 'x' }), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.kind, 'http');
    return true;
  });
  const api = clientWith({ ok: false, description: `bad token ${token}` });
  await assert.rejects(api.client.sendMessage({ chatId: 1, text: 'x' }), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.kind, 'api');
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
  const schema = clientWith({ ok: true, result: { message_id: '12', chat: { id: 1 } } });
  await assert.rejects(schema.client.sendMessage({ chatId: 1, text: 'x' }), /malformed/);
});

void test('parses Telegram rate-limit retry timing from HTTP and API responses', async () => {
  for (const [status, body] of [
    [429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 12 } }],
    [
      200,
      { ok: false, error_code: 429, description: 'Retry later', parameters: { retry_after: 7 } }
    ]
  ] as const) {
    const limited = clientWith(body, status);
    await assert.rejects(limited.client.sendMessage({ chatId: 1, text: 'x' }), (error: unknown) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.kind, 'rate_limit');
      assert.equal(error.retryAfterMs, status === 429 ? 12_000 : 7_000);
      return true;
    });
  }
});

void test('classifies transport failures and preserves native timeout errors', async () => {
  const network = new TelegramClient({
    botToken: token,
    transport: () => Promise.reject(new Error(`failed ${token}`))
  });
  await assert.rejects(network.sendMessage({ chatId: 1, text: 'x' }), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.kind, 'network');
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
  const timeout = new TelegramClient({
    botToken: token,
    transport: () => Promise.reject(new TelegramError('timeout', 'Telegram request timed out'))
  });
  await assert.rejects(timeout.sendMessage({ chatId: 1, text: 'x' }), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.kind, 'timeout');
    return true;
  });
});

void test('parses callback updates and gives a long poll an extended HTTP timeout', async () => {
  const observed: number[] = [];
  const client = new TelegramClient({
    botToken: token,
    transport: (_method, _body, timeoutMs) => {
      observed.push(timeoutMs);
      return Promise.resolve({
        status: 200,
        body: {
          ok: true,
          result: [
            { update_id: 5, message: { ignored: true } },
            {
              update_id: 6,
              callback_query: {
                id: 'cb-1',
                from: { id: 7 },
                message: { message_id: 8, chat: { id: -100 } },
                data: 'refresh:sig-1'
              }
            }
          ]
        }
      });
    }
  });
  assert.deepEqual(await client.getUpdates({ offset: 6, timeoutSeconds: 30 }), [
    {
      updateId: 6,
      callbackQuery: {
        id: 'cb-1',
        fromUserId: 7,
        chatId: -100,
        messageId: 8,
        data: 'refresh:sig-1'
      }
    }
  ]);
  assert.deepEqual(observed, [40_000]);
});
