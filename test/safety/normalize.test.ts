import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NormalizationError,
  normalizeRate,
  normalizeTokenAmount,
  normalizeUsd,
  normalizeWei
} from '../../src/safety/normalize.js';

void test('normalizes fractional and percent rates without accepting unsafe values', () => {
  assert.equal(normalizeRate('5', 'tax').toString(), '0.05');
  assert.equal(normalizeRate('0.05', 'tax').toString(), '0.05');
  assert.throws(() => normalizeRate('101', 'tax'), NormalizationError);
  assert.throws(() => normalizeRate('-1', 'tax'), NormalizationError);
});

void test('preserves exact USD, token and Wei values', () => {
  assert.equal(
    normalizeUsd('10000.000000000000000001', 'liquidity').toFixed(),
    '10000.000000000000000001'
  );
  assert.equal(normalizeTokenAmount('123456789', 6, 'amount').toFixed(), '123.456789');
  assert.equal(normalizeWei('1000000000000000001', 'gas').toFixed(), '1.000000000000000001');
});

void test('fails closed for ambiguous units and non-integer raw quantities', () => {
  assert.throws(() => normalizeTokenAmount('1.5', 18, 'amount'), NormalizationError);
  assert.throws(() => normalizeTokenAmount('1', '18', 'amount'), NormalizationError);
  assert.throws(() => normalizeWei('NaN', 'gas'), NormalizationError);
});
