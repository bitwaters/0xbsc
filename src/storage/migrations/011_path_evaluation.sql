-- Keep historical rows untouched in value; their original timing/entry is not trustworthy.
ALTER TABLE episodes ADD COLUMN evaluation_entry_at_ms INTEGER;
ALTER TABLE episodes ADD COLUMN evaluation_entry_price TEXT;
ALTER TABLE episodes ADD COLUMN soft_failure_since_ms INTEGER;
CREATE TABLE price_samples_v2 (
 id INTEGER PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id),
 signal_id TEXT REFERENCES signals(id), task_kind TEXT NOT NULL, due_at_ms INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING', requested_at_ms INTEGER, completed_at_ms INTEGER,
 data_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
 entry_at_ms INTEGER, target_at_ms INTEGER, next_attempt_at_ms INTEGER,
 entry_market_price TEXT, evaluation_revision_id TEXT, evaluation_policy_json TEXT, horizon_at_ms INTEGER, quality_version TEXT NOT NULL DEFAULT 'path-v2'
);
INSERT INTO price_samples_v2
 (id,episode_id,signal_id,task_kind,due_at_ms,status,requested_at_ms,completed_at_ms,data_json,created_at_ms,updated_at_ms,quality_version)
 SELECT id,episode_id,signal_id,task_kind,due_at_ms,status,requested_at_ms,completed_at_ms,data_json,created_at_ms,updated_at_ms,'legacy'
 FROM price_samples;
DROP TABLE price_samples;
ALTER TABLE price_samples_v2 RENAME TO price_samples;
CREATE UNIQUE INDEX price_samples_unsent_identity ON price_samples(episode_id,task_kind) WHERE signal_id IS NULL AND task_kind LIKE 'outcome_%';
CREATE UNIQUE INDEX price_samples_formal_identity ON price_samples(signal_id,task_kind) WHERE signal_id IS NOT NULL AND task_kind LIKE 'outcome_%';
CREATE INDEX price_samples_due_idx ON price_samples(status,COALESCE(next_attempt_at_ms,target_at_ms,due_at_ms));
-- Freeze sample coordinates once. Later rejections/edits/retries cannot change them.
CREATE TRIGGER freeze_outcome_coordinates AFTER INSERT ON price_samples
WHEN NEW.task_kind LIKE 'outcome_%'
BEGIN
 UPDATE price_samples SET
 evaluation_revision_id = (SELECT config_revision_id FROM episodes WHERE id=NEW.episode_id),
 evaluation_policy_json = (SELECT json_extract(sanitized_snapshot_json,'$.evaluation') FROM config_revisions WHERE revision_id=(SELECT config_revision_id FROM episodes WHERE id=NEW.episode_id)),
 entry_at_ms = COALESCE((SELECT CASE WHEN NEW.signal_id IS NULL THEN evaluation_entry_at_ms ELSE NULL END FROM episodes WHERE id=NEW.episode_id),NEW.due_at_ms - CAST(substr(NEW.task_kind,9) AS INTEGER)*60000),
 target_at_ms = COALESCE((SELECT CASE WHEN NEW.signal_id IS NULL THEN evaluation_entry_at_ms ELSE NULL END FROM episodes WHERE id=NEW.episode_id),NEW.due_at_ms - CAST(substr(NEW.task_kind,9) AS INTEGER)*60000) + CAST(substr(NEW.task_kind,9) AS INTEGER)*60000,
 entry_market_price = CASE WHEN NEW.signal_id IS NULL
 THEN (SELECT evaluation_entry_price FROM episodes WHERE id=NEW.episode_id)
 ELSE (SELECT json_extract(decision_json,'$.marketEntryPriceUsd') FROM signals WHERE id=NEW.signal_id) END
 WHERE id=NEW.id;
END;
CREATE TABLE candidate_watches (
 token_address TEXT PRIMARY KEY, event_json TEXT NOT NULL, first_seen_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL, next_evaluation_at_ms INTEGER NOT NULL,
 priority INTEGER NOT NULL DEFAULT 0, last_reason TEXT NOT NULL, snapshot_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE shadow_decisions (
 id INTEGER PRIMARY KEY, token_address TEXT NOT NULL, episode_id TEXT, observed_at_ms INTEGER NOT NULL,
 config_revision_id TEXT NOT NULL, decision_json TEXT NOT NULL
);
CREATE INDEX shadow_token_time ON shadow_decisions(token_address,observed_at_ms);
CREATE INDEX traces_retention_time ON operation_traces(occurred_at_ms);

CREATE UNIQUE INDEX price_samples_other_identity ON price_samples(episode_id,task_kind,due_at_ms) WHERE task_kind NOT LIKE 'outcome_%';
