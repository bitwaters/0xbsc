import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePermissionAndLpSafety } from '../../src/safety/permission-gate.js';

const dex = {
  ownerRenounced: true,
  mintDisabled: true,
  hasDangerousPrivilege: false,
  poolKind: 'dex',
  lpLockedOrBurnedPercent: 0.8
};

void test('requires verified owner/mint permissions and normal DEX LP protection', () => {
  assert.deepEqual(evaluatePermissionAndLpSafety(dex, 0.8), {
    allowed: true,
    reason: null,
    usedLaunchpadException: false
  });
  assert.equal(
    evaluatePermissionAndLpSafety({ ...dex, ownerRenounced: false }, 0.8).reason,
    'owner_privilege_unverified'
  );
  assert.equal(
    evaluatePermissionAndLpSafety({ ...dex, lpLockedOrBurnedPercent: 0.799 }, 0.8).reason,
    'lp_lock_limit'
  );
});

void test('allows missing conventional LP lock only for the verified Launchpad lifecycle', () => {
  assert.deepEqual(
    evaluatePermissionAndLpSafety(
      {
        ...dex,
        poolKind: 'launchpad',
        lpLockedOrBurnedPercent: undefined,
        verifiedLaunchpadPool: true,
        verifiedLaunchpadMigration: true
      },
      0.8
    ),
    { allowed: true, reason: null, usedLaunchpadException: true }
  );
  assert.equal(
    evaluatePermissionAndLpSafety({ ...dex, poolKind: 'launchpad' }, 0.8).reason,
    'launchpad_exception_unverified'
  );
  assert.equal(
    evaluatePermissionAndLpSafety(
      {
        ...dex,
        ownerRenounced: false,
        mintDisabled: false,
        poolKind: 'launchpad',
        lpLockedOrBurnedPercent: undefined,
        verifiedLaunchpadPool: true,
        verifiedLaunchpadMigration: true
      },
      0.8
    ).allowed,
    true
  );
});
