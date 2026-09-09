import type { RuntimeConfig } from '../config/types.js';
import type { DeepSafetyThresholds } from './deep-gate.js';

/** One mapping for discovery, legacy assessment and the trial's final safety gate. */
export function safetyThresholds(config: RuntimeConfig): DeepSafetyThresholds {
  const s = config.security;
  return {
    maxBuyTax: s.max_buy_tax,
    maxSellTax: s.max_sell_tax,
    maxTop10Percent: s.max_top10_percent,
    maxTeamPercent: s.max_team_percent,
    maxEntrapmentPercent: s.max_entrapment_percent,
    maxBundlerPercent: s.max_bundler_percent,
    maxSniperPercent: s.max_sniper_percent,
    fatalFlags: s.fatal_flags
  };
}
