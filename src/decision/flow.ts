export interface FlowFeatures {
  buyShare1m: number | null;
  buyShare5m: number | null;
  buyUsd1m: number | null;
  sellUsd1m: number | null;
  priceUsd: number | null;
}
export function marketFlow(response: unknown): FlowFeatures {
  let data = response as Record<string, unknown>;
  for (let i = 0; i < 3 && data?.data && typeof data.data === 'object'; i++)
    data = data.data as Record<string, unknown>;
  const price = (data?.price ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number | null =>
    v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0
      ? Number(v)
      : null;
  const share = (window: string) => {
    const buy = n(price[`buy_volume_${window}`]),
      sell = n(price[`sell_volume_${window}`]);
    return buy !== null && sell !== null && buy + sell > 0 ? buy / (buy + sell) : null;
  };
  return {
    buyShare1m: share('1m'),
    buyShare5m: share('5m'),
    buyUsd1m: n(price.buy_volume_1m),
    sellUsd1m: n(price.sell_volume_1m),
    priceUsd: n(price.price)
  };
}
