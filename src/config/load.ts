import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { RuntimeConfig } from './types.js';

const percentage = z.number().min(0).max(1);
const weightTable = z
  .object({
    lifecycle: z.number().min(0).max(100),
    structure: z.number().min(0).max(100),
    capital: z.number().min(0).max(100),
    attention: z.number().min(0).max(100),
    quality: z.number().min(0).max(100),
    freshness: z.number().min(0).max(100)
  })
  .strict();

const endpointWeights = z
  .object({
    trending: z.number().positive(),
    info: z.number().positive(),
    security: z.number().positive(),
    pool: z.number().positive(),
    smart_money: z.number().positive(),
    kol: z.number().positive(),
    gas: z.number().positive(),
    kline: z.number().positive(),
    quote: z.number().positive(),
    created_tokens: z.number().positive(),
    trenches: z.number().positive(),
    hot: z.number().positive(),
    market_signal: z.number().positive(),
    holders: z.number().positive(),
    traders: z.number().positive()
  })
  .strict();

const polling = z
  .object({
    jitter_percent: percentage,
    high_frequency_signal_seconds: z.number().positive(),
    narrative_signal_seconds: z.number().positive(),
    trenches_seconds: z.number().positive(),
    smart_money_seconds: z.number().positive(),
    kol_seconds: z.number().positive(),
    trending_seconds: z.number().positive(),
    trending_max_rank: z.number().int().positive(),
    rank_change_step: z.number().int().positive(),
    hot_short_seconds: z.number().positive(),
    hot_long_seconds: z.number().positive(),
    gas_seconds: z.number().positive(),
    observation_seconds: z.number().positive(),
    high_frequency_signal_types: z.array(z.number().int().positive()).min(1),
    narrative_signal_types: z.array(z.number().int().positive()).min(1)
  })
  .strict();

const lazyDeepSafety = z
  .object({
    max_single_non_pool_holder_percent: percentage,
    max_suspicious_holder_percent: percentage,
    max_creator_hold_percent: percentage,
    max_creator_created_tokens: z.number().int().positive(),
    min_creator_open_ratio: percentage,
    creator_history_max_penalty_points: z.number().min(0).max(5),
    coordinated_exit: z
      .object({
        min_snapshot_interval_seconds: z.number().positive().max(60).default(10),
        min_tagged_wallets: z.number().int().positive(),
        min_each_sell_percent: percentage,
        min_total_sell_percent: percentage,
        max_activity_age_seconds: z.number().positive().default(180),
        max_activity_spread_seconds: z.number().positive().default(60),
        recognized_wallet_tags: z.array(z.string().min(1)).min(1)
      })
      .strict()
  })
  .strict();

