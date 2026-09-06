export type EvidenceFamily = 'lifecycle' | 'structure' | 'capital' | 'attention';
export interface SignalMapping {
  signalType: number;
  semanticCategory: string;
  evidenceFamily: EvidenceFamily;
  version: string;
}

/**
 * GMGN's maintained OpenAPI skill documents the numeric Signal enum.  The live BSC
 * catalog collected on 2026-09-04 confirms the returned fields; this table adds only
 * types with a usable BSC semantic. Rejected and chain-specific claim types remain
 * deliberately unmapped instead of being promoted from an inferred token name.
 */
export const signalMappingVersion = 'gmgn-skills-market-signal-2026-09-04-v1';

// Unknown types are retained for audit but must never score or trigger a formal signal.
const mappings: readonly SignalMapping[] = [
  {
    signalType: 1,
    semanticCategory: 'kline_price_spike',
    evidenceFamily: 'structure',
    version: signalMappingVersion
  },
  {
    signalType: 2,
    semanticCategory: 'dex_ad_placement',
    evidenceFamily: 'attention',
    version: signalMappingVersion
  },
  {
    signalType: 3,
    semanticCategory: 'dex_social_link_updated',
    evidenceFamily: 'attention',
    version: signalMappingVersion
  },
  {
    signalType: 4,
    semanticCategory: 'dex_trending_bar',
    evidenceFamily: 'attention',
    version: signalMappingVersion
  },
  {
    signalType: 5,
    semanticCategory: 'dex_boost',
    evidenceFamily: 'attention',
    version: signalMappingVersion
  },
  {
    signalType: 6,
    semanticCategory: 'price_spike',
    evidenceFamily: 'structure',
    version: signalMappingVersion
  },
  {
    signalType: 7,
    semanticCategory: 'price_all_time_high',
    evidenceFamily: 'structure',
    version: signalMappingVersion
  },
  {
    signalType: 8,
    semanticCategory: 'market_cap_key_level',
    evidenceFamily: 'structure',
    version: signalMappingVersion
  },
  {
    signalType: 9,
    semanticCategory: 'live_stream',
    evidenceFamily: 'attention',
    version: signalMappingVersion
  },
  {
    signalType: 10,
    semanticCategory: 'bundler_sell',
    evidenceFamily: 'capital',
    version: signalMappingVersion
  },
  {
    signalType: 11,
    semanticCategory: 'community_takeover',
    evidenceFamily: 'lifecycle',
    version: signalMappingVersion
  },
  {
    signalType: 12,
    semanticCategory: 'smart_degen_buy',
    evidenceFamily: 'capital',
    version: signalMappingVersion
  },
  {
    signalType: 13,
    semanticCategory: 'platform_call',
    evidenceFamily: 'attention',
    version: signalMappingVersion
  },
  {
    signalType: 19,
    semanticCategory: 'platform_call_v2',
    evidenceFamily: 'attention',
    version: signalMappingVersion
  },
  {
    signalType: 20,
    semanticCategory: 'kol_buy',
    evidenceFamily: 'capital',
    version: signalMappingVersion
  }
];

export const verifiedSignalMappings: ReadonlyMap<number, SignalMapping> = new Map(
  mappings.map((mapping) => [mapping.signalType, mapping])
);

export function mapSignalType(signalType: number): SignalMapping | null {
  return verifiedSignalMappings.get(signalType) ?? null;
}
export function canContributeToDecision(signalType: number): boolean {
  return mapSignalType(signalType) !== null;
}

export function classifySignalType(signalType: number): {
  signalType: number;
  mappingVersion: string;
  mapping: SignalMapping | null;
  decisionEligible: boolean;
} {
  const mapping = mapSignalType(signalType);
  return {
    signalType,
    mappingVersion: signalMappingVersion,
    mapping,
    decisionEligible: mapping !== null
  };
}
