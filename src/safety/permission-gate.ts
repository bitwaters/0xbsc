import { normalizeRate } from './normalize.js';

export interface PermissionSafetyData {
  /** Solana mint authority does not describe an EVM contract's permissions. */
  chain?: 'bsc' | 'sol';
  ownerRenounced?: unknown;
  mintDisabled?: unknown;
  hasDangerousPrivilege?: unknown;
  poolKind?: unknown;
  lpLockedOrBurnedPercent?: unknown;
  verifiedLaunchpadPool?: unknown;
  verifiedLaunchpadMigration?: unknown;
}

export interface PermissionSafetyResult {
  allowed: boolean;
  reason: string | null;
  usedLaunchpadException: boolean;
}

export function evaluatePermissionAndLpSafety(
  data: PermissionSafetyData,
  minimumLockedOrBurnedPercent: number
): PermissionSafetyResult {
  // A GMGN-verified active launchpad curve is governed by the platform pool and
  // migration lifecycle rather than ordinary DEX contract controls.
  if (data.poolKind === 'launchpad') {
    if (data.verifiedLaunchpadPool !== true || data.verifiedLaunchpadMigration !== true)
      return rejected('launchpad_exception_unverified');
    return { allowed: true, reason: null, usedLaunchpadException: true };
  }
  if (data.ownerRenounced !== true) return rejected('owner_privilege_unverified');
  if (data.chain !== 'bsc' && data.mintDisabled !== true)
    return rejected('mint_privilege_unverified');
  if (data.hasDangerousPrivilege !== false) return rejected('dangerous_privilege_unverified');
  if (data.poolKind !== 'dex') return rejected('pool_lifecycle_unmapped');
  try {
    if (
      normalizeRate(data.lpLockedOrBurnedPercent, 'lp_locked_or_burned').lt(
        minimumLockedOrBurnedPercent
      )
    )
      return rejected('lp_lock_limit');
  } catch {
    return rejected('lp_lock_invalid');
  }
  return { allowed: true, reason: null, usedLaunchpadException: false };
}

function rejected(reason: string): PermissionSafetyResult {
  return { allowed: false, reason, usedLaunchpadException: false };
}
