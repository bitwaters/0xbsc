import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GmgnApi } from '../../src/gmgn/api.js';
import { GmgnClient, type RequestInput } from '../../src/gmgn/client.js';

const fixture = JSON.parse(
  await readFile(
    fileURLToPath(new URL('../fixtures/gmgn-recorded-response.json', import.meta.url)),
    'utf8'
  )
) as { code: number };

void test('replays scrubbed GMGN responses through every Phase 1 adapter route', async () => {
  const requests: RequestInput[] = [];
  const client = new GmgnClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'recorded-secret',
    transport: (input) => {
      requests.push(input);
      return Promise.resolve({ status: 200, headers: {}, body: fixture });
    }
  });
  const api = new GmgnApi(client);
  await Promise.all([
    api.rank('1m'),
    api.signals([{ signalTypes: [1] }]),
    api.trenches({ phase: 'new' }),
    api.hot({ interval: '1m' }),
    api.token('/v1/token/info', '0xabc'),
    api.token('/v1/token/security', '0xabc'),
    api.token('/v1/token/pool_info', '0xabc'),
    api.kline('0xabc', '30s', { fromMs: 1_000, toMs: 2_000 }),
    api.smartMoney(),
    api.kol(),
    api.holders('0xabc'),
    api.traders('0xabc'),
    api.createdTokens('0xwallet'),
    api.quote({
      fromAddress: '0xwallet',
      inputToken: '0xinput',
      outputToken: '0xoutput',
      inputAmount: '123456789',
      slippagePercent: 5
    }),
    api.gas()
  ]);
  assert.equal(requests.length, 15);
  assert.ok(
    requests.every(
      (request) =>
        request.query?.chain === 'bsc' ||
        request.path === '/v1/market/hot_searches' ||
        request.path === '/v1/market/token_signal'
    )
  );
  assert.deepEqual(
    requests.map((request) => request.path),
    [
      '/v1/market/rank',
      '/v1/market/token_signal',
      '/v1/trenches',
      '/v1/market/hot_searches',
      '/v1/token/info',
      '/v1/token/security',
      '/v1/token/pool_info',
      '/v1/market/token_kline',
      '/v1/user/smartmoney',
      '/v1/user/kol',
      '/v1/market/token_top_holders',
      '/v1/market/token_top_traders',
      '/v1/user/created_tokens',
      '/v1/trade/quote',
      '/v1/trade/gas_price'
    ]
  );
  assert.equal(requests[7]?.query?.from, 1_000);
  assert.equal(requests[7]?.query?.to, 2_000);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(requests[13]?.query ?? {}).filter(
        ([key]) => key !== 'timestamp' && key !== 'client_id'
      )
    ),
    {
      chain: 'bsc',
      from_address: '0xwallet',
      input_token: '0xinput',
      output_token: '0xoutput',
      input_amount: '123456789',
      slippage: 5
    }
  );
  assert.equal(JSON.stringify(fixture).includes('recorded-secret'), false);
});
