import type { DueTelegramEdit, Storage } from '../storage/database.js';
import type { DeliveryPayload } from './outbox.js';
import { TelegramError, type TelegramClient } from './telegram.js';

export class TelegramEditService {
  #rateLimitedUntilMs = 0;

  constructor(
    private readonly options: {
      storage: Storage;
      telegram: TelegramClient;
      render: (edit: DueTelegramEdit) => DeliveryPayload;
      prepareBeforeEdit?: (edit: DueTelegramEdit) => Promise<DueTelegramEdit>;
      now?: () => number;
      onError?: (edit: DueTelegramEdit, error: unknown) => void | Promise<void>;
    }
  ) {}

  async scheduleAfterConfirmation(input: {
    episodeId: string;
    signalId: string;
    confirmedAtMs: number;
    narrative: boolean;
  }): Promise<void> {
    await this.options.storage.scheduleTelegramEdits(input);
  }

  async notifyMaterialChange(input: {
    episodeId: string;
    signalId: string;
    reason: 'evidence' | 'risk' | 'quote';
  }): Promise<void> {
    await this.options.storage.scheduleImmediateTelegramEdit({
      ...input,
      nowMs: this.options.now?.() ?? Date.now()
    });
  }

  async runDue(nowMs = this.options.now?.() ?? Date.now()): Promise<number> {
    if (nowMs < this.#rateLimitedUntilMs) return 0;
    const due = latestEditPerSignal(await this.options.storage.dueTelegramEdits(nowMs));
    let completed = 0;
    for (const edit of due) {
      try {
        const preparedEdit = (await this.options.prepareBeforeEdit?.(edit)) ?? edit;
        const payload = this.options.render(preparedEdit);
        await this.options.telegram.editMessageText({
          chatId: edit.chatId,
          messageId: edit.messageId,
          ...(payload.text === undefined ? {} : { text: payload.text }),
          ...(payload.richMessage === undefined ? {} : { richMessage: payload.richMessage }),
          ...(payload.replyMarkup === undefined ? {} : { replyMarkup: payload.replyMarkup })
        });
        await this.options.storage.completeDueTelegramEditsForSignal(edit.signalId, nowMs, nowMs);
        completed += 1;
      } catch (error) {
        if (
          error instanceof TelegramError &&
          error.kind === 'api' &&
          error.message.toLowerCase().includes('message is not modified')
        ) {
          await this.options.storage.completeDueTelegramEditsForSignal(edit.signalId, nowMs, nowMs);
          completed += 1;
          continue;
        }
        const retryAfterMs =
          error instanceof TelegramError &&
          error.kind === 'rate_limit' &&
          error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : error instanceof TelegramError && error.kind === 'rate_limit'
              ? 30_000
              : 5_000;
        await this.options.storage.deferTelegramEdit(edit.taskId, nowMs + retryAfterMs, nowMs);
        await this.options.onError?.(edit, error);
        if (error instanceof TelegramError && error.kind === 'rate_limit') {
          this.#rateLimitedUntilMs = nowMs + retryAfterMs;
          break;
        }
      }
    }
    return completed;
  }
}

function latestEditPerSignal(edits: readonly DueTelegramEdit[]): DueTelegramEdit[] {
  const latest = new Map<string, DueTelegramEdit>();
  for (const edit of edits) latest.set(edit.signalId, edit);
  return [...latest.values()];
}
