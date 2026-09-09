import { Agent, type RequestOptions, request } from 'node:https';
import { URL } from 'node:url';

export interface TelegramHttpResponse {
  status: number;
  body: unknown;
}

export type TelegramTransport = (
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number
) => Promise<TelegramHttpResponse>;

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

export interface InputRichMessage {
  html: string;
  skip_entity_detection?: boolean;
}

export interface TelegramMessage {
  messageId: number;
  chatId: string | number;
}

export interface TelegramCallbackUpdate {
  updateId: number;
  callbackQuery: {
    id: string;
    fromUserId: string | number;
    chatId: string | number;
    messageId: number;
    data: string;
  };
}

export class TelegramError extends Error {
  constructor(
    readonly kind: 'network' | 'timeout' | 'http' | 'api' | 'schema' | 'rate_limit',
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

/**
 * Small, framework-free Telegram Bot API adapter.  The injectable transport exists
 * only for deterministic tests; production calls use Node's native HTTPS client.
 */
export class TelegramClient {
  readonly #transport: TelegramTransport;

  constructor(
    private readonly options: {
      botToken: string;
      baseUrl?: string;
      timeoutMs?: number;
      transport?: TelegramTransport;
    }
  ) {
    this.#transport =
      options.transport ??
      nodeHttpsTransport(options.baseUrl ?? 'https://api.telegram.org', options.botToken);
  }

  async sendMessage(input: {
    chatId: string | number;
    text: string;
    replyMarkup?: InlineKeyboardMarkup;
    disableWebPagePreview?: boolean;
  }): Promise<TelegramMessage> {
    const result = await this.call('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      ...(input.replyMarkup === undefined ? {} : { reply_markup: input.replyMarkup }),
      ...(input.disableWebPagePreview === undefined
        ? {}
        : { link_preview_options: { is_disabled: input.disableWebPagePreview } })
    });
    return parseMessage(result);
  }

  async sendRichMessage(input: {
    chatId: string | number;
    richMessage: InputRichMessage;
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<TelegramMessage> {
    const result = await this.call('sendRichMessage', {
      chat_id: input.chatId,
      rich_message: input.richMessage,
      ...(input.replyMarkup === undefined ? {} : { reply_markup: input.replyMarkup })
    });
    return parseMessage(result);
  }

  async editMessageText(input: {
    chatId: string | number;
    messageId: number;
    text?: string;
    richMessage?: InputRichMessage;
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<TelegramMessage> {
    if ((input.text === undefined) === (input.richMessage === undefined))
      throw new TelegramError('schema', 'Telegram edit requires exactly one message content field');
    const result = await this.call('editMessageText', {
      chat_id: input.chatId,
      message_id: input.messageId,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.richMessage === undefined ? {} : { rich_message: input.richMessage }),
      ...(input.replyMarkup === undefined ? {} : { reply_markup: input.replyMarkup })
    });
    return parseMessage(result);
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    const result = await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    if (result !== true)
      throw new TelegramError('schema', 'Telegram deleteMessage result was not true');
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const result = await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text })
    });
    if (result !== true)
      throw new TelegramError('schema', 'Telegram answerCallbackQuery result was not true');
  }

  async getUpdates(input?: {
    offset?: number;
    timeoutSeconds?: number;
    allowedUpdates?: string[];
  }): Promise<TelegramCallbackUpdate[]> {
    const timeoutSeconds = input?.timeoutSeconds ?? 30;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50)
      throw new TelegramError(
        'schema',
        'Telegram long-poll timeout must be an integer from 0 to 50'
      );
    const result = await this.call(
      'getUpdates',
      {
        ...(input?.offset === undefined ? {} : { offset: input.offset }),
        timeout: timeoutSeconds,
        ...(input?.allowedUpdates === undefined
          ? { allowed_updates: ['callback_query'] }
          : { allowed_updates: input.allowedUpdates })
      },
      (timeoutSeconds + 10) * 1_000
    );
    if (!Array.isArray(result))
      throw new TelegramError('schema', 'Telegram getUpdates result was not an array');
    return result
      .map(parseCallbackUpdate)
      .filter((update): update is TelegramCallbackUpdate => update !== null);
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    let response: TelegramHttpResponse;
    try {
      response = await this.#transport(method, body, timeoutMs ?? this.options.timeoutMs ?? 8_000);
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(
        'network',
        redactTelegram(
          error instanceof Error ? error.message : String(error),
          this.options.botToken
        )
      );
    }
    if (response.status === 429)
      throw new TelegramError(
        'rate_limit',
        telegramApiDescription(response.body, this.options.botToken),
        response.status,
        telegramRetryAfterMs(response.body)
      );
    if (response.status < 200 || response.status >= 300)
      throw new TelegramError('http', `Telegram returned HTTP ${response.status}`, response.status);
    if (!isRecord(response.body) || typeof response.body.ok !== 'boolean')
      throw new TelegramError('schema', 'Telegram response did not contain a boolean ok field');
    if (!response.body.ok) {
      const description =
        typeof response.body.description === 'string' ? response.body.description : 'unknown error';
      if (response.body.error_code === 429)
        throw new TelegramError(
          'rate_limit',
          redactTelegram(`Telegram API rejected ${method}: ${description}`, this.options.botToken),
          429,
          telegramRetryAfterMs(response.body)
        );
      throw new TelegramError(
        'api',
        redactTelegram(`Telegram API rejected ${method}: ${description}`, this.options.botToken),
        typeof response.body.error_code === 'number' ? response.body.error_code : undefined
      );
    }
    if (!('result' in response.body))
      throw new TelegramError('schema', 'Telegram successful response did not contain result');
    return response.body.result;
  }
}

