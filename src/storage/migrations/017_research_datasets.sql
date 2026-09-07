CREATE TABLE research_datasets (
 dataset_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id),
 use_group TEXT NOT NULL CHECK(use_group IN ('development','selection','final')),
 start_at_ms INTEGER NOT NULL, cutoff_at_ms INTEGER NOT NULL, frozen_at_ms INTEGER NOT NULL,
 manifest_hash TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 CHECK(start_at_ms<cutoff_at_ms AND cutoff_at_ms<=frozen_at_ms)
);
CREATE TRIGGER research_dataset_manifest_immutable BEFORE UPDATE OF dataset_id,run_id,use_group,start_at_ms,cutoff_at_ms,frozen_at_ms,manifest_hash,manifest_json ON research_datasets
BEGIN SELECT RAISE(ABORT,'dataset manifest is immutable'); END;
CREATE TRIGGER research_dataset_consumption_monotonic BEFORE UPDATE OF consumed ON research_datasets WHEN OLD.consumed=1 AND NEW.consumed!=1
BEGIN SELECT RAISE(ABORT,'dataset consumption cannot be reset'); END;
CREATE TRIGGER research_membership_consumption_monotonic BEFORE UPDATE OF consumed ON dataset_memberships WHEN OLD.consumed=1 AND NEW.consumed!=1
BEGIN SELECT RAISE(ABORT,'membership consumption cannot be reset'); END;
CREATE TRIGGER research_run_manifest_immutable BEFORE UPDATE OF run_id,stage,manifest_json,manifest_hash,created_at_ms,cutoff_at_ms ON research_runs
BEGIN SELECT RAISE(ABORT,'run protocol is immutable'); END;
