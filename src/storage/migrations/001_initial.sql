CREATE TABLE IF NOT EXISTS tokens (
  chain TEXT NOT NULL CHECK (chain = 'bsc'),
  address TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  created_at_ms INTEGER,
  first_seen_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS config_revisions (
  revision_id TEXT PRIMARY KEY,
  sanitized_snapshot_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  chain TEXT NOT NULL CHECK (chain = 'bsc'),
  token_address TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT,
  poll_key TEXT,
  snapshot_hash TEXT,
  snapshot_sequence INTEGER,
  source_event_at_ms INTEGER,
  observed_at_ms INTEGER NOT NULL,
  evidence_family TEXT NOT NULL,
  strength TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  raw_payload_ref TEXT,
  normalized_json TEXT NOT NULL,
  FOREIGN KEY (chain, token_address) REFERENCES tokens(chain, address)
);
CREATE INDEX IF NOT EXISTS events_token_observed_idx ON events(chain, token_address, observed_at_ms DESC);
CREATE UNIQUE INDEX IF NOT EXISTS events_snapshot_sequence_idx
  ON events(source, poll_key, token_address, snapshot_sequence)
  WHERE poll_key IS NOT NULL AND snapshot_sequence IS NOT NULL;

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL CHECK (chain = 'bsc'),
  token_address TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('new_launch', 'revival', 'continuation')),
  state TEXT NOT NULL,
  score REAL,
  completeness REAL,
  config_revision_id TEXT NOT NULL,
  feature_snapshot_json TEXT NOT NULL DEFAULT '{}',
  rejection_reason TEXT,
  decisive_trigger_at_ms INTEGER,
  next_evaluation_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  FOREIGN KEY (chain, token_address) REFERENCES tokens(chain, address),
  FOREIGN KEY (config_revision_id) REFERENCES config_revisions(revision_id)
);
CREATE INDEX IF NOT EXISTS episodes_active_due_idx ON episodes(state, next_evaluation_at_ms)
  WHERE ended_at_ms IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS episodes_one_active_route_idx ON episodes(chain, token_address, route)
  WHERE ended_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL UNIQUE,
  config_revision_id TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('PENDING', 'SENT', 'SEND_FAILED', 'DELIVERY_UNKNOWN')),
  quote_snapshot_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  telegram_message_id TEXT,
  telegram_confirmed_at_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  possible_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (possible_duplicate IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(id),
  FOREIGN KEY (config_revision_id) REFERENCES config_revisions(revision_id)
);
CREATE INDEX IF NOT EXISTS signals_outbox_idx ON signals(delivery_state, created_at_ms)
  WHERE delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN');

CREATE TABLE IF NOT EXISTS price_samples (
  id INTEGER PRIMARY KEY,
  episode_id TEXT NOT NULL,
  signal_id TEXT,
  task_kind TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_at_ms INTEGER,
  completed_at_ms INTEGER,
  data_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(id),
  FOREIGN KEY (signal_id) REFERENCES signals(id),
  UNIQUE (episode_id, task_kind, due_at_ms)
);
CREATE INDEX IF NOT EXISTS price_samples_due_idx ON price_samples(status, due_at_ms)
  WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS api_stats (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL,
  minute_at_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  weight_sum INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  latency_samples_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (endpoint, minute_at_ms)
);
