import type { ShadowPolicy } from '../decision/shadow.js';

export type RouteName = 'new_launch' | 'revival' | 'continuation';

export interface RuntimeConfig {
  research?: { mode: 'off' | 'observe'; run_id: string; max_storage_bytes: number } | undefined;
  optimization: ShadowPolicy;
  runtime: { chain: 'bsc'; mode: 'dry_run' | 'live' };
  gmgn: {
    base_url: string;
    api_key: string;
    quote_wallet: string;
    rate_limit: {
      hard_weight_per_second: number;
      soft_weight_per_second: number;
      burst_reserve_weight: number;
      max_in_flight?: number;
      quote_min_interval_ms?: number;
      quote_completion_gap_ms?: number;
      missing_reset_delay_seconds?: number;
    };
    endpoint_weights: Record<string, number>;
  };
  telegram: {
    bot_token: string;
    chat_ids: string[];
    allowed_user_ids: string[];
    buttons: Record<string, string>;
  };
  polling: {
    jitter_percent: number;
    high_frequency_signal_seconds: number;
    narrative_signal_seconds: number;
    trenches_seconds: number;
    smart_money_seconds: number;
    kol_seconds: number;
    trending_seconds: number;
    trending_max_rank: number;
    rank_change_step: number;
    hot_short_seconds: number;
    hot_long_seconds: number;
    gas_seconds: number;
    observation_seconds: number;
    high_frequency_signal_types: number[];
    narrative_signal_types: number[];
  };
  security: {
    max_buy_tax: number;
    max_sell_tax: number;
    max_top10_percent: number;
    max_team_percent: number;
    max_entrapment_percent: number;
    max_bundler_percent: number;
    max_sniper_percent: number;
    min_lp_locked_or_burned_percent: number;
    fatal_flags: string[];
    lazy_deep: {
      max_single_non_pool_holder_percent: number;
      max_suspicious_holder_percent: number;
      max_creator_hold_percent: number;
      max_creator_created_tokens: number;
      min_creator_open_ratio: number;
      creator_history_max_penalty_points: number;
      coordinated_exit: {
        min_snapshot_interval_seconds?: number;
        min_tagged_wallets: number;
        min_each_sell_percent: number;
        min_total_sell_percent: number;
        max_activity_age_seconds: number;
        max_activity_spread_seconds: number;
        recognized_wallet_tags: string[];
      };
    };
  };
  strategy: {
    new_launch_max_age_hours: number;
    new_launch_min_liquidity_usd: number;
    revival_min_age_hours: number;
    revival_min_liquidity_usd: number;
    continuation_min_liquidity_usd: number;
    dormancy_window_candles: number;
    dormancy_max_average_volume_usd: number;
    dormancy_max_average_swaps: number;
    revival_baseline_candles: number;
    revival_min_absolute_volume_usd: number;
    revival_min_absolute_swaps: number;
    revival_volume_multiple: number;
    revival_swaps_multiple: number;
    breakout_lookback_candles: number;
    breakout_minimum_rate: number;
    trend_lookback_candles: number;
    trend_minimum_growth_rate: number;
    pullback_max_retrace_rate: number;
    pullback_max_volume_ratio: number;
    restart_minimum_volume_ratio: number;
    vertical_pump_window_candles: number;
    vertical_pump_maximum_growth_rate: number;
  };
  evidence: {
    ttl_seconds: {
      lifecycle: number;
      structure: number;
      capital: number;
      attention: number;
      narrative: number;
    };
  };
  scoring: {
    observation_threshold: number;
    formal_threshold: number;
    min_completeness: number;
    data_ttl_seconds: {
      info: number;
      pool: number;
      kline: number;
      traders: number;
      holders: number;
      creator: number;
    };
    route_weights: Record<RouteName, Record<string, number>>;
    decisive_trigger_seconds: Record<RouteName, number>;
  };
  observation: {
    max_active_episodes: number;
    soft_route_target: number;
    expiry_minutes: Record<string, number>;
  };
  quote: {
    position_usd: [number, number, number];
    max_slippage_percent: number;
    max_one_way_loss: Record<'10' | '50' | '100', number>;
    max_round_trip_loss: Record<'10' | '50' | '100', number>;
    retry_minimum_seconds: number;
    material_price_change_percent: number;
    material_liquidity_change_percent: number;
    security_pool_max_age_seconds: number;
    max_age_seconds: number;
  };
  evaluation: {
    target_multiples: number[];
    checkpoints_minutes: number[];
    narrative_checkpoints_minutes: number[];
    unsent_tracking_minutes: number;
    path_max_capture_attempts?: number;
    path_retry_seconds?: number;
    path_max_gap_requests?: number;
    take_profit_percent: number;
    stop_loss_percent: number;
  };
  storage: { sqlite_path: string; raw_payload_retention_days: number };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; format: 'json' };
}
