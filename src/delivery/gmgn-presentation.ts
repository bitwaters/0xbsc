import { Decimal } from 'decimal.js';

export interface SignalSocialLinks {
  website?: string;
  x?: string;
  telegram?: string;
}

export interface GmgnPresentationSnapshot {
  symbol: string;
  name: string;
  priceUsd?: string;
  marketCapUsd?: string;
  liquidityUsd?: string;
  holderCount?: number;
  visitingCount?: number;
  ageMs?: number;
  socialLinks: SignalSocialLinks;
  /** Time at which the source response was fetched. Present on runtime snapshots. */
  fetchedAtMs?: number;
}

/** Creates a normalized display snapshot from a GMGN token response. */
export function extractGmgnPresentation(input: {
  infoResponse: unknown;
  discoveryPayload?: Record<string, unknown>;
  nowMs?: number;
}): GmgnPresentationSnapshot {
  const info = dataRecord(input.infoResponse);
  const link = record(info.link) ?? {};
  const price = record(info.price) ?? {};
  const stat = record(info.stat) ?? {};
  const marketCapUsd = firstDecimalString(
    info.market_cap,
    info.market_cap_usd,
    price.market_cap,
    input.discoveryPayload?.market_cap
  );
  const calculatedMarketCap =
    marketCapUsd ??
    multiplyDecimalStrings(
      firstDecimalString(price.price, info.price_usd),
      firstDecimalString(info.circulating_supply, info.total_supply)
    );
  const ageMs = tokenAgeMs(info, input.nowMs ?? Date.now());

  return {
    symbol: cleanLabel(firstString(info.symbol), 'UNKNOWN', 32),
    name: cleanLabel(firstString(info.name), 'Unknown token', 80),
    ...(firstDecimalString(price.price, info.price_usd) === undefined
      ? {}
      : { priceUsd: firstDecimalString(price.price, info.price_usd)! }),
    ...(calculatedMarketCap === undefined ? {} : { marketCapUsd: calculatedMarketCap }),
    ...(firstDecimalString(info.liquidity, record(info.pool)?.liquidity) === undefined
      ? {}
      : { liquidityUsd: firstDecimalString(info.liquidity, record(info.pool)?.liquidity)! }),
    ...(firstCount(info.holder_count, stat.holder_count) === undefined
      ? {}
      : { holderCount: firstCount(info.holder_count, stat.holder_count)! }),
    ...(firstCount(info.visiting_count, stat.visiting_count) === undefined
      ? {}
      : { visitingCount: firstCount(info.visiting_count, stat.visiting_count)! }),
    ...(ageMs === undefined ? {} : { ageMs }),
    ...(input.nowMs === undefined ? {} : { fetchedAtMs: input.nowMs }),
    socialLinks: {
      ...(safeWebsite(firstString(link.website)) === undefined
        ? {}
        : { website: safeWebsite(firstString(link.website))! }),
      ...(safeX(firstString(link.twitter_username, link.twitter)) === undefined
        ? {}
        : { x: safeX(firstString(link.twitter_username, link.twitter))! }),
      ...(safeTelegram(firstString(link.telegram)) === undefined
        ? {}
        : { telegram: safeTelegram(firstString(link.telegram))! })
    }
  };
}

function cleanLabel(value: string | undefined, fallback: string, maximum: number): string {
  const cleaned = value ? stripControlCharacters(value.replace(/\s+/g, ' ')).trim() : undefined;
  return cleaned ? truncate(cleaned, maximum) : fallback;
}

function truncate(value: string, maximum: number): string {
  const characters = [...value];
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join('')}…`;
}

function safeWebsite(value: string | undefined): string | undefined {
  return safeHttpUrl(value);
}

function safeX(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const handle = value.trim().replace(/^@/, '');
  if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) return `https://x.com/${handle}`;
  const url = safeHttpUrl(value);
  if (!url) return undefined;
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com'
    ? url
    : undefined;
}

function safeTelegram(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const handle = value.trim().replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(handle)) return `https://t.me/${handle}`;
  const url = safeHttpUrl(value);
  if (!url) return undefined;
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === 't.me' || hostname === 'telegram.me' ? url : undefined;
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function multiplyDecimalStrings(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (left === undefined || right === undefined) return undefined;
  try {
    const result = new Decimal(left).mul(right);
    return result.isFinite() && result.greaterThanOrEqualTo(0) ? result.toString() : undefined;
  } catch {
    return undefined;
  }
}

function firstDecimalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    try {
      const decimal = new Decimal(value);
      if (decimal.isFinite() && decimal.greaterThanOrEqualTo(0)) return decimal.toString();
    } catch {
      // Try the next documented fallback field.
    }
  }
  return undefined;
}

function firstCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    const count = Number(value);
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
}

function tokenAgeMs(info: Record<string, unknown>, nowMs: number): number | undefined {
  const timestamp = Number(info.creation_timestamp ?? info.open_timestamp);
  if (!Number.isFinite(timestamp)) return undefined;
  const createdAtMs = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  return createdAtMs <= nowMs ? nowMs - createdAtMs : undefined;
}

function dataRecord(value: unknown): Record<string, unknown> {
  let current = record(value) ?? {};
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = record(current.data);
    if (!nested) break;
    current = nested;
  }
  return current;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join('');
}
