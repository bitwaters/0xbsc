ALTER TABLE api_stats ADD COLUMN status_counts_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS api_failures (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  status INTEGER,
  kind TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_failures_endpoint_time_idx ON api_failures(endpoint, occurred_at_ms DESC);
