export interface LazyDeepSafetyData {
  holders: { concentratedHoldings?: unknown; reason?: string | null; diagnostics?: unknown };
  traders: { coordinatedSmartMoneyExit?: unknown; reason?: string };
  createdTokens: {
    creatorDirectHoldUnsafe?: unknown;
    creatorHistory?: unknown;
  };
}

export interface CreatorHistoryAssessment {
  createdTokens: number;
  openRatio: number;
  risk: 'healthy' | 'elevated';
  qualityLevel: 0.5 | 1;
}

export interface LazyDeepSafetyFetchers {
  holders(): Promise<LazyDeepSafetyData['holders']>;
  traders(): Promise<LazyDeepSafetyData['traders']>;
  createdTokens(): Promise<LazyDeepSafetyData['createdTokens']>;
}

export interface LazyDeepVetoResult {
  allowed: boolean;
  reason: string | null;
  fetched: boolean;
  creatorHistory: CreatorHistoryAssessment | null;
  holderDiagnostics?: unknown;
}

export async function evaluateLazyDeepVeto(
  eligibleForFormalSignal: boolean,
  fetchers: LazyDeepSafetyFetchers
): Promise<LazyDeepVetoResult> {
  if (!eligibleForFormalSignal)
    return { allowed: true, reason: null, fetched: false, creatorHistory: null };
  let data: LazyDeepSafetyData;
  try {
    const [holders, traders, createdTokens] = await Promise.all([
      fetchers.holders(),
      fetchers.traders(),
      fetchers.createdTokens()
    ]);
    data = { holders, traders, createdTokens };
  } catch {
    return {
      allowed: false,
      reason: 'lazy_safety_source_unavailable',
      fetched: true,
      creatorHistory: null
    };
  }
  if (data.createdTokens.creatorDirectHoldUnsafe !== false)
    return {
      allowed: false,
      reason: 'creator_direct_hold_unverified',
      fetched: true,
      creatorHistory: null
    };
  const creatorHistory = creatorHistoryAssessment(data.createdTokens.creatorHistory);
  if (!creatorHistory)
    return {
      allowed: false,
      reason: 'creator_history_unverified',
      fetched: true,
      creatorHistory: null
    };
  if (data.holders.concentratedHoldings !== false)
    return {
      allowed: false,
      reason: data.holders.reason ?? 'concentrated_holdings_unverified',
      ...(data.holders.diagnostics === undefined
        ? {}
        : { holderDiagnostics: data.holders.diagnostics }),
      fetched: true,
      creatorHistory
    };
  if (data.traders.coordinatedSmartMoneyExit !== false)
    return {
      allowed: false,
      reason:
        data.traders.coordinatedSmartMoneyExit === true
          ? 'coordinated_smart_money_exit'
          : (data.traders.reason ?? 'coordinated_smart_money_exit_unverified'),
      fetched: true,
      creatorHistory
    };
  return { allowed: true, reason: null, fetched: true, creatorHistory };
}

function creatorHistoryAssessment(value: unknown): CreatorHistoryAssessment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const createdTokens = candidate.createdTokens;
  const openRatio = candidate.openRatio;
  const risk = candidate.risk;
  const qualityLevel = candidate.qualityLevel;
  if (
    typeof createdTokens !== 'number' ||
    !Number.isInteger(createdTokens) ||
    createdTokens < 0 ||
    typeof openRatio !== 'number' ||
    !Number.isFinite(openRatio) ||
    openRatio < 0 ||
    openRatio > 1 ||
    (risk !== 'healthy' && risk !== 'elevated') ||
    (qualityLevel !== 0.5 && qualityLevel !== 1) ||
    (risk === 'healthy' && qualityLevel !== 1) ||
    (risk === 'elevated' && qualityLevel !== 0.5)
  )
    return null;
  return { createdTokens, openRatio, risk, qualityLevel };
}