const runtimeConfigSchema = z
  .object({
    runtime: z.object({ chain: z.literal('bsc'), mode: z.enum(['dry_run', 'live']) }).strict(),
    gmgn: z
      .object({
        base_url: z.string().url(),
        api_key: z.string().min(1),
        quote_wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        rate_limit: z.object({
          hard_weight_per_second: z.number().positive(),
          soft_weight_per_second: z.number().positive(),
          burst_reserve_weight: z.number().min(0),
          max_in_flight: z.number().int().min(1).max(20).default(4),
          quote_min_interval_ms: z.number().int().min(0).max(5000).default(600),
          missing_reset_delay_seconds: z.number().min(30).max(300).default(30)
        }),
        endpoint_weights: endpointWeights
      })
      .strict(),
    telegram: z
      .object({
        bot_token: z.string().min(1),
        chat_ids: z.array(z.string()).min(1),
        allowed_user_ids: z.array(z.string()).min(1),
        buttons: z.object({ gmgn_detail: z.string().min(1) }).catchall(z.string().min(1))
      })
      .strict(),
    polling,
    security: z
      .object({
        max_buy_tax: percentage,
        max_sell_tax: percentage,
        max_top10_percent: percentage,
        max_team_percent: percentage,
        max_entrapment_percent: percentage,
        max_bundler_percent: percentage,
        max_sniper_percent: percentage,
        min_lp_locked_or_burned_percent: percentage,
        fatal_flags: z.array(z.string()),
        lazy_deep: lazyDeepSafety
      })
      .strict(),
    strategy: z
      .object({
        new_launch_max_age_hours: z.number().positive(),
        new_launch_min_liquidity_usd: z.number().nonnegative(),
        revival_min_age_hours: z.number().positive(),
        revival_min_liquidity_usd: z.number().nonnegative(),
        continuation_min_liquidity_usd: z.number().nonnegative(),
        dormancy_window_candles: z.number().int().positive(),
        dormancy_max_average_volume_usd: z.number().nonnegative(),
        dormancy_max_average_swaps: z.number().nonnegative(),
        revival_baseline_candles: z.number().int().positive(),
        revival_min_absolute_volume_usd: z.number().nonnegative(),
        revival_min_absolute_swaps: z.number().nonnegative(),
        revival_volume_multiple: z.number().positive(),
        revival_swaps_multiple: z.number().positive(),
        breakout_lookback_candles: z.number().int().positive(),
        breakout_minimum_rate: percentage,
        trend_lookback_candles: z.number().int().positive(),
        trend_minimum_growth_rate: percentage,
        pullback_max_retrace_rate: percentage,
        pullback_max_volume_ratio: z.number().positive(),
        restart_minimum_volume_ratio: z.number().positive(),
        vertical_pump_window_candles: z.number().int().positive(),
        vertical_pump_maximum_growth_rate: percentage
      })
      .strict(),
    evidence: z
      .object({
        ttl_seconds: z
          .object({
            lifecycle: z.number().positive(),
            structure: z.number().positive(),
            capital: z.number().positive(),
            attention: z.number().positive(),
            narrative: z.number().positive()
          })
          .strict()
      })
      .strict(),
    scoring: z
      .object({
        observation_threshold: z.number().min(0).max(100),
        formal_threshold: z.number().min(0).max(100),
        min_completeness: percentage,
        data_ttl_seconds: z
          .object({
            info: z.number().positive(),
            pool: z.number().positive(),
            kline: z.number().positive(),
            traders: z.number().positive(),
            holders: z.number().positive(),
            creator: z.number().positive()
          })
          .strict(),
        route_weights: z
          .object({ new_launch: weightTable, revival: weightTable, continuation: weightTable })
          .strict(),
        decisive_trigger_seconds: z
          .object({
            new_launch: z.number().positive(),
            revival: z.number().positive(),
            continuation: z.number().positive()
          })
          .strict()
      })
      .strict(),
    observation: z
      .object({
        max_active_episodes: z.number().int().positive(),
        soft_route_target: z.number().int().positive(),
        expiry_minutes: z.record(z.number().positive())
      })
      .strict(),
    quote: z
      .object({
        position_usd: z.tuple([z.literal(10), z.literal(50), z.literal(100)]),
        max_slippage_percent: percentage,
        max_one_way_loss: z.object({ '10': percentage, '50': percentage, '100': percentage }),
        max_round_trip_loss: z.object({ '10': percentage, '50': percentage, '100': percentage }),
        retry_minimum_seconds: z.number().positive(),
        material_price_change_percent: percentage,
        material_liquidity_change_percent: percentage,
        security_pool_max_age_seconds: z.number().positive(),
        max_age_seconds: z.number().positive()
      })
      .strict(),
    optimization: z
      .object({
        enabled: z.boolean().default(true),
        minimum_buy_share: percentage.default(0.6),
        confirmations: z.number().int().min(2).max(10).default(3),
        minimum_spacing_seconds: z.number().positive().default(10),
        max_sample_age_seconds: z.number().positive().default(60),
        formal_threshold: z.number().min(0).max(100).default(80),
        early_age_minutes: z.number().nonnegative().default(15),
        early_observe_only: z.boolean().default(true),
        soft_failure_grace_seconds: z.number().nonnegative().max(120).default(60),
        prewatch_hot_capacity: z.number().int().min(0).max(20).default(10),
        prewatch_capacity: z.number().int().min(0).max(60).default(20),
        prewatch_seconds: z.number().positive().default(60),
        prewatch_expiry_minutes: z.number().positive().default(15),
        queue_capacity: z.number().int().positive().default(200),
        queue_concurrency: z.number().int().positive().max(20).default(4)
      })
      .strict()
      .default({}),
    evaluation: z
      .object({
        target_multiples: z.array(z.number().gt(1)).min(1).default([1.3, 1.5, 2, 3]),
        checkpoints_minutes: z.array(z.number().positive()).min(1),
        narrative_checkpoints_minutes: z.array(z.number().positive()),
        unsent_tracking_minutes: z.number().positive(),
        take_profit_percent: percentage,
        stop_loss_percent: percentage
      })
      .strict(),
    storage: z
      .object({
        sqlite_path: z.string().min(1),
        raw_payload_retention_days: z.number().int().nonnegative()
      })
      .strict(),
    logging: z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error']),
        format: z.literal('json')
      })
      .strict()
  })
  .strict();

