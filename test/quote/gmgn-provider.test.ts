import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal } from 'decimal.js';
import { GmgnQuoteProvider, WBNB_ADDRESS, usdToWbnbAtoms } from '../../src/quote/gmgn-provider.js';

void test('converts USD positions to WBNB atoms without floating-point loss', () => {
  assert.equal(usdToWbnbAtoms(10, new Decimal('300')), '33333333333333333');
  assert.throws(() => usdToWbnbAtoms(0, 300));
});

void test('uses only read-only gas and bidirectional quote endpoints', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const api = {
    gas: () => Promise.resolve({ data: { native_token_usd_price: 300 } }),
    quote: (input: Record<string, unknown>) => {
      requests.push(input);
      return Promise.resolve({
        code: 0,
        data: {
          output_amount: input.inputToken === WBNB_ADDRESS ? '123' : '9999999999999999',
          slippage: 5,
          tx: { amount_in_usd: '10', amount_out_usd: '9.8', gas_limit: '21000' }
        }
      });
    }
  };
  const provider = await GmgnQuoteProvider.create({
    api: api as never,
    tokenAddress: '0xtoken',
    config: {
      gmgn: { quote_wallet: '0x0000000000000000000000000000000000000001' },
      quote: { max_slippage_percent: 0.05 }
    } as never
  });
  const buy = await provider.buy(10);
  const sell = await provider.sell(buy.outputTokenAmount);
  assert.equal(buy.direction, 'buy');
  assert.equal(sell.direction, 'sell');
  assert.deepEqual(requests, [
    {
      fromAddress: '0x0000000000000000000000000000000000000001',
      inputToken: WBNB_ADDRESS,
      outputToken: '0xtoken',
      inputAmount: '33333333333333333',
      slippagePercent: 5
    },
    {
      fromAddress: '0x0000000000000000000000000000000000000001',
      inputToken: '0xtoken',
      outputToken: WBNB_ADDRESS,
      inputAmount: '123',
      slippagePercent: 5
    }
  ]);
});
