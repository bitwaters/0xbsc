import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { canonicalJson } from '../discovery/events.js';
import { decimalValue, type MarketFact } from '../gmgn/facts.js';

export type Expression =
  | { constant: number | boolean }
  | { field: string }
  | { parameter: string }
  | {
      window: { field: string; ms: number; aggregate: 'min' | 'max' | 'mean'; min_samples: number };
    }
  | {
      op: 'and' | 'or' | 'not' | 'add' | 'sub' | 'mul' | 'div' | 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
      args: Expression[];
    };
const names = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const sourceFields = new Set([
  'info.liquidity',
  'info.price.price',
  'info.price.buy_volume_1m',
  'info.price.buy_volume_5m',
  'info.price.sell_volume_1m',
  'info.price.sell_volume_5m',
  'info.price.volume_1m',
  'info.price.volume_5m',
  'info.price.buys_1m',
  'info.price.swaps_1m',
  'info.price.swaps_5m'
]);
const definition = z
  .object({
    version: z.literal(1),
    id: names,
    fields: z
      .record(
        names,
        z
          .object({
            source: z.string(),
            ttl_ms: z.number().int().positive().max(86400000),
            require_source_time: z.boolean()
          })
          .strict()
      )
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 32),
    parameters: z.record(names, z.number().finite()),
    price_field: names,
    activation: z.unknown(),
    confirmation: z.unknown(),
    invalidation: z.unknown(),
    reset: z.unknown(),
    entry: z.unknown(),
    max_opportunity_ms: z.number().int().positive().max(86400000)
  })
  .strict();