export class ConfigError extends Error {}

export interface LoadedConfig {
  config: RuntimeConfig;
  revisionId: string;
  sanitizedSnapshot: Record<string, unknown>;
}

export async function loadRuntimeConfig(path: string): Promise<LoadedConfig> {
  await assertSecureConfigPath(path);
  const raw = await readFile(path, 'utf8');
  const parsed = runtimeConfigSchema.safeParse(parse(raw));
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  assertCrossFieldRules(parsed.data);
  const sanitizedSnapshot = redactSecrets(parsed.data) as Record<string, unknown>;
  const revisionId = createHash('sha256').update(JSON.stringify(sanitizedSnapshot)).digest('hex');
  return { config: parsed.data, revisionId, sanitizedSnapshot };
}

export async function assertSecureConfigPath(path: string): Promise<void> {
  const file = await stat(path);
  const directory = await stat(dirname(path));
  if ((file.mode & 0o077) !== 0) throw new ConfigError('config file permissions must be 0600');
  if ((directory.mode & 0o077) !== 0)
    throw new ConfigError('config directory permissions must be 0700');
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretField(key) ? '[REDACTED]' : redactSecrets(item)
      ])
    );
  return value;
}

function isSecretField(key: string): boolean {
  return [
    'api_key',
    'bot_token',
    'private_key',
    'authorization',
    'access_token',
    'refresh_token',
    'secret'
  ].includes(key.toLowerCase());
}

function assertCrossFieldRules(config: z.infer<typeof runtimeConfigSchema>): void {
  if (config.optimization.prewatch_hot_capacity > config.optimization.prewatch_capacity)
    throw new ConfigError('hot prewatch capacity exceeds total');
  if (
    (config.optimization.confirmations - 1) * config.optimization.minimum_spacing_seconds >
    config.optimization.max_sample_age_seconds
  )
    throw new ConfigError('shadow confirmation spacing exceeds sample history');
  if (
    new Set(config.evaluation.target_multiples).size !== config.evaluation.target_multiples.length
  )
    throw new ConfigError('evaluation target multiples must be unique');
  if (
    (config.security.lazy_deep.coordinated_exit.min_snapshot_interval_seconds ?? 10) >
    config.security.lazy_deep.coordinated_exit.max_activity_spread_seconds
  )
    throw new ConfigError('trader snapshot interval exceeds comparison window');
  if (config.gmgn.rate_limit.soft_weight_per_second > config.gmgn.rate_limit.hard_weight_per_second)
    throw new ConfigError('soft GMGN limit cannot exceed hard limit');
  if (config.gmgn.rate_limit.burst_reserve_weight >= config.gmgn.rate_limit.hard_weight_per_second)
    throw new ConfigError('GMGN burst reserve must be below the hard limit');
  if (config.scoring.observation_threshold >= config.scoring.formal_threshold)
    throw new ConfigError('observation threshold must be below formal threshold');
  const signalTypes = [
    ...config.polling.high_frequency_signal_types,
    ...config.polling.narrative_signal_types
  ];
  if (signalTypes.some((type) => [14, 15, 16].includes(type)))
    throw new ConfigError('Signal types 14, 15 and 16 are not supported by GMGN production API');
  if (new Set(signalTypes).size !== signalTypes.length)
    throw new ConfigError('Signal types may only appear in one polling group');
  for (const [name, weights] of Object.entries(config.scoring.route_weights))
    if (Object.values(weights).reduce((sum, value) => sum + value, 0) !== 100)
      throw new ConfigError(`${name} route weights must total 100`);
  if (config.observation.soft_route_target * 3 > config.observation.max_active_episodes)
    throw new ConfigError('route soft targets exceed Episode capacity');
  for (const tier of ['10', '50', '100'] as const)
    if (config.quote.max_round_trip_loss[tier] < config.quote.max_one_way_loss[tier])
      throw new ConfigError(`round trip loss for ${tier} must not be lower than one-way loss`);
}
