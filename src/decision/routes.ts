import type { RouteName } from '../config/types.js';

export interface RouteThresholds {
  newLaunchMaxAgeHours: number;
  newLaunchMinLiquidityUsd: number;
  revivalMinAgeHours: number;
  revivalMinLiquidityUsd: number;
  continuationMinLiquidityUsd: number;
}

export interface RouteFeatures {
  ageMs: number;
  liquidityUsd: number;
  priceUsd?: number;
  supportPriceUsd?: number;
  firstLaunchStage: boolean;
  validPool: boolean;
  realTrading: boolean;
  growthObserved: boolean;
  evidenceGatePassed: boolean;
  hasCompletedDormancy: boolean;
  revivalVolumeQualified: boolean;
  revivalSwapsQualified: boolean;
  structureBreakout: boolean;
  additionalRevivalConfirmation: boolean;
  upwardTrend: boolean;
  healthyPullback: boolean;
  restartVolume: boolean;
  smartMoneyExit: boolean;
  quoteDeteriorated: boolean;
  verticalPump: boolean;
}

export function classifyRoute(
  features: RouteFeatures,
  thresholds: RouteThresholds
): RouteName | null {
  const newAgeMs = thresholds.newLaunchMaxAgeHours * 3_600_000;
  if (
    features.ageMs <= newAgeMs &&
    features.liquidityUsd >= thresholds.newLaunchMinLiquidityUsd &&
    features.firstLaunchStage &&
    features.validPool &&
    features.realTrading &&
    features.growthObserved &&
    features.evidenceGatePassed
  )
    return 'new_launch';
  const revivalAgeMs = thresholds.revivalMinAgeHours * 3_600_000;
  if (
    features.ageMs > revivalAgeMs &&
    features.liquidityUsd >= thresholds.revivalMinLiquidityUsd &&
    features.hasCompletedDormancy &&
    features.revivalVolumeQualified &&
    features.revivalSwapsQualified &&
    features.structureBreakout &&
    features.additionalRevivalConfirmation
  )
    return 'revival';
  if (
    features.liquidityUsd >= thresholds.continuationMinLiquidityUsd &&
    features.upwardTrend &&
    features.healthyPullback &&
    features.restartVolume &&
    !features.smartMoneyExit &&
    !features.quoteDeteriorated &&
    !features.verticalPump
  )
    return 'continuation';
  return null;
}

/**
 * Compatibility admission for an old-token breakout that has not completed the
 * pullback/restart sequence yet. It maps to continuation for bounded Episode
 * tracking, but callers must keep it observation-only until classifyRoute()
 * independently confirms the full continuation gate.
 */
export function classifyObservationRoute(
  features: RouteFeatures,
  thresholds: RouteThresholds
): RouteName | null {
  const oldTokenAgeMs = thresholds.revivalMinAgeHours * 3_600_000;
  if (
    features.ageMs > oldTokenAgeMs &&
    features.liquidityUsd >= thresholds.revivalMinLiquidityUsd &&
    features.validPool &&
    features.realTrading &&
    features.evidenceGatePassed &&
    features.structureBreakout &&
    features.upwardTrend &&
    !features.smartMoneyExit &&
    !features.quoteDeteriorated
  )
    return 'continuation';
  return null;
}