export interface ModelManifest {
  version: 1;
  id: string;
  fields: Record<string, { source: string; ttl_ms: number; require_source_time: boolean }>;
  parameters: Record<string, number>;
  price_field: string;
  activation: Expression;
  confirmation: Expression;
  invalidation: Expression;
  reset: Expression;
  entry: Expression;
  max_opportunity_ms: number;
}
const numericOps = new Set(['add', 'sub', 'mul', 'div']);
const comparisonOps = new Set(['gt', 'gte', 'lt', 'lte', 'eq']);
function validateExpression(
  raw: unknown,
  fields: ModelManifest['fields'],
  parameters: Record<string, number>,
  depth = 0,
  budget = { nodes: 0 }
): { expression: Expression; type: 'boolean' | 'number' } {
  if (depth > 16 || ++budget.nodes > 256) throw new Error('MODEL_EXPRESSION_TOO_COMPLEX');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('MODEL_EXPRESSION_INVALID');
  const r = raw as Record<string, unknown>,
    keys = Object.keys(r);
  if (
    keys.length === 1 &&
    'constant' in r &&
    (typeof r.constant === 'boolean' ||
      (typeof r.constant === 'number' && Number.isFinite(r.constant)))
  )
    return {
      expression: { constant: r.constant },
      type: typeof r.constant as 'boolean' | 'number'
    };
  if (keys.length === 1 && typeof r.field === 'string' && Object.hasOwn(fields, r.field))
    return { expression: { field: r.field }, type: 'number' };
  if (
    keys.length === 1 &&
    typeof r.parameter === 'string' &&
    Object.hasOwn(parameters, r.parameter)
  )
    return { expression: { parameter: r.parameter }, type: 'number' };
  if (keys.length === 1 && 'window' in r) {
    const w = z
      .object({
        field: names,
        ms: z.number().int().positive().max(86400000),
        aggregate: z.enum(['min', 'max', 'mean']),
        min_samples: z.number().int().positive().max(1000)
      })
      .strict()
      .parse(r.window);
    if (!Object.hasOwn(fields, w.field)) throw new Error('UNKNOWN_MODEL_FIELD');
    return { expression: { window: w }, type: 'number' };
  }
  if (
    keys.length !== 2 ||
    !keys.includes('op') ||
    !keys.includes('args') ||
    typeof r.op !== 'string' ||
    !Array.isArray(r.args)
  )
    throw new Error('MODEL_EXPRESSION_INVALID');
  const args = r.args.map((a) => validateExpression(a, fields, parameters, depth + 1, budget));
  const op = r.op;
  if (['and', 'or'].includes(op)) {
    if (args.length < 2 || args.length > 16 || args.some((a) => a.type !== 'boolean'))
      throw new Error('MODEL_BOOLEAN_ARGUMENTS');
  } else if (op === 'not') {
    if (args.length !== 1 || args[0]?.type !== 'boolean')
      throw new Error('MODEL_BOOLEAN_ARGUMENTS');
  } else if (numericOps.has(op) || comparisonOps.has(op)) {
    if (args.length !== 2 || args.some((a) => a.type !== 'number'))
      throw new Error('MODEL_NUMERIC_ARGUMENTS');
  } else throw new Error('MODEL_OPERATOR_UNSUPPORTED');
  return {
    expression: {
      op: op as Extract<Expression, { op: string }>['op'],
      args: args.map((a) => a.expression)
    },
    type: numericOps.has(op) ? 'number' : 'boolean'
  };
}
export function validateModel(raw: unknown): { manifest: ModelManifest; hash: string } {
  const parsed = definition.parse(raw);
  for (const field of Object.values(parsed.fields)) {
    if (!sourceFields.has(field.source)) throw new Error(`UNSUPPORTED_FEATURE:${field.source}`);
    if (field.require_source_time) throw new Error('PRICE_SOURCE_TIME_UNVERIFIED');
  }
  if (parsed.fields[parsed.price_field]?.source !== 'info.price.price')
    throw new Error('MODEL_PRICE_FIELD_REQUIRED');
  const predicates = {} as Pick<
    ModelManifest,
    'activation' | 'confirmation' | 'invalidation' | 'reset' | 'entry'
  >;
  for (const key of ['activation', 'confirmation', 'invalidation', 'reset', 'entry'] as const) {
    const validated = validateExpression(parsed[key], parsed.fields, parsed.parameters);
    if (validated.type !== 'boolean') throw new Error(`MODEL_PREDICATE_NOT_BOOLEAN:${key}`);
    predicates[key] = validated.expression;
  }
  const manifest = { ...parsed, ...predicates };
  return { manifest, hash: createHash('sha256').update(canonicalJson(manifest)).digest('hex') };
}
export type ExpressionValue = Decimal | boolean | null;
export interface ModelInputs {
  model: ModelManifest;
  facts: readonly MarketFact[];
  evaluationAtMs: number;
  token: string;
  poolRevision: string;
}
function factValue(fact: MarketFact, source: string): Decimal | null {
  const [endpoint, ...path] = source.split('.');
  if (fact.endpoint !== endpoint) return null;
  let value: unknown = fact.payload;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return decimalValue(value);
}
export function fieldSamples(
  field: string,
  input: ModelInputs,
  windowMs = 0
): { fact: MarketFact; value: Decimal }[] {
  const contract = input.model.fields[field];
  if (!contract) return [];
  const oldest = input.evaluationAtMs - (windowMs || contract.ttl_ms);
  return input.facts
    .filter(
      (f) =>
        f.chain === 'bsc' &&
        f.token === input.token &&
        f.poolRevision === input.poolRevision &&
        f.receivedAtMs <= input.evaluationAtMs &&
        f.receivedAtMs >= oldest &&
        f.qualityFlags.every((flag) => flag === 'PRICE_SOURCE_TIME_UNVERIFIED') &&
        (!contract.require_source_time || f.sourceAtMs !== null)
    )
    .map((f) => ({ fact: f, value: factValue(f, contract.source) }))
    .filter((x): x is { fact: MarketFact; value: Decimal } => x.value !== null)
    .sort(
      (a, b) =>
        a.fact.receivedAtMs - b.fact.receivedAtMs || a.fact.factId.localeCompare(b.fact.factId)
    );
}
export function evaluateExpression(expr: Expression, input: ModelInputs): ExpressionValue {
  if ('constant' in expr)
    return typeof expr.constant === 'boolean' ? expr.constant : new Decimal(expr.constant);
  if ('field' in expr) return fieldSamples(expr.field, input).at(-1)?.value ?? null;
  if ('parameter' in expr) return new Decimal(input.model.parameters[expr.parameter]!);
  if ('window' in expr) {
    const samples = fieldSamples(expr.window.field, input, expr.window.ms);
    // A duplicate cached response or identical unverified payload does not increase sample count.
    const unique = [...new Map(samples.map((s) => [s.fact.semanticHash, s])).values()];
    if (unique.length < expr.window.min_samples) return null;
    const values = unique.map((s) => s.value);
    if (expr.window.aggregate === 'min') return values.reduce((a, b) => Decimal.min(a, b));
    if (expr.window.aggregate === 'max') return values.reduce((a, b) => Decimal.max(a, b));
    return values.reduce((a, b) => a.plus(b), new Decimal(0)).div(values.length);
  }
  const values = expr.args.map((a) => evaluateExpression(a, input));
  if (expr.op === 'and')
    return values.includes(false) ? false : values.includes(null) ? null : true;
  if (expr.op === 'or') return values.includes(true) ? true : values.includes(null) ? null : false;
  if (expr.op === 'not') return values[0] === null ? null : !values[0];
  const [a, b] = values;
  if (!(a instanceof Decimal) || !(b instanceof Decimal)) return null;
  switch (expr.op) {
    case 'add':
      return a.plus(b);
    case 'sub':
      return a.minus(b);
    case 'mul':
      return a.times(b);
    case 'div':
      return b.isZero() ? null : a.div(b);
    case 'gt':
      return a.gt(b);
    case 'gte':
      return a.gte(b);
    case 'lt':
      return a.lt(b);
    case 'lte':
      return a.lte(b);
    case 'eq':
      return a.eq(b);
  }
}
