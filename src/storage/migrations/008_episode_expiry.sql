ALTER TABLE episodes ADD COLUMN expires_at_ms INTEGER;
CREATE INDEX IF NOT EXISTS episodes_observation_expiry_idx
  ON episodes(state, expires_at_ms) WHERE state = 'OBSERVING' AND ended_at_ms IS NULL;
