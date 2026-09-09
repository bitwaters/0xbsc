import type { MarketFact } from '../gmgn/facts.js';
import { evaluateExpression, fieldSamples, type Expression, type ModelManifest } from './model.js';

/** Explain current market eligibility independently of the order of safety short-circuits. */
export function marketScreen(model: ModelManifest, fact: MarketFact, atMs: number) {
  const input = {
    model,
    facts: [fact],
    evaluationAtMs: atMs,
    token: fact.token!,
    poolRevision: fact.poolRevision
  };
  const state = (expression: Expression) => {
    const value = evaluateExpression(expression, input);
    return value === true ? 'PASS' : value === false ? 'FAIL' : 'UNKNOWN';
  };
  const terms =
    'op' in model.activation && model.activation.op === 'and'
      ? model.activation.args
      : [model.activation];
  const values = Object.fromEntries(
    Object.keys(model.fields).map((field) => [
      field,
      fieldSamples(field, input).at(-1)?.value.toString() ?? null
    ])
  );
  return {
    atMs,
    factId: fact.factId,
    activation: state(model.activation),
    values,
    conditions: terms.map((expression, index) => ({
      index,
      status: state(expression),
      ...('op' in expression && ['gt', 'gte', 'lt', 'lte', 'eq'].includes(expression.op)
        ? {
            actual: evaluateExpression(expression.args[0]!, input)?.toString() ?? null,
            threshold: evaluateExpression(expression.args[1]!, input)?.toString() ?? null
          }
        : {})
    }))
  };
}
export type MarketScreen = ReturnType<typeof marketScreen>;
