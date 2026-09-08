-- Bound maintenance to expired rows and indexed per-token recovery lookups.
CREATE INDEX events_retention_time ON events(observed_at_ms);
CREATE INDEX events_retention_recovery ON events(chain,token_address,source,poll_key,id);
CREATE INDEX episodes_retention_token ON episodes(chain,token_address);
