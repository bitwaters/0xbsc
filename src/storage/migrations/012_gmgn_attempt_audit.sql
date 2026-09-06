CREATE TABLE IF NOT EXISTS api_attempts (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  status INTEGER,
  kind TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_attempts_started_idx ON api_attempts(started_at_ms);
