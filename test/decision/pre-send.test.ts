import assert from 'node:assert/strict';
import test from 'node:test';
import { preSendRejection } from '../../src/decision/pre-send.js';
const base = {
  info: {
    data: {
      price: {
        price: '100',
        buy_volume_1m: '70',
        sell_volume_1m: '30',
        buy_volume_5m: '60',
        sell_volume_5m: '40'
      }
    }
  },
  expectedPrice: 100,
  supportPrice: 95,
  maxRetrace: 0.25,
  nowMs: 10_000,
  triggerAtMs: 5000,
  triggerMaxAgeMs: 60_000,
  securityStartedAtMs: 8000,
  securityMaxAgeMs: 30_000,
  quoteAtMs: 9000,
  quoteMaxAgeMs: 5000
};
void test('a tradable quote does not override lost buy pressure or broken price support', () => {
  assert.equal(preSendRejection(base), null);
  assert.equal(
    preSendRejection({
      ...base,
      info: {
        data: { price: { ...base.info.data.price, buy_volume_1m: '20', sell_volume_1m: '80' } }
      }
    }),
    'pre_send_buy_pressure_lost'
  );
  assert.equal(
    preSendRejection({
      ...base,
      info: { data: { price: { ...base.info.data.price, price: '94' } } }
    }),
    'pre_send_structure_broken'
  );
  assert.equal(
    preSendRejection({ ...base, info: { data: { price: { price: '100' } } } }),
    'pre_send_flow_data_missing'
  );
});
void test('freshness is measured at actual send preparation completion with future times rejected', () => {
  assert.equal(
    preSendRejection({ ...base, nowMs: 40_000, quoteAtMs: 39_000 }),
    'pre_send_security_expired'
  );
  assert.equal(preSendRejection({ ...base, quoteAtMs: 1000 }), 'pre_send_quote_expired');
  assert.equal(preSendRejection({ ...base, triggerAtMs: 11_000 }), 'pre_send_trigger_expired');
});
