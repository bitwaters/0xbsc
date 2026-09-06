import {
  fetchAndEvaluateDeepSafety,
  type DeepSafetyFetchers,
  type DeepSafetyThresholds
} from './deep-gate.js';
import { evaluatePermissionAndLpSafety, type PermissionSafetyData } from './permission-gate.js';
import {
  preFilter,
  type CachedSafety,
  type DiscoverySafetyFields,
  type SafetyThresholds
} from './pre-filter.js';

export interface CandidateSafetyAssessment {
  allowed: boolean;
  rejectionReason: string | null;
  shouldEnterObservation: boolean;
  usedCache: boolean;
}

export interface CandidateSafetyInput {
  discovery: DiscoverySafetyFields;
  cache?: CachedSafety;
  nowMs: number;
  preFilterThresholds: SafetyThresholds;
  deepThresholds: DeepSafetyThresholds;
  deepFetchers: DeepSafetyFetchers;
  permission: PermissionSafetyData;
  minimumLockedOrBurnedPercent: number;
  mappedFlags: ReadonlySet<string>;
}

export async function assessCandidateSafety(
  input: CandidateSafetyInput
): Promise<CandidateSafetyAssessment> {
  const initial = preFilter(input.discovery, input.preFilterThresholds, input.nowMs, input.cache);
  if (!initial.allowed) return rejected(initial.reason ?? 'pre_filter_rejected', initial.usedCache);
  if (initial.usedCache)
    return { allowed: true, rejectionReason: null, shouldEnterObservation: true, usedCache: true };

  const deep = await fetchAndEvaluateDeepSafety(
    input.deepFetchers,
    input.deepThresholds,
    input.mappedFlags
  );
  if (!deep.allowed) return rejected(deep.reason ?? 'deep_safety_rejected', false);
  const permission = evaluatePermissionAndLpSafety(
    input.permission,
    input.minimumLockedOrBurnedPercent
  );
  if (!permission.allowed)
    return rejected(permission.reason ?? 'permission_safety_rejected', false);
  return { allowed: true, rejectionReason: null, shouldEnterObservation: true, usedCache: false };
}

function rejected(reason: string, usedCache: boolean): CandidateSafetyAssessment {
  return { allowed: false, rejectionReason: reason, shouldEnterObservation: false, usedCache };
}
