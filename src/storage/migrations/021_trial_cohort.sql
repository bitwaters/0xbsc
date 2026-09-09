-- Diagnostic selection is independent of eligibility for formal publication.
CREATE TABLE research_trial_cohorts (
 cohort_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id),
 token TEXT NOT NULL, pool_revision TEXT NOT NULL, decision_at_ms INTEGER NOT NULL,
 baseline_id TEXT REFERENCES evaluation_baselines(baseline_id),
 status TEXT NOT NULL CHECK(status IN ('SELECTED','RESOURCE_EXCLUDED')),
 screen_json TEXT NOT NULL CHECK(json_valid(screen_json)),
 risk_json TEXT NOT NULL CHECK(json_valid(risk_json)),
 UNIQUE(run_id,token,pool_revision)
);
CREATE INDEX research_trial_cohort_run ON research_trial_cohorts(run_id,decision_at_ms);