function telegramApiDescription(value: unknown, botToken: string): string {
  const description =
    isRecord(value) && typeof value.description === 'string'
      ? value.description
      : 'Telegram rate limit exceeded';
  return redactTelegram(description, botToken);
}

function telegramRetryAfterMs(value: unknown): number | undefined {
  const parameters = isRecord(value) ? value.parameters : undefined;
  const retryAfter = isRecord(parameters) ? Number(parameters.retry_after) : Number.NaN;
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1_000) : undefined;
}

export function redactTelegram(value: string, botToken: string): string {
  return value.replaceAll(botToken, '[REDACTED]');
}

function parseMessage(value: unknown): TelegramMessage {
  if (!isRecord(value) || !Number.isInteger(value.message_id) || !isRecord(value.chat))
    throw new TelegramError('schema', 'Telegram message result was malformed');
  const messageId = value.message_id;
  if (typeof messageId !== 'number')
    throw new TelegramError('schema', 'Telegram message id was malformed');
  const chatId = value.chat.id;
  if (typeof chatId !== 'number' && typeof chatId !== 'string')
    throw new TelegramError('schema', 'Telegram message chat id was malformed');
  return { messageId, chatId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCallbackUpdate(value: unknown): TelegramCallbackUpdate | null {
  if (!isRecord(value) || !Number.isInteger(value.update_id))
    throw new TelegramError('schema', 'Telegram update result was malformed');
  if (!isRecord(value.callback_query)) return null;
  const query = value.callback_query;
  if (!isRecord(query.from) || !isRecord(query.message) || !isRecord(query.message.chat))
    throw new TelegramError('schema', 'Telegram callback query was malformed');
  const queryId = query.id;
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const updateId = value.update_id;
  if (
    typeof queryId !== 'string' ||
    (typeof userId !== 'string' && typeof userId !== 'number') ||
    (typeof chatId !== 'string' && typeof chatId !== 'number') ||
    !Number.isInteger(messageId) ||
    typeof messageId !== 'number' ||
    typeof data !== 'string' ||
    typeof updateId !== 'number'
  )
    throw new TelegramError('schema', 'Telegram callback query fields were malformed');
  return { updateId, callbackQuery: { id: queryId, fromUserId: userId, chatId, messageId, data } };
}

function nodeHttpsTransport(baseUrl: string, botToken: string): TelegramTransport {
  const origin = new URL(baseUrl);
  const agent = new Agent({ keepAlive: true, family: 4 });
  return async (method, body, timeoutMs) => {
    const target = new URL(`/bot${botToken}/${method}`, origin);
    const payload = JSON.stringify(body);
    const options: RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: 'POST',
      path: target.pathname,
      family: 4,
      agent,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'user-agent': 'gmgn-signal-bot/0.1'
      }
    };
    return new Promise((resolve, reject) => {
      const req = request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: text.length === 0 ? null : JSON.parse(text)
            });
          } catch {
            reject(new TelegramError('schema', 'Telegram response was not valid JSON'));
          }
        });
      });
      req.setTimeout(timeoutMs, () =>
        req.destroy(new TelegramError('timeout', 'Telegram request timed out'))
      );
      req.on('error', (error) => reject(error));
      req.write(payload);
      req.end();
    });
  };
}
