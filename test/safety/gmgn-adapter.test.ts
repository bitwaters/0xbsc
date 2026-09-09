import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptGmgnSafety } from '../../src/safety/gmgn-adapter.js';

void test('maps audited GMGN security fields and keeps unknown values fail-closed', () => {
  const adapted = adaptGmgnSafety({
    info: {
      data: {
        stat: {
          dev_team_hold_rate: '0.1',
          top_entrapment_trader_percentage: '0.01',
          top_bundler_trader_percentage: '0.02',
          top70_sniper_hold_rate: '0.03'
        }
      }
    },
    security: {
      data: {
        buy_tax: '0.01',
        sell_tax: '0.02',
        can_not_sell: 0,
        top_10_holder_rate: '0.4',
        flags: [],
        is_renounced: true,
        renounced_mint: false,
        privileges: null,
        lock_summary: {
          lock_percent: '0.1',
          lock_detail: [{ is_blackhole: true, percent: '0.8' }]
        }
      }
    },
    pool: { data: {} }
  });
  assert.equal(adapted.deep.info.buyTax, '0.01');
  assert.equal(adapted.deep.security.top10Percent, '0.4');
  assert.equal(adapted.deep.pool.sellable, true);
  assert.deepEqual(adapted.permission, {
    chain: 'bsc',
    ownerRenounced: true,
    hasDangerousPrivilege: false,
    poolKind: 'dex',
    lpLockedOrBurnedPercent: 0.8
  });
  assert.equal(
    adaptGmgnSafety({ info: {}, security: { data: { privileges: {} } }, pool: {} }).permission
      .hasDangerousPrivilege,
    undefined
  );
});

void test('uses GMGN launchpad lifecycle fields and fails closed for unknown sellability', () => {
  const launchpad = adaptGmgnSafety({
    info: { data: { launchpad: 'flap', launchpad_platform: 'flap', launchpad_status: 1 } },
    security: { data: { can_not_sell: 0, privileges: null } },
    pool: { data: {} }
  });
  assert.equal(launchpad.permission.poolKind, 'launchpad');
  assert.equal(launchpad.permission.verifiedLaunchpadPool, true);
  assert.equal(launchpad.permission.verifiedLaunchpadMigration, true);
  assert.equal(
    adaptGmgnSafety({ info: {}, security: { data: { privileges: null } }, pool: {} }).deep.pool
      .sellable,
    undefined
  );
  assert.equal(
    adaptGmgnSafety({
      info: {},
      security: {
        data: {
          privileges: null,
          lock_summary: { lock_percent: 'not-a-rate', lock_detail: [] }
        }
      },
      pool: {}
    }).permission.lpLockedOrBurnedPercent,
    undefined
  );
});

void test('explicit risk flags override empty flags and an affirmative sellability field', async () => {
  const { evaluateDeepSafety } = await import('../../src/safety/deep-gate.js');
  const thresholds = {
    maxBuyTax: 0.05,
    maxSellTax: 0.05,
    maxTop10Percent: 0.5,
    maxTeamPercent: 0.1,
    maxEntrapmentPercent: 0.2,
    maxBundlerPercent: 0.2,
    maxSniperPercent: 0.2,
    fatalFlags: []
  };
  for (const [field, value, reason] of [
    ['is_honeypot', 'yes', 'explicit_risk:honeypot'],
    ['is_blacklist', true, 'explicit_risk:blacklist'],
    ['is_open_source', false, 'explicit_risk:closed_source']
  ] as const) {
    const adapted = adaptGmgnSafety({
      info: {},
      pool: {},
      security: { data: { flags: [], is_show_alert: false, can_not_sell: 0, [field]: value } }
    });
    assert.equal(evaluateDeepSafety(adapted.deep, thresholds, new Set()).reason, reason);
  }
  const conflict = adaptGmgnSafety({
    info: {},
    pool: {},
    security: { is_open_source: true, open_source: 'no' }
  });
  assert.equal(
    evaluateDeepSafety(conflict.deep, thresholds, new Set()).reason,
    'security_field_conflict:closed_source'
  );
});

void test('BSC permissions use EVM ownership; Solana defaults do not block a verified ordinary pool', async () => {
  const { evaluatePermissionAndLpSafety } = await import('../../src/safety/permission-gate.js');
  const security = {
    is_renounced: true,
    renounced_mint: false,
    privileges: null,
    lock_summary: { lock_percent: '0.8' }
  };
  const check = (changes: Record<string, unknown>) =>
    evaluatePermissionAndLpSafety(
      adaptGmgnSafety({ info: {}, security: { ...security, ...changes }, pool: {} }).permission,
      0.8
    );
  assert.equal(check({}).allowed, true);
  assert.equal(check({ is_renounced: false }).reason, 'owner_privilege_unverified');
  assert.equal(check({ is_renounced: undefined }).reason, 'owner_privilege_unverified');
  assert.equal(check({ is_renounced: undefined, owner_renounced: 'yes' }).allowed, true);
  assert.equal(check({ owner_renounced: 'no' }).reason, 'owner_privilege_unverified');
  assert.equal(check({ privileges: ['mint'] }).reason, 'dangerous_privilege_unverified');
  assert.equal(check({ lock_summary: { lock_percent: 0.79 } }).reason, 'lp_lock_limit');
  assert.equal(
    evaluatePermissionAndLpSafety(
      {
        chain: 'sol',
        ownerRenounced: true,
        mintDisabled: false,
        hasDangerousPrivilege: false,
        poolKind: 'dex',
        lpLockedOrBurnedPercent: 0.8
      },
      0.8
    ).reason,
    'mint_privilege_unverified'
  );
});
