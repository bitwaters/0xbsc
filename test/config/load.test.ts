import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigError, loadRuntimeConfig, redactSecrets } from '../../src/config/load.js';

const validYaml = `runtime: { chain: bsc, mode: dry_run }
gmgn:
  base_url: https://openapi.gmgn.ai
  api_key: a-secret
  quote_wallet: "0x0000000000000000000000000000000000000001"
  rate_limit: { hard_weight_per_second: 20, soft_weight_per_second: 14, burst_reserve_weight: 6 }
  endpoint_weights: { trending: 1, info: 1, security: 1, pool: 1, smart_money: 1, kol: 1, gas: 1, kline: 2, quote: 2, created_tokens: 2, trenches: 3, hot: 3, market_signal: 3, holders: 5, traders: 5 }
telegram: { bot_token: bot-secret, chat_ids: ["1"], allowed_user_ids: ["2"], buttons: { gmgn_detail: GMGN } }
polling: { jitter_percent: 0.1, high_frequency_signal_seconds: 2, narrative_signal_seconds: 5, trenches_seconds: 5, smart_money_seconds: 2, kol_seconds: 3, trending_seconds: 5, trending_max_rank: 50, rank_change_step: 5, hot_short_seconds: 15, hot_long_seconds: 60, gas_seconds: 30, observation_seconds: 30, high_frequency_signal_types: [1], narrative_signal_types: [2] }
security: { max_buy_tax: 0.05, max_sell_tax: 0.05, max_top10_percent: 0.5, max_team_percent: 0.1, max_entrapment_percent: 0.2, max_bundler_percent: 0.2, max_sniper_percent: 0.2, min_lp_locked_or_burned_percent: 0.8, fatal_flags: [], lazy_deep: { max_single_non_pool_holder_percent: 0.2, max_suspicious_holder_percent: 0.1, max_creator_hold_percent: 0.1, max_creator_created_tokens: 5, min_creator_open_ratio: 0.5, creator_history_max_penalty_points: 5, coordinated_exit: { min_tagged_wallets: 3, min_each_sell_percent: 0.05, min_total_sell_percent: 0.2, recognized_wallet_tags: [smart_money, kol] } } }
strategy: { new_launch_max_age_hours: 24, new_launch_min_liquidity_usd: 10000, revival_min_age_hours: 24, revival_min_liquidity_usd: 20000, continuation_min_liquidity_usd: 30000, dormancy_window_candles: 12, dormancy_max_average_volume_usd: 1000, dormancy_max_average_swaps: 20, revival_baseline_candles: 12, revival_min_absolute_volume_usd: 10000, revival_min_absolute_swaps: 30, revival_volume_multiple: 3, revival_swaps_multiple: 2, breakout_lookback_candles: 12, breakout_minimum_rate: 0, trend_lookback_candles: 12, trend_minimum_growth_rate: 0.1, pullback_max_retrace_rate: 0.25, pullback_max_volume_ratio: 0.8, restart_minimum_volume_ratio: 1.5, vertical_pump_window_candles: 3, vertical_pump_maximum_growth_rate: 0.5 }
evidence: { ttl_seconds: { lifecycle: 600, structure: 180, capital: 300, attention: 600, narrative: 1800 } }
scoring:
  observation_threshold: 65
  formal_threshold: 80
  min_completeness: 0.7
  data_ttl_seconds: { info: 30, pool: 30, kline: 60, traders: 180, holders: 300, creator: 3600 }
  route_weights:
    new_launch: { lifecycle: 20, structure: 25, capital: 25, attention: 15, quality: 10, freshness: 5 }
    revival: { lifecycle: 5, structure: 30, capital: 30, attention: 20, quality: 10, freshness: 5 }
    continuation: { lifecycle: 0, structure: 40, capital: 30, attention: 10, quality: 10, freshness: 10 }
  decisive_trigger_seconds: { new_launch: 90, revival: 120, continuation: 60 }
observation: { max_active_episodes: 60, soft_route_target: 20, expiry_minutes: { new_launch: 15 } }
quote:
  position_usd: [10, 50, 100]
  max_slippage_percent: 0.05
  max_one_way_loss: { "10": 0.02, "50": 0.03, "100": 0.05 }
  max_round_trip_loss: { "10": 0.05, "50": 0.06, "100": 0.08 }
  retry_minimum_seconds: 30
  material_price_change_percent: 0.05
  material_liquidity_change_percent: 0.1
  security_pool_max_age_seconds: 30
  max_age_seconds: 5
evaluation: { checkpoints_minutes: [1], narrative_checkpoints_minutes: [], unsent_tracking_minutes: 60, take_profit_percent: 0.3, stop_loss_percent: 0.1 }
storage: { sqlite_path: /tmp/test.db, raw_payload_retention_days: 7 }
logging: { level: info, format: json }
`;

