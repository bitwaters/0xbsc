CREATE TABLE research_baseline_attempts (
 baseline_id TEXT NOT NULL REFERENCES evaluation_baselines(baseline_id), ordinal INTEGER NOT NULL,
 reserved_at_ms INTEGER NOT NULL, PRIMARY KEY(baseline_id,ordinal)
);
CREATE TRIGGER research_baseline_attempt_immutable BEFORE UPDATE ON research_baseline_attempts
BEGIN SELECT RAISE(ABORT,'baseline attempt is immutable'); END;
CREATE TABLE research_capture_ranges (
 cache_key TEXT PRIMARY KEY, chain TEXT NOT NULL, token TEXT NOT NULL, pool_revision TEXT NOT NULL,
 from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL,
 fact_id TEXT NOT NULL REFERENCES research_facts(fact_id),
 CHECK(from_ms<to_ms)
);
CREATE TRIGGER research_capture_range_immutable BEFORE UPDATE ON research_capture_ranges
BEGIN SELECT RAISE(ABORT,'capture range is immutable'); END;
CREATE TABLE research_registrations (
 registration_id TEXT PRIMARY KEY, kind TEXT NOT NULL, dataset_hash TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL, manifest_hash TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json))
);
CREATE TRIGGER research_registration_immutable BEFORE UPDATE ON research_registrations
BEGIN SELECT RAISE(ABORT,'research registration is immutable'); END;
CREATE TABLE research_quote_exits (
 exit_id TEXT PRIMARY KEY, baseline_id TEXT NOT NULL REFERENCES evaluation_baselines(baseline_id),
 observation_at_ms INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
 UNIQUE(baseline_id,kind)
);
CREATE TRIGGER research_exit_coordinates_immutable BEFORE UPDATE OF baseline_id,observation_at_ms,kind ON research_quote_exits
BEGIN SELECT RAISE(ABORT,'quote exit coordinates are immutable'); END;
CREATE TRIGGER research_exit_terminal_immutable BEFORE UPDATE ON research_quote_exits WHEN OLD.status IN ('DONE','RESOURCE_EXCLUDED')
BEGIN SELECT RAISE(ABORT,'quote exit is terminal'); END;
