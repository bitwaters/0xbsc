import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyRuntime } from '../../src/safety/runtime.js';

const config = {
  security: {
    max_buy_tax: 0.05,
    max_sell_tax: 0.05,
    max_top10_percent: 0.5,
    max_team_percent: 0.1,
    max_entrapment_percent: 0.2,
    max_bundler_percent: 0.2,
    max_sniper_percent: 0.2,
    min_lp_locked_or_burned_percent: 0.8,
    fatal_flags: []
  }
} as never;
const event = {
  key: 'event',
  chain: 'bsc',
  tokenAddress: '0xabcdef',
  source: 'signal',
  sourceEventAtMs: 1,
  observedAtMs: 1,
  evidenceFamily: 'structure',
  strength: 'strong',
  expiresAtMs: 100,
  rawPayloadRef: 'sha256:test',
  payload: {}
} as const;

void test('rejects unknown Signal events before consuming safety calls', async () => {
  let calls = 0;
  const runtime = new SafetyRuntime(
    config,
    {
      token: () => {
        calls += 1;
        return Promise.resolve({});
      }
    } as never,
    () => 1
  );
  const result = await runtime.process({ ...event, decisionEligible: false });
  assert.equal(result.rejectionReason, 'unmapped_signal_type');
  assert.equal(calls, 0);
});

void test('evaluates adapted GMGN safety data with per-token serialization', async () => {
  const order: string[] = [];
  const response = (path: string) =>
    path.includes('info')
      ? {
          data: {
            stat: {
              dev_team_hold_rate: '0.01',
              top_entrapment_trader_percentage: '0.01',
              top_bundler_trader_percentage: '0.01',
              top70_sniper_hold_rate: '0.01'
            }
          }
        }
      : path.includes('security')
        ? {
            data: {
              buy_tax: '0.01',
              sell_tax: '0.01',
              can_not_sell: 0,
              top_10_holder_rate: '0.1',
              flags: [],
              is_renounced: true,
              renounced_mint: true,
              privileges: null,
              lock_summary: { lock_percent: '0.9' }
            }
          }
        : { data: {} };
  const runtime = new SafetyRuntime(
    config,
    {
      token: (path: string) => {
        order.push(path);
        return Promise.resolve(response(path));
      }
    } as never,
    () => 1
  );
  const [first, second] = await Promise.all([
    runtime.process(event),
    runtime.process({ ...event, key: 'event-2' })
  ]);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(order.length, 3);
});

void test('uses a short accepted safety cache but lets a fresh discovery veto override it', async () => {
  let calls = 0;
  const response = (path: string) =>
    path.includes('info')
      ? {
          data: {
            stat: {
              dev_team_hold_rate: '0.01',
              top_entrapment_trader_percentage: '0.01',
              top_bundler_trader_percentage: '0.01',
              top70_sniper_hold_rate: '0.01'
            }
          }
        }
      : path.includes('security')
        ? {
            data: {
              buy_tax: '0.01',
              sell_tax: '0.01',
              can_not_sell: 0,
              top_10_holder_rate: '0.1',
              flags: [],
              is_renounced: true,
              renounced_mint: true,
              privileges: null,
              lock_summary: { lock_percent: '0.9' }
            }
          }
        : { data: {} };
  const runtime = new SafetyRuntime(
    config,
    {
      token: (path: string) => {
        calls += 1;
        return Promise.resolve(response(path));
      }
    } as never,
    () => 1
  );
  assert.equal((await runtime.process(event)).allowed, true);
  assert.equal(calls, 3);
  assert.equal((await runtime.process({ ...event, key: 'cached' })).usedCache, true);
  assert.equal(calls, 3);
  const vetoed = await runtime.process({ ...event, key: 'veto', payload: { isHoneypot: true } });
  assert.equal(vetoed.rejectionReason, 'honeypot');
  assert.equal(calls, 3);
});

void test('maps GMGN snake-case discovery safety fields before deep calls', async () => {
  let calls = 0;
  const runtime = new SafetyRuntime(
    config,
    {
      token: () => {
        calls += 1;
        return Promise.resolve({});
      }
    } as never,
    () => 1
  );
  const result = await runtime.process({
    ...event,
    payload: { is_honeypot: 'yes' }
  });
  assert.equal(result.rejectionReason, 'honeypot');
  assert.equal(calls, 0);
});
