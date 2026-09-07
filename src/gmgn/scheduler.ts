import { GmgnError } from './errors.js';
import { gmgnContext, withGmgnContext } from './context.js';
import type { LimiterState } from './limiter-state.js';
export type Priority = 'formal' | 'discovery' | 'candidate' | 'observation' | 'evaluation';
const priorityRank: Record<Priority, number> = {
  formal: 0,
  discovery: 1,
  candidate: 2,
  observation: 3,
  evaluation: 4
};

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}
export interface ScheduledTask<T> {
  key?: string;
  weight: number;
  priority: Priority;
  deadlineMs?: number;
  jitterPercent?: number;
  channel?: string;
  run(admission: Admission): Promise<T>;
}

export class WeightedTokenBucket {
  #tokens: number;
  #lastMs: number;
  constructor(
    readonly softPerSecond: number,
    readonly hardPerSecond: number,
    nowMs: number
  ) {
    this.#tokens = hardPerSecond;
    this.#lastMs = nowMs;
  }
  available(nowMs: number): number {
    this.refill(nowMs);
    return this.#tokens;
  }
  waitMs(weight: number, nowMs: number): number {
    this.refill(nowMs);
    return Math.max(0, Math.ceil(((weight - this.#tokens) / this.softPerSecond) * 1_000));
  }
  consume(weight: number, nowMs: number): boolean {
    this.refill(nowMs);
    if (weight > this.#tokens) return false;
    this.#tokens -= weight;
    return true;
  }
  private refill(nowMs: number): void {
    const elapsed = Math.max(0, nowMs - this.#lastMs);
    this.#tokens = Math.min(
      this.hardPerSecond,
      this.#tokens + (elapsed / 1_000) * this.softPerSecond
    );
    this.#lastMs = nowMs;
  }
}

export interface Admission {
  dispatchedAtMs: number;
  queuedAtMs: number;
  weight: number;
  priority: Priority;
  availableWeight: number;
  inFlight: number;
}
interface QueueItem {
  task: ScheduledTask<unknown>;
  queuedAtMs: number;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  jitterApplied: boolean;
}
export interface SchedulerPolicy {
  paced?: boolean;
  maxConcurrent?: number;
  channelIntervalsMs?: Record<string, number>;
  channelCompletionIntervalsMs?: Record<string, number>;
  initialState?: LimiterState;
  persistState?: (state: LimiterState) => void;
}

export class GmgnScheduler {
  readonly bucket: WeightedTokenBucket;
  #queue: QueueItem[] = [];
  #scheduledKeys = new Set<string>();
  #logicalKeys = new Set<string>();
  #channels = new Set<string>();
  #channelNextAtMs: Record<string, number> = {};
  #channelBackoffMs: Record<string, number> = {};
  #draining = false;
  #persistenceError: Error | null = null;
  #inFlight = 0;
  #blockedUntilMs = 0;
  #nextDispatchAtMs = 0;
  #probeRequired = false;
  #generation = 0;
  #recent: Array<{ atMs: number; weight: number }> = [];
  constructor(
    readonly clock: Clock,
    softPerSecond = 14,
    hardPerSecond = 20,
    readonly reserveWeight = 0,
    private readonly policy: SchedulerPolicy = {}
  ) {
    if (
      !Number.isFinite(softPerSecond) ||
      softPerSecond <= 0 ||
      softPerSecond > hardPerSecond ||
      reserveWeight < 0 ||
      reserveWeight >= hardPerSecond
    )
      throw new RangeError('invalid GMGN rate budget');
    this.bucket = new WeightedTokenBucket(softPerSecond, hardPerSecond, clock.now());
    this.#blockedUntilMs = policy.initialState?.blockedUntilMs ?? 0;
    this.#nextDispatchAtMs = policy.initialState?.nextDispatchAtMs ?? 0;
    this.#probeRequired = Boolean(policy.paced);
    this.#channelNextAtMs = { ...policy.initialState?.channelNextAtMs };
    this.#channelBackoffMs = { ...policy.initialState?.channelBackoffMs };
  }
  noteRateLimit(channel: string): void {
    const base = this.policy.channelCompletionIntervalsMs?.[channel];
    if (base === undefined) return;
    this.#channelBackoffMs[channel] = Math.min(
      3000,
      Math.max(base, this.#channelBackoffMs[channel] ?? base) * 2
    );
  }
  private completionGap(channel: string): number {
    return Math.max(
      this.policy.channelCompletionIntervalsMs?.[channel] ?? 0,
      this.#channelBackoffMs[channel] ?? 0
    );
  }
  get cooldownUntilMs(): number {
    return this.#blockedUntilMs;
  }
  snapshot(): Record<string, number | boolean> {
    this.prune();
    return {
      queued: this.#queue.length,
      ...(this.#persistenceError ? { persistenceFailed: true } : {}),
      inFlight: this.#inFlight,
      cooldownUntilMs: this.#blockedUntilMs,
      probeRequired: this.#probeRequired,
      lastSecondWeight: this.#recent.reduce((sum, x) => sum + x.weight, 0),
      ...(this.policy.channelCompletionIntervalsMs?.quote === undefined
        ? {}
        : { quoteCompletionGapMs: this.completionGap('quote') })
    };
  }
  pause(untilMs: number): void {
    this.#blockedUntilMs = Math.max(this.#blockedUntilMs, untilMs);
    this.#probeRequired = true;
    this.#generation++;
    // Set the in-memory barrier before persistence or rejecting waiters.
    const pending = this.#queue.splice(0);
    for (const item of pending) {
      if (item.task.key) this.#scheduledKeys.delete(item.task.key);
      item.reject(this.cooldownError());
    }
    this.persist();
  }
  /** Business scope only: physical requests inside it perform their own admission. */
  async runLogical<T>(task: Omit<ScheduledTask<T>, 'run'> & { run(): Promise<T> }): Promise<T> {
    if (task.key && this.#logicalKeys.has(task.key))
      throw new Error(`poller already running: ${task.key}`);
    if (task.key) this.#logicalKeys.add(task.key);
    try {
      if (task.jitterPercent) {
        const jitter = Math.max(
          0,
          Math.round((this.clock.random() * 2 - 1) * task.jitterPercent * 1000)
        );
        if (jitter) await this.clock.sleep(jitter);
      }
      if (task.deadlineMs !== undefined && this.clock.now() >= task.deadlineMs)
        throw new Error('task deadline expired');
      if (this.clock.now() < this.#blockedUntilMs) throw this.cooldownError();
      return await withGmgnContext(
        {
          priority: gmgnContext().priority ?? task.priority,
          ...(task.deadlineMs === undefined ? {} : { deadlineMs: task.deadlineMs })
        },
        () => task.run()
      );
    } finally {
      if (task.key) this.#logicalKeys.delete(task.key);
    }
  }
  schedule<T>(task: ScheduledTask<T>): Promise<T> {
    if (this.#persistenceError) return Promise.reject(this.#persistenceError);
    if (
      !Number.isFinite(task.weight) ||
      task.weight <= 0 ||
      task.weight > this.bucket.hardPerSecond
    )
      return Promise.reject(new RangeError('task weight exceeds bucket capacity'));
    if (task.priority !== 'formal' && task.weight + this.reserveWeight > this.bucket.hardPerSecond)
      return Promise.reject(new RangeError('task weight exceeds non-formal bucket capacity'));
    if (this.clock.now() < this.#blockedUntilMs) return Promise.reject(this.cooldownError());
    if (task.key && this.#scheduledKeys.has(task.key))
      return Promise.reject(new Error(`poller already running: ${task.key}`));
    if (task.key) this.#scheduledKeys.add(task.key);
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        task,
        resolve,
        reject,
        queuedAtMs: this.clock.now(),
        jitterApplied: false
      });
      this.#queue.sort((a, b) => priorityRank[a.task.priority] - priorityRank[b.task.priority]);
      void this.drain();
    });
  }
  private cooldownError(): GmgnError {
    return new GmgnError('rate_limit', 'GMGN client is cooling down', 429, this.#blockedUntilMs);
  }
  private persist(): void {
    this.policy.persistState?.({
      blockedUntilMs: this.#blockedUntilMs,
      nextDispatchAtMs: this.#nextDispatchAtMs,
      channelNextAtMs: this.#channelNextAtMs,
      ...(Object.keys(this.#channelBackoffMs).length
        ? { channelBackoffMs: this.#channelBackoffMs }
        : {})
    });
  }
  private prune(): void {
    this.#recent = this.#recent.filter((x) => x.atMs > this.clock.now() - 1000);
  }
  private async drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length) {
        if (this.#persistenceError) {
          for (const item of this.#queue.splice(0)) {
            if (item.task.key) this.#scheduledKeys.delete(item.task.key);
            item.reject(this.#persistenceError);
          }
          break;
        }
        const now = this.clock.now();
        // Expire all queued work, including requests behind a busy endpoint channel.
        for (const item of [...this.#queue]) {
          if (item.task.deadlineMs !== undefined && now >= item.task.deadlineMs) {
            this.#queue.splice(this.#queue.indexOf(item), 1);
            if (item.task.key) this.#scheduledKeys.delete(item.task.key);
            item.reject(new Error('task deadline expired'));
          }
        }
        if (now < this.#blockedUntilMs) {
          this.pause(this.#blockedUntilMs);
          break;
        }
        const limit = this.#probeRequired ? 1 : (this.policy.maxConcurrent ?? Infinity);
        if (this.#inFlight >= limit) break;
        const index = this.#queue.findIndex(
          (x) =>
            !x.task.channel ||
            (!this.#channels.has(x.task.channel) &&
              (this.#channelNextAtMs[x.task.channel] ?? 0) <= now)
        );
        if (index < 0) {
          const wake = Math.min(
            ...this.#queue
              .filter((x) => !x.task.channel || !this.#channels.has(x.task.channel))
              .map((x) => this.#channelNextAtMs[x.task.channel!] ?? 0)
          );
          if (Number.isFinite(wake) && wake > now) {
            await this.clock.sleep(Math.min(wake - now, 1000));
            continue;
          }
          break;
        }
        const item = this.#queue[index]!;
        const task = item.task;
        if (!item.jitterApplied) {
          item.jitterApplied = true;
          const jitter = task.jitterPercent
            ? Math.max(0, Math.round((this.clock.random() * 2 - 1) * task.jitterPercent * 1000))
            : 0;
          if (jitter) {
            await this.clock.sleep(jitter);
            continue;
          }
        }
        const admittedWeight =
          task.priority === 'formal' ? task.weight : task.weight + this.reserveWeight;
        let wait = this.bucket.waitMs(admittedWeight, now);
        if (this.policy.paced) {
          this.prune();
          wait = Math.max(wait, this.#nextDispatchAtMs - now);
          let total = this.#recent.reduce((sum, x) => sum + x.weight, 0);
          for (const entry of this.#recent) {
            if (total + task.weight <= this.bucket.hardPerSecond) break;
            wait = Math.max(wait, entry.atMs + 1000 - now);
            total -= entry.weight;
          }
        }
        if (wait > 0) {
          await this.clock.sleep(Math.min(wait, 1000));
          continue;
        }
        this.#queue.splice(index, 1);
        // Reserve persistence before touching the network. Failure means no request is sent.
        try {
          this.#nextDispatchAtMs =
            now + Math.ceil((task.weight / this.bucket.softPerSecond) * 1000);
          if (task.channel)
            this.#channelNextAtMs[task.channel] =
              now +
              Math.max(
                this.policy.channelIntervalsMs?.[task.channel] ?? 0,
                this.completionGap(task.channel)
              );
          this.persist();
        } catch (error) {
          if (task.key) this.#scheduledKeys.delete(task.key);
          item.reject(error);
          continue;
        }
        if (!this.bucket.consume(task.weight, now))
          throw new Error('GMGN budget admission invariant');
        this.#recent.push({ atMs: now, weight: task.weight });
        this.#inFlight++;
        if (task.channel) this.#channels.add(task.channel);
        const generation = this.#generation;
        let result: Promise<unknown>;
        try {
          result = task.run({
            dispatchedAtMs: now,
            queuedAtMs: item.queuedAtMs,
            weight: task.weight,
            priority: task.priority,
            availableWeight: this.bucket.available(now),
            inFlight: this.#inFlight
          });
        } catch (error) {
          result = Promise.reject(error instanceof Error ? error : new Error('GMGN task failed'));
        }
        void result
          .then(
            (value) => {
              if (generation === this.#generation) this.#probeRequired = false;
              item.resolve(value);
            },
            (error) => item.reject(error)
          )
          .finally(() => {
            this.#inFlight--;
            if (task.channel) {
              const gap = this.completionGap(task.channel);
              if (gap > 0) {
                this.#channelNextAtMs[task.channel] = Math.max(
                  this.#channelNextAtMs[task.channel] ?? 0,
                  this.clock.now() + gap,
                  this.#blockedUntilMs + gap
                );
                // Admission also persists before dispatch; a failed completion save cannot send a request.
                try {
                  this.persist();
                } catch {
                  this.#persistenceError = new Error(
                    'GMGN limiter completion persistence failed; restart after repairing state storage'
                  );
                }
              }
              this.#channels.delete(task.channel);
            }
            if (task.key) this.#scheduledKeys.delete(task.key);
            void this.drain();
          });
      }
    } finally {
      this.#draining = false;
    }
  }
}
