import type { RuntimeConfig } from '../config/types.js';
import type { GmgnApi } from '../gmgn/api.js';
import type { Clock, GmgnScheduler } from '../gmgn/scheduler.js';
import type { Storage } from '../storage/database.js';
import { withGmgnContext } from '../gmgn/context.js';
import { BoundedWorkQueue } from './work-queue.js';
import { adaptGmgnResponse } from './adapters.js';
import { SnapshotDeduplicator, type DiscoverySource, type NormalizedEvent } from './events.js';
import { DiscoveryPollingService } from './plan.js';

const sourceForPoll = (name: string): DiscoverySource | null => {
  if (name.startsWith('signal:')) return 'signal';
  if (name === 'trenches') return 'trenches';
  if (name.startsWith('trending:')) return 'trending';
  if (name.startsWith('hot:')) return 'hot';
  if (name === 'smart_money') return 'smart_money';
  if (name === 'kol') return 'kol';
  return null;
};

export class DiscoveryRuntime {
  readonly polling: DiscoveryPollingService;
  readonly work: BoundedWorkQueue<NormalizedEvent>;
  #deduplicator = new SnapshotDeduplicator();
  #timer: ReturnType<typeof setInterval> | null = null;
  #runningTicks = new Set<string>();

  constructor(
    private readonly input: {
      config: RuntimeConfig;
      storage: Storage;
      api: GmgnApi;
      scheduler: GmgnScheduler;
      clock: Clock;
      /** The replacement publisher owns candidate persistence and consumes the public universe. */
      universeOnly?: boolean;
      onEvent?: (event: NormalizedEvent) => Promise<void>;
      onEventObserved?: (event: NormalizedEvent, persisted: boolean) => void;
      onUniverseObserved?: (event: NormalizedEvent) => void;
      onEventError?: (event: NormalizedEvent, error: Error) => void;
    }
  ) {
    this.work = new BoundedWorkQueue(
      input.config.optimization?.queue_capacity ?? 200,
      input.config.optimization?.queue_concurrency ?? 4,
      async (event) => {
        if (event.expiresAtMs > input.clock.now()) await input.onEvent?.(event);
      },
      (event, error) => input.onEventError?.(event, error)
    );
    this.polling = new DiscoveryPollingService(
      input.scheduler,
      input.clock,
      input.config,
      input.api
    );
  }

  async recover(): Promise<void> {
    this.#deduplicator = new SnapshotDeduplicator((await this.input.storage.recover()).snapshots);
  }

  async tick(name: string): Promise<number> {
    if (this.#runningTicks.has(name)) return 0;
    this.#runningTicks.add(name);
    try {
      return await this.runTick(name);
    } finally {
      this.#runningTicks.delete(name);
    }
  }

  private async runTick(name: string): Promise<number> {
    const outcome = await withGmgnContext({ purpose: 'shared_collection' }, () =>
      this.polling.tick(name)
    );
    const source = sourceForPoll(name);
    if (outcome.status !== 'success' || source === null || outcome.value === undefined) return 0;
    if (this.input.onUniverseObserved) {
      for (const event of adaptGmgnResponse({
        source,
        pollKey: name,
        response: outcome.value,
        observedAtMs: this.input.clock.now(),
        ttlMs: evidenceTtlMs(source, this.input.config)
      })) {
        this.input.onUniverseObserved(event);
      }
    }
    // Do not run the retired funnel's per-event FULL commits in replacement mode.
    // TrialRuntime persists bounded universe audit batches and the actual evaluation facts.
    if (this.input.universeOnly) return 0;
    const events = adaptGmgnResponse({
      source,
      pollKey: name,
      response: outcome.value,
      observedAtMs: this.input.clock.now(),
      ttlMs: evidenceTtlMs(source, this.input.config),
      ttlByFamilyMs: {
        lifecycle: this.input.config.evidence.ttl_seconds.lifecycle * 1_000,
        structure: this.input.config.evidence.ttl_seconds.structure * 1_000,
        capital: this.input.config.evidence.ttl_seconds.capital * 1_000,
        attention: this.input.config.evidence.ttl_seconds.attention * 1_000
      },
      narrativeTtlMs: this.input.config.evidence.ttl_seconds.narrative * 1_000,
      rankChangeStep: this.input.config.polling.rank_change_step,
      ...(this.input.config.security
        ? {
            snapshotSafetyThresholds: {
              maxBuyTax: this.input.config.security.max_buy_tax,
              maxSellTax: this.input.config.security.max_sell_tax,
              maxTop10Percent: this.input.config.security.max_top10_percent,
              maxTeamPercent: this.input.config.security.max_team_percent
            }
          }
        : {}),
      ...(source === 'trending' ? { maxRank: this.input.config.polling.trending_max_rank } : {})
    });
    let persisted = 0;
    for (const event of events) {
      const stored = event.sourceEventId
        ? await this.input.storage.persistDiscoveryEvent(event)
        : Boolean(
            await this.#deduplicator.ingest(
              { ...event, pollKey: event.pollKey ?? name },
              (candidate) => this.input.storage.persistDiscoveryEvent(candidate)
            )
          );
      this.input.onEventObserved?.(event, stored);
      if (!stored) continue;
      persisted += 1;
      if (
        this.input.onEvent &&
        !this.work.enqueue(`${event.tokenAddress}:${event.source}:${event.evidenceFamily}`, event)
      )
        this.input.onEventError?.(event, new Error('candidate_queue_capacity_exceeded'));
    }
    return persisted;
  }

  async tickAll(): Promise<number> {
    const counts = await Promise.all(this.polling.specs.map((spec) => this.tick(spec.name)));
    return counts.reduce((total, count) => total + count, 0);
  }

  async start(intervalMs = 250): Promise<void> {
    if (this.#timer) return;
    await this.recover();
    this.#timer = setInterval(
      () =>
        void this.tickAll().catch((error) =>
          console.error(
            JSON.stringify({
              event: 'discovery_tick_failed',
              error: error instanceof Error ? error.message : 'unknown'
            })
          )
        ),
      intervalMs
    );
    // Initial snapshots can contain many candidates, each of which may require
    // safety and route work.  Do not let that bootstrap work prevent the
    // recurring poller from being registered.
    void this.tickAll().catch((error) =>
      console.error(
        JSON.stringify({
          event: 'discovery_tick_failed',
          error: error instanceof Error ? error.message : 'unknown'
        })
      )
    );
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

function evidenceTtlMs(source: DiscoverySource, config: RuntimeConfig): number {
  const ttl = config.evidence.ttl_seconds;
  if (source === 'trenches') return ttl.lifecycle * 1_000;
  if (source === 'smart_money' || source === 'kol') return ttl.capital * 1_000;
  return ttl.attention * 1_000;
}
