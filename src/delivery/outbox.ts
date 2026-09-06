import type { PendingOutboxSignal, Storage } from '../storage/database.js';
import type { InlineKeyboardMarkup, InputRichMessage, TelegramClient } from './telegram.js';
import { TelegramError } from './telegram.js';

export interface DeliveryPayload {
  text?: string;
  richMessage?: InputRichMessage;
  replyMarkup?: InlineKeyboardMarkup;
}

export class OutboxDeliveryService {
  constructor(
    private readonly options: {
      storage: Storage;
      telegram: TelegramClient;
      chatId: string | number;
      render: (signal: PendingOutboxSignal) => DeliveryPayload;
      prepareBeforeDelivery?: (signal: PendingOutboxSignal) => Promise<PendingOutboxSignal | null>;
      preparationRetryAt?: (error: unknown, nowMs: number) => number | null;
      revalidateBeforeUnknownRetry: (signal: PendingOutboxSignal) => Promise<boolean>;
      onConfirmed?: (signal: PendingOutboxSignal, confirmedAtMs: number) => Promise<void>;
      onConfirmedError?: (signal: PendingOutboxSignal, error: unknown) => void | Promise<void>;
      outcomeCheckpointsMinutes?: readonly number[];
      narrativeOutcomeCheckpointsMinutes?: readonly number[];
      onTrace?: (
        signal: PendingOutboxSignal,
        stage: 'telegram_request' | 'telegram_confirmation',
        occurredAtMs: number
      ) => Promise<void>;
      now?: () => number;
    }
  ) {}

  async recoverAndDeliver(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    for (const signal of await this.options.storage.pendingOutboxSignals(now))
      await this.deliver(signal);
  }

  async deliver(
    signal: PendingOutboxSignal
  ): Promise<'sent' | 'unknown' | 'failed' | 'skipped' | 'deferred'> {
    const now = this.options.now?.() ?? Date.now();
    if (signal.deliveryState === 'DELIVERY_UNKNOWN') {
      if (!(await this.options.revalidateBeforeUnknownRetry(signal))) {
        await this.options.storage.recordDeliveryFailure(
          signal.id,
          'stale_or_unsafe_before_retry',
          now
        );
        return 'failed';
      }
      if (!(await this.options.storage.claimUnknownDeliveryRetry(signal.id, now))) return 'skipped';
    }
    let preparedSignal = signal;
    try {
      if (this.options.prepareBeforeDelivery) {
        const prepared = await this.options.prepareBeforeDelivery(signal);
        if (!prepared) return 'skipped';
        preparedSignal = prepared;
      }
    } catch (error) {
      const failedAtMs = this.options.now?.() ?? Date.now();
      const retryAtMs = this.options.preparationRetryAt?.(error, failedAtMs) ?? null;
      if (retryAtMs !== null) {
        await this.options.storage.deferRateLimitedDelivery(
          signal.id,
          `preparation_failed: ${deliveryErrorText(error)}`,
          retryAtMs,
          failedAtMs
        );
        return 'deferred';
      }
      await this.options.storage.recordDeliveryFailure(
        signal.id,
        `preparation_failed: ${deliveryErrorText(error)}`,
        failedAtMs,
        'preparation_failed'
      );
      return 'failed';
    }
    const payload = this.options.render(preparedSignal);
    try {
      const requestAtMs = this.options.now?.() ?? Date.now();
      await this.options.onTrace?.(preparedSignal, 'telegram_request', requestAtMs);
      if ((payload.text === undefined) === (payload.richMessage === undefined))
        throw new TelegramError(
          'schema',
          'delivery payload requires exactly one message content field'
        );
      const message =
        payload.richMessage === undefined
          ? await this.options.telegram.sendMessage({
              chatId: this.options.chatId,
              text: payload.text!,
              ...(payload.replyMarkup === undefined ? {} : { replyMarkup: payload.replyMarkup })
            })
          : await this.options.telegram.sendRichMessage({
              chatId: this.options.chatId,
              richMessage: payload.richMessage,
              ...(payload.replyMarkup === undefined ? {} : { replyMarkup: payload.replyMarkup })
            });
      const confirmedAtMs = this.options.now?.() ?? Date.now();
      const confirmed = await this.options.storage.confirmTelegramDelivery({
        signalId: signal.id,
        chatId: message.chatId,
        messageId: message.messageId,
        nowMs: confirmedAtMs,
        narrative: hasNarrativeEvidence(preparedSignal.decision),
        ...(this.options.outcomeCheckpointsMinutes === undefined
          ? {}
          : { outcomeCheckpointsMinutes: this.options.outcomeCheckpointsMinutes }),
        ...(this.options.narrativeOutcomeCheckpointsMinutes === undefined
          ? {}
          : {
              narrativeOutcomeCheckpointsMinutes: this.options.narrativeOutcomeCheckpointsMinutes
            })
      });
      if (confirmed) {
        await this.options.onTrace?.(preparedSignal, 'telegram_confirmation', confirmedAtMs);
        const onConfirmed = this.options.onConfirmed;
        if (onConfirmed)
          void onConfirmed(preparedSignal, confirmedAtMs).catch((error: unknown) =>
            this.options.onConfirmedError?.(preparedSignal, error)
          );
        return 'sent';
      }
      return 'skipped';
    } catch (error) {
      const failedAtMs = this.options.now?.() ?? Date.now();
      const classified = classifyDeliveryError(error);
      if (classified === 'rate_limit') {
        const retryAfterMs =
          error instanceof TelegramError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : 30_000;
        await this.options.storage.deferRateLimitedDelivery(
          signal.id,
          deliveryErrorText(error),
          failedAtMs + retryAfterMs,
          failedAtMs
        );
        return 'deferred';
      }
      if (classified === 'unknown') {
        await this.options.storage.recordDeliveryUnknown(
          signal.id,
          deliveryErrorText(error),
          failedAtMs
        );
        return 'unknown';
      }
      await this.options.storage.recordDeliveryFailure(
        signal.id,
        deliveryErrorText(error),
        failedAtMs
      );
      return 'failed';
    }
  }
}

function classifyDeliveryError(error: unknown): 'unknown' | 'failed' | 'rate_limit' {
  if (!(error instanceof TelegramError)) return 'unknown';
  if (error.kind === 'rate_limit') return 'rate_limit';
  if (error.kind === 'http' && error.status === 429) return 'rate_limit';
  if (error.kind === 'network' || error.kind === 'timeout') return 'unknown';
  if (error.kind === 'http' && (error.status === undefined || error.status >= 500))
    return 'unknown';
  return 'failed';
}

function deliveryErrorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'unknown delivery error';
}

function hasNarrativeEvidence(decision: unknown): boolean {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return false;
  const evidence = (decision as Record<string, unknown>).evidence;
  return (
    Array.isArray(evidence) &&
    evidence.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).narrative === true
    )
  );
}
