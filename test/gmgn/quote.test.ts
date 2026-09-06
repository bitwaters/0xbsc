import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseGmgnQuote } from '../../src/gmgn/quote.js';

const fixture = JSON.parse(
  await readFile(
    fileURLToPath(new URL('../fixtures/gmgn-quote-response.json', import.meta.url)),
    'utf8'
  )
) as unknown;

void test('freezes GMGN Quote units without double-counting unavailable taxes, fees or gas', () => {
  assert.deepEqual(parseGmgnQuote(fixture), {
    inputUsd: '10',
    outputUsd: '9.92546496321935310393975',
    outputTokenAmount: '86415433406157045046',
    routeAvailable: true,
    configuredSlippagePercent: '10',
    gasLimit: '350000',
    costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1'
  });
  assert.equal(parseGmgnQuote({ code: 400, data: { slippage: 10 } }).routeAvailable, false);
});
