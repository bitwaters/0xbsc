CREATE TABLE IF NOT EXISTS operation_traces (
  id INTEGER PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS operation_traces_correlation_idx
  ON operation_traces(correlation_id, occurred_at_ms, id);
