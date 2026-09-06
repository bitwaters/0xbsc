export type WorkKind = 'formal_safety_quote' | 'discovery' | 'observation' | 'result';

export interface WorkBudgetInput {
  kind: WorkKind;
  score?: number;
  nowMs: number;
  deadlineMs?: number;
  utilization: number;
}

export type BudgetAction =
  | { action: 'run'; reevaluationMultiplier: number }
  | { action: 'postpone'; reevaluationMultiplier: number }
  | { action: 'expire'; reevaluationMultiplier: number };

/**
 * Strict degradation order: outcome work first, then low-score observation;
 * ready-candidate safety/Quote is never postponed.
 */
export function chooseBudgetAction(input: WorkBudgetInput): BudgetAction {
  if (input.deadlineMs !== undefined && input.nowMs > input.deadlineMs)
    return { action: 'expire', reevaluationMultiplier: 1 };
  if (input.kind === 'formal_safety_quote') return { action: 'run', reevaluationMultiplier: 1 };
  if (input.utilization < 0.8) return { action: 'run', reevaluationMultiplier: 1 };
  if (input.kind === 'result') return { action: 'postpone', reevaluationMultiplier: 1 };
  if (input.kind === 'observation' && (input.score ?? 0) < 65)
    return { action: 'run', reevaluationMultiplier: input.utilization >= 0.95 ? 4 : 2 };
  return { action: 'run', reevaluationMultiplier: 1 };
}
