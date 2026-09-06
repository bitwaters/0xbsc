import { responseTiming } from '../gmgn/client.js';
import { Decimal } from 'decimal.js';
import type { RuntimeConfig } from '../config/types.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import { parseGmgnQuote } from '../gmgn/quote.js';
import { quoteLegFromGmgn, type BuyQuote, type QuoteLeg, type QuoteProvider } from './gate.js';

/** The audited BSC Quote route uses WBNB as the neutral, read-only input asset. */
export const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

export class GmgnQuoteProvider implements QuoteProvider {
  private constructor(
    private readonly api: CandidateGmgnApi,
    private readonly wallet: string,
    private readonly tokenAddress: string,
    private readonly nativeUsdPrice: Decimal,
    private readonly slippagePercent: number,
    private readonly now: () => number
  ) {}

  static async create(input: {
    api: CandidateGmgnApi;
    config: RuntimeConfig;
    tokenAddress: string;
    now?: () => number;
  }): Promise<GmgnQuoteProvider> {
    const gas = unwrap(await input.api.gas());
    const rawPrice = gas.native_token_usd_price;
    const nativeUsdPrice = new Decimal(
      typeof rawPrice === 'string' || typeof rawPrice === 'number' ? String(rawPrice) : 'NaN'
    );
    if (!nativeUsdPrice.isFinite() || nativeUsdPrice.lte(0))
      throw new Error('GMGN gas response lacks a positive native_token_usd_price');
    return new GmgnQuoteProvider(
      input.api,
      input.config.gmgn.quote_wallet,
      input.tokenAddress,
      nativeUsdPrice,
      input.config.quote.max_slippage_percent * 100,
      input.now ?? Date.now
    );
  }

  async buy(sizeUsd: number): Promise<BuyQuote> {
    const rawAmount = usdToWbnbAtoms(sizeUsd, this.nativeUsdPrice);
    const requestedAtMs = this.now();
    const raw = await this.api.quote({
      fromAddress: this.wallet,
      inputToken: WBNB_ADDRESS,
      outputToken: this.tokenAddress,
      inputAmount: rawAmount,
      slippagePercent: this.slippagePercent
    });
    const quote = parseGmgnQuote(raw);
    const timing = responseTiming(raw) ?? { requestedAtMs, completedAtMs: this.now() };
    return {
      ...timing,
      ...quoteLegFromGmgn(quote, 'buy'),
      outputTokenAmount: quote.outputTokenAmount
    };
  }

  async sell(tokenAmount: string): Promise<QuoteLeg> {
    if (!/^\d+$/.test(tokenAmount) || new Decimal(tokenAmount).lte(0))
      throw new RangeError('sell token amount must be a positive integer string');
    const requestedAtMs = this.now();
    const raw = await this.api.quote({
      fromAddress: this.wallet,
      inputToken: this.tokenAddress,
      outputToken: WBNB_ADDRESS,
      inputAmount: tokenAmount,
      slippagePercent: this.slippagePercent
    });
    const quote = parseGmgnQuote(raw);
    const timing = responseTiming(raw) ?? { requestedAtMs, completedAtMs: this.now() };
    return { ...timing, ...quoteLegFromGmgn(quote, 'sell') };
  }
}

export function usdToWbnbAtoms(sizeUsd: number, nativeUsdPrice: Decimal.Value): string {
  const usd = new Decimal(sizeUsd);
  const native = new Decimal(nativeUsdPrice);
  if (!usd.isFinite() || usd.lte(0) || !native.isFinite() || native.lte(0))
    throw new RangeError('USD size and native USD price must be positive');
  return usd.div(native).mul(new Decimal(10).pow(18)).floor().toFixed(0);
}

function unwrap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const root = value as Record<string, unknown>;
  const data = root.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : root;
}
