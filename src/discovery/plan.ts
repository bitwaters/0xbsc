import type { RuntimeConfig } from '../config/types.js';
import type { GmgnApi } from '../gmgn/api.js';
import type { Clock, GmgnScheduler } from '../gmgn/scheduler.js';
import { IsolatedPoller, type PollOutcome } from './poller.js';

type DiscoveryApi = Pick<
  GmgnApi,
  'signals' | 'trenches' | 'rank' | 'hot' | 'smartMoney' | 'kol' | 'gas'
>;

export interface DiscoveryPollSpec {
  name: string;
  intervalMs: number;
  weight: number;
}

export class DiscoveryPollingService {
  readonly specs: readonly DiscoveryPollSpec[];
  #pollers = new Map<string, IsolatedPoller<unknown>>();
  #operations = new Map<string, () => Promise<unknown>>();

  constructor(
    scheduler: GmgnScheduler,
    clock: Clock,
    config: Pick<RuntimeConfig, 'polling' | 'gmgn'>,
    api: DiscoveryApi
  ) {
    const poll = config.polling;
    const weight = config.gmgn.endpoint_weights;
    const specs: DiscoveryPollSpec[] = [];
    const register = (
      name: string,
      intervalSeconds: number,
      endpointWeight: number,
      operation: () => Promise<unknown>
    ) => {
      const intervalMs = intervalSeconds * 1_000;
      this.#pollers.set(
        name,
        new IsolatedPoller(scheduler, clock, {
          key: `discovery:${name}`,
          weight: endpointWeight,
          intervalMs,
          maxBackoffMs: intervalMs * 16,
          jitterPercent: poll.jitter_percent
        })
      );
      this.#operations.set(name, operation);
      specs.push({ name, intervalMs, weight: endpointWeight });
    };
    register(
      'signal:high_frequency',
      poll.high_frequency_signal_seconds,
      weight.market_signal!,
      () => api.signals([{ signalTypes: poll.high_frequency_signal_types }])
    );
    register('signal:narrative', poll.narrative_signal_seconds, weight.market_signal!, () =>
      api.signals([{ signalTypes: poll.narrative_signal_types }])
    );
    register('trenches', poll.trenches_seconds, weight.trenches!, () =>
      api.trenches({
        version: 'v2',
        new_creation: { filters: ['offchain', 'onchain'] },
        near_completion: { filters: ['offchain', 'onchain'] },
        completed: { filters: ['offchain', 'onchain'] }
      })
    );
    for (const interval of ['1m', '5m', '1h'] as const)
      register(`trending:${interval}`, poll.trending_seconds, weight.trending!, () =>
        api.rank(interval, poll.trending_max_rank)
      );
    register('hot:short', poll.hot_short_seconds, weight.hot!, () =>
      api.hot([
        { label: 'bsc-1m', interval: '1m', chain: 'bsc' },
        { label: 'bsc-5m', interval: '5m', chain: 'bsc' }
      ])
    );
    register('hot:long', poll.hot_long_seconds, weight.hot!, () =>
      api.hot([
        { label: 'bsc-1h', interval: '1h', chain: 'bsc' },
        { label: 'bsc-6h', interval: '6h', chain: 'bsc' },
        { label: 'bsc-24h', interval: '24h', chain: 'bsc' }
      ])
    );
    register('smart_money', poll.smart_money_seconds, weight.smart_money!, () => api.smartMoney());
    register('kol', poll.kol_seconds, weight.kol!, () => api.kol());
    register('gas', poll.gas_seconds, weight.gas!, () => api.gas());
    this.specs = specs;
  }

  async tick(name: string): Promise<PollOutcome<unknown>> {
    const poller = this.#pollers.get(name);
    const operation = this.#operations.get(name);
    if (!poller || !operation) throw new RangeError(`unknown discovery poller: ${name}`);
    return poller.tick(operation);
  }

  tickAll(): Promise<PollOutcome<unknown>[]> {
    return Promise.all([...this.#pollers.keys()].map((name) => this.tick(name)));
  }
}
