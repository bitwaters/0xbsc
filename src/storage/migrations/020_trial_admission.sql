-- Bounded operational state; historical decisions, cards and publication locks remain untouched.
CREATE TABLE trial_risk_rejections (
 risk_hash TEXT NOT NULL, token TEXT NOT NULL, pool_revision TEXT NOT NULL,
 reason TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)),
 PRIMARY KEY(risk_hash,token,pool_revision)
);
CREATE INDEX trial_risk_rejections_expiry ON trial_risk_rejections(expires_at_ms);
CREATE TABLE trial_runtime_checkpoints (
 state_key TEXT PRIMARY KEY, updated_at_ms INTEGER NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json))
);
