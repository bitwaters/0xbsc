import type { Clock, GmgnScheduler, Priority } from '../gmgn/scheduler.js';

export interface PollerOptions {
  key: string;
  weight: number;
  priority?: Priority;
  intervalMs: number;
  maxBackoffMs: number;
  jitterPercent?: number;
}

export interface PollOutcome<T> {
  status: 'success' | 'failed' | 'skipped';
  value?: T;
  error?: Error;
  consecutiveFailures: number;
  nextDueAtMs: number;
}

export class IsolatedPoller<T> {
  #consecutiveFailures = 0;
  #nextDueAtMs = 0;
  constructor(
    private readonly scheduler: GmgnScheduler,
    private readonly clock: Clock,
    private readonly options: PollerOptions
  ) {}

  async tick(operation: () => Promise<T>): Promise<PollOutcome<T>> {
    const now = this.clock.now();
    if (now < this.#nextDueAtMs)
      return this.outcome('skipped', undefined, undefined, this.#consecutiveFailures);
    try {
      const value = await this.scheduler.runLogical({
        key: this.options.key,
        weight: this.options.weight,
        priority: this.options.priority ?? 'discovery',
        deadlineMs: now + this.options.intervalMs,
        ...(this.options.jitterPercent === undefined
          ? {}
          : { jitterPercent: this.options.jitterPercent }),
        run: operation
      });
      this.#consecutiveFailures = 0;
      this.#nextDueAtMs = this.clock.now() + this.options.intervalMs;
      return this.outcome('success', value);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('unknown poller failure');
      if (error.message.startsWith('poller already running:'))
        return this.outcome('skipped', undefined, undefined, this.#consecutiveFailures);
      this.#consecutiveFailures += 1;
      const backoff = Math.min(
        this.options.maxBackoffMs,
        this.options.intervalMs * 2 ** (this.#consecutiveFailures - 1)
      );
      this.#nextDueAtMs = this.clock.now() + backoff;
      return this.outcome('failed', undefined, error);
    }
  }

  private outcome(
    status: PollOutcome<T>['status'],
    value?: T,
    error?: Error,
    failures = this.#consecutiveFailures
  ): PollOutcome<T> {
    return {
      status,
      ...(value === undefined ? {} : { value }),
      ...(error ? { error } : {}),
      consecutiveFailures: failures,
      nextDueAtMs: this.#nextDueAtMs
    };
  }
}