async function configFile(contents = validYaml): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-config-'));
  const path = join(directory, 'config.yaml');
  await chmod(directory, 0o700);
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
  return { directory, path };
}

void test('loads BSC-only config and produces a secret-free revision', async () => {
  const fixture = await configFile();
  try {
    const loaded = await loadRuntimeConfig(fixture.path);
    assert.equal(loaded.config.runtime.chain, 'bsc');
    assert.match(JSON.stringify(loaded.sanitizedSnapshot), /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(loaded.sanitizedSnapshot), /a-secret|bot-secret/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('rejects unsafe permissions and unsupported Signal types', async () => {
  const fixture = await configFile(
    validYaml.replace('high_frequency_signal_types: [1]', 'high_frequency_signal_types: [14]')
  );
  try {
    await assert.rejects(
      loadRuntimeConfig(fixture.path),
      (error: unknown) => error instanceof ConfigError && /14/.test(error.message)
    );
    await writeFile(fixture.path, validYaml);
    await chmod(fixture.path, 0o644);
    await assert.rejects(loadRuntimeConfig(fixture.path), /0600/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('rejects invalid limits, route weights, and quote tiers', async () => {
  const variants = [
    validYaml.replace('soft_weight_per_second: 14', 'soft_weight_per_second: 21'),
    validYaml.replace('lifecycle: 20, structure: 25', 'lifecycle: 19, structure: 25'),
    validYaml.replace('position_usd: [10, 50, 100]', 'position_usd: [10, 25, 100]'),
    validYaml.replace('max_buy_tax: 0.05', 'max_buy_tax: 1.05'),
    validYaml.replace('buttons: { gmgn_detail: GMGN }', 'buttons: { refresh: Refresh }'),
    validYaml.replace(
      'creator_history_max_penalty_points: 5',
      'creator_history_max_penalty_points: 5.1'
    ),
    validYaml.replace(
      'logging: { level: info, format: json }',
      'logging: { level: info, format: json, typo: true }'
    )
  ];
  for (const variant of variants) {
    const fixture = await configFile(variant);
    try {
      await assert.rejects(loadRuntimeConfig(fixture.path));
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

void test('redacts nested secret-bearing values', () => {
  assert.deepEqual(
    redactSecrets({
      api_key: 'x',
      nested: { bot_token: 'y', safe: 2, created_tokens: 2, max_creator_created_tokens: 5 }
    }),
    {
      api_key: '[REDACTED]',
      nested: {
        bot_token: '[REDACTED]',
        safe: 2,
        created_tokens: 2,
        max_creator_created_tokens: 5
      }
    }
  );
});

void test('configuration revisions retain non-secret token-named settings', async () => {
  const first = await configFile(validYaml);
  const changed = await configFile(validYaml.replace('created_tokens: 2', 'created_tokens: 3'));
  try {
    const firstLoaded = await loadRuntimeConfig(first.path);
    const changedLoaded = await loadRuntimeConfig(changed.path);
    assert.notEqual(firstLoaded.revisionId, changedLoaded.revisionId);
    assert.match(JSON.stringify(firstLoaded.sanitizedSnapshot), /"created_tokens":2/);
  } finally {
    await rm(first.directory, { recursive: true, force: true });
    await rm(changed.directory, { recursive: true, force: true });
  }
});

const validEnv = `RUNTIME_MODE=live
GMGN_API_KEY='env-secret#$literal'
GMGN_QUOTE_WALLET=0x0000000000000000000000000000000000000002
TELEGRAM_BOT_TOKEN=env-bot-secret
TELEGRAM_CHAT_IDS=-100123, -100456
TELEGRAM_ALLOWED_USER_IDS=123,456
`;

void test('credential file overrides YAML, preserves literal secrets and redacts merged history', async () => {
  const fixture = await configFile();
  try {
    await writeFile(join(fixture.directory, '.env'), validEnv, { mode: 0o600 });
    const loaded = await loadRuntimeConfig(fixture.path);
    assert.equal(loaded.config.runtime.mode, 'live');
    assert.equal(loaded.config.gmgn.api_key, 'env-secret#$literal');
    assert.equal(loaded.config.gmgn.quote_wallet, '0x0000000000000000000000000000000000000002');
    assert.equal(loaded.config.telegram.bot_token, 'env-bot-secret');
    assert.deepEqual(loaded.config.telegram.chat_ids, ['-100123', '-100456']);
    assert.deepEqual(loaded.config.telegram.allowed_user_ids, ['123', '456']);
    assert.doesNotMatch(JSON.stringify(loaded.sanitizedSnapshot), /env-secret|env-bot-secret/);
    await writeFile(
      join(fixture.directory, '.env'),
      validEnv.replace('env-bot-secret', 'rotated-secret')
    );
    assert.equal((await loadRuntimeConfig(fixture.path)).revisionId, loaded.revisionId);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('incomplete credential files fail closed without exposing invalid values', async () => {
  const fixture = await configFile();
  try {
    for (const contents of [
      validEnv.replace("GMGN_API_KEY='env-secret#$literal'", 'GMGN_API_KEY='),
      validEnv.replace('TELEGRAM_CHAT_IDS=-100123, -100456', 'TELEGRAM_CHAT_IDS=-100123,'),
      validEnv.replace('TELEGRAM_ALLOWED_USER_IDS=123,456', 'TELEGRAM_ALLOWED_USER_IDS=-123'),
      validEnv.replace('RUNTIME_MODE=live', 'RUNTIME_MODE=secret-in-invalid-field'),
      `${validEnv}\nUNSUPPORTED_FIELD=secret-in-invalid-field`,
      validEnv.replace('0x0000000000000000000000000000000000000002', 'secret-in-invalid-field')
    ]) {
      await writeFile(join(fixture.directory, '.env'), contents, { mode: 0o600 });
      await assert.rejects(loadRuntimeConfig(fixture.path), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /Invalid or missing .env fields/);
        assert.doesNotMatch(error.message, /secret-in-invalid-field|env-secret|env-bot-secret/);
        return true;
      });
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('credential file requires restricted permissions and an empty file preserves YAML', async () => {
  const fixture = await configFile();
  try {
    const envPath = join(fixture.directory, '.env');
    await writeFile(envPath, validEnv, { mode: 0o644 });
    await chmod(envPath, 0o644);
    await assert.rejects(loadRuntimeConfig(fixture.path), /0600/);
    await chmod(envPath, 0o600);
    await writeFile(envPath, '# use existing YAML credentials\n');
    assert.equal((await loadRuntimeConfig(fixture.path)).config.gmgn.api_key, 'a-secret');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('unconfigured YAML placeholders refuse startup before opening the database', async () => {
  const fixture = await configFile(validYaml.replace('a-secret', 'REPLACE_ME'));
  try {
    await assert.rejects(loadRuntimeConfig(fixture.path), /must be configured before startup/);
    await writeFile(join(fixture.directory, '.env'), validEnv, { mode: 0o600 });
    assert.equal(
      (await loadRuntimeConfig(fixture.path)).config.gmgn.api_key,
      'env-secret#$literal'
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
