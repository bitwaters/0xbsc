import { gmgnContext } from './context.js';
import { responseTiming } from './client.js';
import type { GmgnClient } from './client.js';
import { maximumRows, truncateRows, validateSignalTypes } from './limits.js';
import type { Clock, GmgnScheduler, Priority } from './scheduler.js';

export interface CandidateGmgnApi {
  token(
    path: '/v1/token/info' | '/v1/token/security' | '/v1/token/pool_info',
    address: string,
    priority?: Priority
  ): Promise<unknown>;
  kline(
    address: string,
    resolution: '30s' | '1m' | '5m' | '1h',
    range?: { fromMs: number; toMs: number },
    priority?: Priority
  ): Promise<unknown>;
  holders(address: string, limit?: number): Promise<unknown>;
  traders(address: string, limit?: number): Promise<unknown>;
  createdTokens(walletAddress: string): Promise<unknown>;
  gas(): Promise<unknown>;
  quote(input: {
    fromAddress: string;
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    slippagePercent: number;
  }): Promise<unknown>;
}

export class GmgnApi {
  #gasCache: { atMs: number; value: unknown } | null = null;
  #gasPending = new Map<Priority, Promise<unknown>>();
  constructor(
    private readonly client: GmgnClient,
    private readonly gasTtlMs = 5000,
    private readonly now: () => number = Date.now
  ) {}
  rank(interval: '1m' | '5m' | '1h' | '6h' | '24h', limit = 50): Promise<unknown> {
    return this.client.read({
      method: 'GET',
      path: '/v1/market/rank',
      query: { chain: 'bsc', interval, limit }
    });
  }
  signals(groups: Array<{ signalTypes: number[]; marketCapMin?: number }>): Promise<unknown> {
    for (const group of groups) {
      validateSignalTypes(group.signalTypes);
      if (group.signalTypes.length > maximumRows.signalGroup)
        throw new RangeError('Signal group contains over 50 types');
    }
    return this.client.read({
      method: 'POST',
      path: '/v1/market/token_signal',
      body: {
        chain: 'bsc',
        groups: groups.map((group) => ({
          signal_type: group.signalTypes,
          ...(group.marketCapMin ? { mc_min: group.marketCapMin } : {})
        }))
      }
    });
  }
  trenches(body: unknown): Promise<unknown> {
    return this.client.read({
      method: 'POST',
      path: '/v1/trenches',
      query: { chain: 'bsc' },
      body
    });
  }
  hot(params: unknown): Promise<unknown> {
    return this.client.read({ method: 'POST', path: '/v1/market/hot_searches', body: { params } });
  }
  token(
    path: '/v1/token/info' | '/v1/token/security' | '/v1/token/pool_info',
    address: string
  ): Promise<unknown> {
    return this.client.read({ method: 'GET', path, query: { chain: 'bsc', address } });
  }
  kline(
    address: string,
    resolution: '30s' | '1m' | '5m' | '1h',
    range?: { fromMs: number; toMs: number }
  ): Promise<unknown> {
    return this.client.read({
      method: 'GET',
      path: '/v1/market/token_kline',
      query: { chain: 'bsc', address, resolution, from: range?.fromMs, to: range?.toMs }
    });
  }
  smartMoney(limit: number = maximumRows.smartMoney): Promise<unknown> {
    return this.client.read({
      method: 'GET',
      path: '/v1/user/smartmoney',
      query: { chain: 'bsc', limit: Math.min(limit, maximumRows.smartMoney) }
    });
  }
  kol(limit: number = maximumRows.kol): Promise<unknown> {
    return this.client.read({
      method: 'GET',
      path: '/v1/user/kol',
      query: { chain: 'bsc', limit: Math.min(limit, maximumRows.kol) }
    });
  }
  holders(address: string, limit: number = maximumRows.holders): Promise<unknown> {
    return this.client.read({
      method: 'GET',
      path: '/v1/market/token_top_holders',
      query: { chain: 'bsc', address, limit: Math.min(limit, maximumRows.holders) }
    });
  }
  traders(address: string, limit: number = maximumRows.traders): Promise<unknown> {
    return this.client.read({
      method: 'GET',
      path: '/v1/market/token_top_traders',
      query: { chain: 'bsc', address, limit: Math.min(limit, maximumRows.traders) }
    });
  }
  createdTokens(walletAddress: string): Promise<unknown> {
    return this.client.read({
      method: 'GET',
      path: '/v1/user/created_tokens',
      query: { chain: 'bsc', wallet_address: walletAddress }
    });
  }
  gas(): Promise<unknown> {
    const now = this.now();
    if (this.#gasCache && now - this.#gasCache.atMs < this.gasTtlMs)
      return Promise.resolve(this.#gasCache.value);
    const priority = gmgnContext().priority ?? 'candidate';
    const pending = this.#gasPending.get(priority);
    if (pending) return pending;
    // A formal caller must not inherit a queued background caller's lower priority/deadline.
    const result = this.client
      .read({ method: 'GET', path: '/v1/trade/gas_price', query: { chain: 'bsc' } })
      .then((value) => {
        const root = value as { data?: { native_token_usd_price?: unknown } };
        const price = root?.data?.native_token_usd_price;
        if (
          (typeof price === 'string' || typeof price === 'number') &&
          Number.isFinite(Number(price)) &&
          Number(price) > 0
        )
          this.#gasCache = { atMs: responseTiming(value)?.requestedAtMs ?? now, value };
        return value;
      })
      .finally(() => {
        this.#gasPending.delete(priority);
      });
    this.#gasPending.set(priority, result);
    return result;
  }
  quote(input: {
    fromAddress: string;
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    slippagePercent: number;
  }): Promise<unknown> {
    return this.client.read({
      method: 'GET',
      path: '/v1/trade/quote',
      query: {
        chain: 'bsc',
        from_address: input.fromAddress,
        input_token: input.inputToken,
        output_token: input.outputToken,
        input_amount: input.inputAmount,
        slippage: input.slippagePercent
      }
    });
  }
  static limitRows = truncateRows;
}

/**
 * Candidate analysis runs outside discovery pollers, so it must explicitly
 * re-enter the one shared scheduler rather than bypassing weight accounting.
 */
export class ScheduledCandidateGmgnApi implements CandidateGmgnApi {
  constructor(
    private readonly api: CandidateGmgnApi,
    private readonly scheduler: GmgnScheduler,
    private readonly clock: Clock,
    private readonly weights: Record<string, number>
  ) {}

  token(
    path: '/v1/token/info' | '/v1/token/security' | '/v1/token/pool_info',
    address: string,
    priority: Priority = 'candidate'
  ): Promise<unknown> {
    const key = path.endsWith('/info') ? 'info' : path.endsWith('/security') ? 'security' : 'pool';
    return this.schedule(key, priority, () => this.api.token(path, address));
  }

  kline(
    address: string,
    resolution: '30s' | '1m' | '5m' | '1h',
    range?: { fromMs: number; toMs: number },
    priority: Priority = 'candidate'
  ): Promise<unknown> {
    return this.schedule('kline', priority, () => this.api.kline(address, resolution, range));
  }

  holders(address: string, limit?: number): Promise<unknown> {
    return this.schedule('holders', 'formal', () => this.api.holders(address, limit));
  }

  traders(address: string, limit?: number): Promise<unknown> {
    return this.schedule('traders', 'formal', () => this.api.traders(address, limit));
  }

  createdTokens(walletAddress: string): Promise<unknown> {
    return this.schedule('created_tokens', 'formal', () => this.api.createdTokens(walletAddress));
  }

  gas(): Promise<unknown> {
    return this.schedule('gas', 'formal', () => this.api.gas());
  }

  quote(input: {
    fromAddress: string;
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    slippagePercent: number;
  }): Promise<unknown> {
    return this.schedule('quote', gmgnContext().priority ?? 'formal', () => this.api.quote(input));
  }

  private schedule<T>(endpoint: string, priority: Priority, run: () => Promise<T>): Promise<T> {
    const weight = this.weights[endpoint];
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0)
      return Promise.reject(new Error(`missing configured GMGN weight: ${endpoint}`));
    return this.scheduler.runLogical({
      weight,
      priority,
      deadlineMs: this.clock.now() + 30_000,
      run
    });
  }
}
