import type { Storage } from '../storage/database.js';
import type { TelegramCallbackUpdate } from './telegram.js';
import type { TelegramClient } from './telegram.js';

type CallbackAction = 'copy' | 'refresh' | 'bought' | 'stop' | 'delete';

export class TelegramCallbackHandler {
  constructor(
    private readonly options: {
      storage: Storage;
      telegram: TelegramClient;
      allowedChatIds: readonly string[];
      allowedUserIds: readonly string[];
      now?: () => number;
      onRefresh?: (signalId: string) => Promise<void>;
      onBought?: (signalId: string, userId: string) => Promise<void>;
    }
  ) {}

  async handle(
    update: TelegramCallbackUpdate
  ): Promise<'handled' | 'unauthorized' | 'ignored' | 'unassociated' | 'duplicate'> {
    const { callbackQuery } = update;
    const chatId = String(callbackQuery.chatId);
    const userId = String(callbackQuery.fromUserId);
    const nowMs = this.options.now?.() ?? Date.now();
    if (
      !this.options.allowedChatIds.includes(chatId) ||
      !this.options.allowedUserIds.includes(userId)
    ) {
      await this.options.storage.recordIgnoredTelegramUpdate(update.updateId, nowMs);
      await this.options.telegram.answerCallbackQuery(callbackQuery.id, 'Unauthorized');
      return 'unauthorized';
    }
    const parsed = parseCallbackData(callbackQuery.data);
    if (!parsed) {
      await this.options.storage.recordIgnoredTelegramUpdate(update.updateId, nowMs);
      await this.options.telegram.answerCallbackQuery(callbackQuery.id, 'Unsupported action');
      return 'ignored';
    }
    const status = await this.options.storage.claimTelegramCallback({
      updateId: update.updateId,
      signalId: parsed.signalId,
      chatId,
      messageId: callbackQuery.messageId,
      action: parsed.action,
      userId,
      nowMs
    });
    if (status === 'unassociated_message') {
      await this.options.telegram.answerCallbackQuery(callbackQuery.id, 'Signal message mismatch');
      return 'unassociated';
    }
    if (status === 'duplicate_update' || status === 'duplicate_action') {
      await this.options.telegram.answerCallbackQuery(callbackQuery.id, 'Already handled');
      return 'duplicate';
    }
    try {
      if (parsed.action === 'copy') {
        const tokenAddress = await this.options.storage.tokenAddressForSignal(parsed.signalId);
        if (!tokenAddress) throw new Error('Signal token address is unavailable');
        await this.options.telegram.answerCallbackQuery(callbackQuery.id, tokenAddress);
        return 'handled';
      }
      if (parsed.action === 'refresh') await this.options.onRefresh?.(parsed.signalId);
      if (parsed.action === 'bought') await this.options.onBought?.(parsed.signalId, userId);
      if (parsed.action === 'delete') {
        await this.options.telegram.deleteMessage(callbackQuery.chatId, callbackQuery.messageId);
        await this.options.storage.markTelegramMessageDeleted(
          parsed.signalId,
          this.options.now?.() ?? Date.now()
        );
      }
      await this.options.telegram.answerCallbackQuery(callbackQuery.id, 'Done');
      return 'handled';
    } catch (error) {
      await this.options.storage.releaseTelegramCallbackAction(
        parsed.signalId,
        parsed.action,
        userId
      );
      throw error;
    }
  }
}

/** One bounded long-poll iteration. The caller owns process lifecycle and backoff. */
export class TelegramLongPoller {
  constructor(
    private readonly options: {
      storage: Storage;
      telegram: TelegramClient;
      handler: TelegramCallbackHandler;
      timeoutSeconds?: number;
    }
  ) {}

  async pollOnce(): Promise<number> {
    const latest = await this.options.storage.lastTelegramUpdateId();
    const updates = await this.options.telegram.getUpdates({
      ...(latest === null ? {} : { offset: latest + 1 }),
      timeoutSeconds: this.options.timeoutSeconds ?? 30,
      allowedUpdates: ['callback_query']
    });
    for (const update of updates) await this.options.handler.handle(update);
    return updates.length;
  }
}

function parseCallbackData(value: string): { action: CallbackAction; signalId: string } | null {
  const divider = value.indexOf(':');
  if (divider <= 0 || divider === value.length - 1 || value.indexOf(':', divider + 1) !== -1)
    return null;
  const action = value.slice(0, divider);
  if (!['copy', 'refresh', 'bought', 'stop', 'delete'].includes(action)) return null;
  return { action: action as CallbackAction, signalId: value.slice(divider + 1) };
}
