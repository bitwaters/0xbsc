import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { canonicalJson } from '../discovery/events.js';
import type { DiscoverySource } from '../discovery/events.js';
import { responseRows } from '../discovery/adapters.js';
import { apiMetricEndpoint } from '../observability/metrics.js';
import type { RequestInput } from './client.js';

export type RequestPurpose =
  'legacy_formal' | 'shared_collection' | 'shadow_execution' | 'baseline' | 'outcome';
export interface MarketFact {
  factId: string;
  attemptId: string;
  chain: 'bsc';
  token: string | null;
  poolRevision: string;
  endpoint: string;
  purpose: RequestPurpose;
  queuedAtMs: number;
  requestedAtMs: number;
  receivedAtMs: number;
  sourceAtMs: number | null;
  sourceTimeStatus: 'UNKNOWN' | 'NOT_APPLICABLE';
  sourceContractVersion: 'gmgn-facts-v1';
  payloadVersion: 1;
  semanticHash: string;
  request: Record<string, string | number>;
  payload: Record<string, unknown>;
  qualityFlags: string[];
}

type Shape = true | { readonly [key: string]: Shape } | readonly [Shape];
const price = Object.fromEntries(
  [
    'price',
    'buy_volume_1m',
    'buy_volume_5m',
    'sell_volume_1m',
    'sell_volume_5m',
    'volume_1m',
    'volume_5m',
    'buys_1m',
    'swaps_1m',
    'swaps_5m'
  ].map((k) => [k, true])
) as Record<string, true>;
const wallet = {
  address: true,
  amount_percentage: true,
  is_suspicious: true,
  buy_amount: true,
  sell_amount: true,
  buy_volume: true,
  sell_volume: true,
  balance: true,
  buy_amount_cur: true,
  sell_amount_cur: true,
  buy_volume_cur: true,
  sell_volume_cur: true,
  amount_cur: true,
  maker_token_tags: [true],
  tags: [true]
} as const;
const token = {
  base_address: true,
  rank: true,
  hot_interval: true,
  id: true,
  event_id: true,
  signal_type: true,
  trigger_at: true,
  timestamp: true,
  side: true,
  address: true,
  token_address: true,
  biggest_pool_address: true,
  creation_timestamp: true,
  open_timestamp: true,
  liquidity: true,
  launchpad: true,
  launchpad_platform: true,
  launchpad_status: true,
  price,
  stat: {
    dev_team_hold_rate: true,
    top_entrapment_trader_percentage: true,
    top_bundler_trader_percentage: true,
    top70_sniper_hold_rate: true,
    creator_address: true,
    creator_hold_rate: true,
    creator_created_count: true
  }
} as const;
const shapes: Record<string, Shape> = {
  info: token,
  pool: { address: true, pool_address: true, liquidity: true },
  security: {
    buy_tax: true,
    sell_tax: true,
    top_10_holder_rate: true,
    flags: [true],
    is_show_alert: true,
    is_honeypot: true,
    is_blacklist: true,
    is_wash_trading: true,
    is_open_source: true,
    open_source: true,
    can_not_sell: true,
    is_renounced: true,
    renounced_mint: true,
    privileges: [true],
    lock_summary: { lock_percent: true, lock_detail: [{ is_blackhole: true, percent: true }] }
  },
  kline: {
    list: [
      {
        time: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        volume_usd: true,
        swaps: true,
        swap_count: true,
        completed: true
      }
    ]
  },
  holders: { list: [wallet] },
  traders: { list: [wallet] },
  created_tokens: { open_ratio: true, total: true, list: [token] },
  quote: {
    output_amount: true,
    slippage: true,
    tx: { amount_in_usd: true, amount_out_usd: true, gas_limit: true }
  },
  gas: { native_token_usd_price: true },
  // Discovery payloads are deliberately small; normalized events provide the universe.
  trending: { list: [token] },
  hot: { list: [token] },
  trenches: { list: [token] },
  market_signal: { list: [{ ...token, signal_type: true, timestamp: true }] },
  smart_money: { list: [{ ...wallet, ...token }] },
  kol: { list: [{ ...wallet, ...token }] }
};
export function dataRecord(value: unknown): Record<string, unknown> {
  let result = record(value);
  for (
    let i = 0;
    i < 3 && result.data && typeof result.data === 'object' && !Array.isArray(result.data);
    i++
  )
    result = record(result.data);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function pick(value: unknown, shape: Shape, qualityFlags: string[]): unknown {
  if (shape === true && typeof value === 'string' && value.length > 256)
    qualityFlags.push('VALUE_TRUNCATED');
  if (shape === true)
    return value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= 256) ||
      (typeof value === 'number' && Number.isFinite(value))
      ? value
      : null;
  if (Array.isArray(shape)) {
    if (Array.isArray(value) && value.length > 2000) qualityFlags.push('ARRAY_TRUNCATED');
    return Array.isArray(value)
      ? value.slice(0, 2000).map((v) => pick(v, (shape as readonly [Shape])[0], qualityFlags))
      : null;
  }
  const input = record(value);
  return Object.fromEntries(
    Object.entries(shape)
      .filter(([key]) => Object.hasOwn(input, key))
      .map(([key, sub]) => [key, pick(input[key], sub, qualityFlags)])
  );
}
export function decimalValue(value: unknown): Decimal | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return null;
  try {
    const d = new Decimal(value);
    return d.isFinite() && d.gte(0) ? d : null;
  } catch {
    return null;
  }
}
export function knownRatio(numerator: unknown, denominator: unknown): string | null {
  const n = decimalValue(numerator),
    d = decimalValue(denominator);
  return n && d && d.gt(0) ? n.div(d).toString() : null;
}
const address = (v: unknown): string | null =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null;
export function createMarketFact(input: {
  poolRevision?: string;
  request: RequestInput;
  response: unknown;
  attemptId: string;
  queuedAtMs: number;
  requestedAtMs: number;
  receivedAtMs: number;
  purpose: RequestPurpose;
}): MarketFact {
  const endpoint = apiMetricEndpoint(input.request.path);
  const source = (
    {
      trending: 'trending',
      hot: 'hot',
      trenches: 'trenches',
      market_signal: 'signal',
      smart_money: 'smart_money',
      kol: 'kol'
    } as Record<string, DiscoverySource>
  )[endpoint];
  // Reuse the existing source-specific array/rank/group decoder, then apply the fact allowlist.
  const raw = source ? { list: responseRows(input.response, source) } : dataRecord(input.response);
  const qualityFlags: string[] = [];
  const payload = record(pick(raw, shapes[endpoint] ?? {}, qualityFlags));
  const request: Record<string, string | number> = {};
  for (const k of [
    'address',
    'wallet_address',
    'input_token',
    'output_token',
    'from_address',
    'input_amount',
    'slippage',
    'resolution',
    'from',
    'to',
    'interval',
    'limit'
  ]) {
    const v = input.request.query?.[k];
    if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 128))
      request[k] = v;
  }
  if (!shapes[endpoint]) qualityFlags.push('UNSUPPORTED_ENDPOINT');
  if (!Object.keys(payload).length) qualityFlags.push('UNSUPPORTED_PAYLOAD_SHAPE');
  if (!(input.queuedAtMs <= input.requestedAtMs && input.requestedAtMs <= input.receivedAtMs))
    qualityFlags.push('INVALID_PHYSICAL_TIME');
  if (endpoint === 'info') {
    qualityFlags.push('PRICE_SOURCE_TIME_UNVERIFIED');
    if (!decimalValue(record(payload.price).price)?.gt(0)) qualityFlags.push('INVALID_PRICE');
    if (!decimalValue(payload.liquidity)) qualityFlags.push('INVALID_LIQUIDITY');
    for (const [key, value] of Object.entries(record(payload.price)))
      if (!decimalValue(value)) qualityFlags.push(`INVALID_NUMBER:${key}`);
  }
  if (endpoint === 'kline') {
    const resolution = (
      { '30s': 30000, '1m': 60000, '5m': 300000, '1h': 3600000 } as Record<string, number>
    )[String(request.resolution)];
    const times = new Map<number, string>();
    for (const value of Array.isArray(payload.list) ? payload.list : []) {
      const row = record(value),
        time = Number(row.time);
      if (!Number.isSafeInteger(time) || time < 1e12 || time > input.receivedAtMs)
        qualityFlags.push('INVALID_CANDLE_TIME');
      const signature = canonicalJson(row);
      if (times.has(time) && times.get(time) !== signature) qualityFlags.push('CONFLICTING_CANDLE');
      times.set(time, signature);
      const o = decimalValue(row.open),
        h = decimalValue(row.high),
        l = decimalValue(row.low),
        c = decimalValue(row.close),
        v = decimalValue(row.volume ?? row.volume_usd);
      if (
        !o?.gt(0) ||
        !h?.gt(0) ||
        !l?.gt(0) ||
        !c?.gt(0) ||
        !v ||
        l.gt(Decimal.min(o, c)) ||
        h.lt(Decimal.max(o, c))
      )
        qualityFlags.push('INVALID_CANDLE');
    }
    const ordered = [...times.keys()].sort((a, b) => a - b);
    if (!resolution) qualityFlags.push('UNKNOWN_RESOLUTION');
    else if (ordered.some((t, i) => i > 0 && t - ordered[i - 1]! !== resolution))
      qualityFlags.push('CANDLE_GAP');
  }
  if (endpoint === 'holders' || endpoint === 'traders') {
    const seen = new Set<string>();
    for (const value of Array.isArray(payload.list) ? payload.list : []) {
      const row = record(value),
        walletAddress = address(row.address);
      if (!walletAddress) qualityFlags.push('INVALID_WALLET_ADDRESS');
      else if (seen.has(walletAddress)) qualityFlags.push('DUPLICATE_WALLET');
      else seen.add(walletAddress);
      if (endpoint === 'holders' && !decimalValue(row.amount_percentage))
        qualityFlags.push('HOLDER_SHARE_UNKNOWN');
      if (
        endpoint === 'traders' &&
        [
          'buy_amount_cur',
          'sell_amount_cur',
          'buy_volume_cur',
          'sell_volume_cur',
          'amount_cur'
        ].some((k) => !decimalValue(row[k]))
      )
        qualityFlags.push('TRADER_FIELDS_UNKNOWN');
    }
    qualityFlags.push('TOP_WALLET_COVERAGE_ONLY');
  }
  return {
    factId: randomUUID(),
    attemptId: input.attemptId,
    chain: 'bsc',
    token: address(request.address),
    poolRevision:
      address(
        payload.biggest_pool_address ??
          payload.pool_address ??
          (endpoint === 'pool' ? payload.address : null)
      ) ??
      address(input.poolRevision) ??
      'unresolved',
    endpoint,
    purpose: input.purpose,
    queuedAtMs: input.queuedAtMs,
    requestedAtMs: input.requestedAtMs,
    receivedAtMs: input.receivedAtMs,
    sourceAtMs: null,
    sourceTimeStatus: endpoint === 'info' ? 'UNKNOWN' : 'NOT_APPLICABLE',
    sourceContractVersion: 'gmgn-facts-v1',
    payloadVersion: 1,
    semanticHash: createHash('sha256')
      .update(canonicalJson({ endpoint, request, payload }))
      .digest('hex'),
    request,
    payload,
    qualityFlags: [...new Set(qualityFlags)]
  };
}
export function independentConfirmation(previous: MarketFact, next: MarketFact): boolean {
  // No audited point-price source clock exists yet. Receiving a new response is not proof of a new market observation.
  return (
    previous.factId !== next.factId &&
    previous.sourceAtMs !== null &&
    next.sourceAtMs !== null &&
    next.sourceAtMs > previous.sourceAtMs
  );
}
