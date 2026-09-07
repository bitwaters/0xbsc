-- Additive research schema. Existing signals, snapshots and outcome semantics are untouched.
CREATE TABLE research_runs (
 run_id TEXT PRIMARY KEY, stage TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 manifest_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, cutoff_at_ms INTEGER,
 status TEXT NOT NULL DEFAULT 'ACTIVE', sampling_epoch INTEGER NOT NULL DEFAULT -1, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
);
CREATE TABLE research_facts (
 fact_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, endpoint TEXT NOT NULL,
 chain TEXT NOT NULL CHECK(chain='bsc'), token TEXT, pool_revision TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('legacy_formal','shared_collection','shadow_execution','baseline','outcome')),
 queued_at_ms INTEGER NOT NULL, requested_at_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL,
 semantic_hash TEXT NOT NULL, envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
 payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)), archive_id TEXT,
 CHECK(queued_at_ms<=requested_at_ms AND requested_at_ms<=received_at_ms), UNIQUE(attempt_id,endpoint)
);
CREATE INDEX research_fact_point_in_time ON research_facts(chain,token,received_at_ms);
CREATE TRIGGER research_fact_identity_immutable BEFORE UPDATE OF fact_id,attempt_id,endpoint,chain,token,pool_revision,purpose,queued_at_ms,requested_at_ms,received_at_ms,semantic_hash,envelope_json ON research_facts
BEGIN SELECT RAISE(ABORT,'research fact identity is immutable'); END;
CREATE TRIGGER research_fact_payload_immutable BEFORE UPDATE OF payload_json ON research_facts
WHEN NEW.payload_json IS NOT OLD.payload_json AND NOT (NEW.payload_json IS NULL AND NEW.archive_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'research fact payload is immutable'); END;
CREATE TABLE research_fact_references (
 run_id TEXT NOT NULL REFERENCES research_runs(run_id), fact_id TEXT NOT NULL REFERENCES research_facts(fact_id),
 PRIMARY KEY(run_id,fact_id)
);
CREATE TABLE research_archives (
 archive_id TEXT PRIMARY KEY, path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0), created_at_ms INTEGER NOT NULL
);
CREATE TABLE research_universe (
 chain TEXT NOT NULL, token TEXT NOT NULL, pool_revision TEXT NOT NULL,
 first_seen_at_ms INTEGER NOT NULL, latest_seen_at_ms INTEGER NOT NULL,
 first_event_key TEXT NOT NULL, stratum TEXT NOT NULL, risk_status TEXT NOT NULL DEFAULT 'UNKNOWN',
 PRIMARY KEY(chain,token,pool_revision)
);
CREATE TABLE research_sampling (
 run_id TEXT NOT NULL REFERENCES research_runs(run_id), chain TEXT NOT NULL, token TEXT NOT NULL, pool_revision TEXT NOT NULL,
 sample_key TEXT NOT NULL, stratum TEXT NOT NULL, inclusion_probability REAL NOT NULL CHECK(inclusion_probability>=0 AND inclusion_probability<=1),
 status TEXT NOT NULL CHECK(status IN ('SELECTED','RESOURCE_EXCLUDED')), updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY(run_id,chain,token,pool_revision), FOREIGN KEY(chain,token,pool_revision) REFERENCES research_universe(chain,token,pool_revision)
);
CREATE TABLE market_opportunities (
 opportunity_id TEXT PRIMARY KEY, chain TEXT NOT NULL, token TEXT NOT NULL, pool_revision TEXT NOT NULL,
 model_hash TEXT NOT NULL, activation_fact_id TEXT NOT NULL REFERENCES research_facts(fact_id),
 anchor_price TEXT NOT NULL, anchor_at_ms INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('WATCHING','START_CANDIDATE','READY','CONSUMED','INVALIDATED','MISSED')),
 version INTEGER NOT NULL DEFAULT 0, reason TEXT, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 UNIQUE(chain,token,pool_revision,model_hash,activation_fact_id)
);
CREATE TRIGGER research_opportunity_anchor_immutable BEFORE UPDATE OF chain,token,pool_revision,model_hash,activation_fact_id,anchor_price,anchor_at_ms ON market_opportunities
BEGIN SELECT RAISE(ABORT,'opportunity anchor is immutable'); END;
CREATE TABLE funnel_decisions (
 decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id), opportunity_id TEXT NOT NULL REFERENCES market_opportunities(opportunity_id),
 evaluation_fact_set_hash TEXT NOT NULL, evaluation_at_ms INTEGER NOT NULL, decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),
 UNIQUE(run_id,opportunity_id,evaluation_fact_set_hash)
);
CREATE TRIGGER research_decision_immutable BEFORE UPDATE ON funnel_decisions BEGIN SELECT RAISE(ABORT,'decision is immutable'); END;
CREATE TABLE evaluation_baselines (
 baseline_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id), opportunity_id TEXT NOT NULL REFERENCES market_opportunities(opportunity_id), signal_id TEXT REFERENCES signals(id),
 track TEXT NOT NULL, protocol_hash TEXT NOT NULL, confirmation_at_ms INTEGER, deadline_at_ms INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','VALID','UNVERIFIED','MISSING')), reason TEXT, price TEXT, available_at_ms INTEGER,
 fact_id TEXT REFERENCES research_facts(fact_id), details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
 UNIQUE(run_id,opportunity_id,track,protocol_hash)
);
CREATE TRIGGER research_baseline_identity_immutable BEFORE UPDATE OF run_id,opportunity_id,track,protocol_hash,confirmation_at_ms,deadline_at_ms ON evaluation_baselines
BEGIN SELECT RAISE(ABORT,'baseline identity is immutable'); END;
CREATE TRIGGER research_baseline_terminal_immutable BEFORE UPDATE ON evaluation_baselines WHEN OLD.status!='PENDING'
BEGIN SELECT RAISE(ABORT,'baseline is terminal'); END;
CREATE TABLE research_outcome_tasks (
 task_id TEXT PRIMARY KEY, baseline_id TEXT NOT NULL REFERENCES evaluation_baselines(baseline_id), target TEXT NOT NULL, horizon_at_ms INTEGER NOT NULL,
 task_kind TEXT NOT NULL, due_at_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 status TEXT NOT NULL DEFAULT 'PENDING', result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 UNIQUE(baseline_id,target,horizon_at_ms,task_kind)
);
CREATE TRIGGER research_outcome_coordinates_immutable BEFORE UPDATE OF baseline_id,target,horizon_at_ms,task_kind ON research_outcome_tasks
BEGIN SELECT RAISE(ABORT,'outcome coordinates are immutable'); END;
CREATE TABLE dataset_memberships (
 chain TEXT NOT NULL, token TEXT NOT NULL, use_group TEXT NOT NULL CHECK(use_group IN ('development','selection','final')),
 run_id TEXT NOT NULL REFERENCES research_runs(run_id), dataset_hash TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 PRIMARY KEY(chain,token)
);
CREATE TRIGGER research_dataset_identity_immutable BEFORE UPDATE OF chain,token,use_group,run_id,dataset_hash ON dataset_memberships
BEGIN SELECT RAISE(ABORT,'dataset membership is immutable'); END;
CREATE TABLE promotion_certificates (
 certificate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id), manifest_hash TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), status TEXT NOT NULL CHECK(status IN ('PASS','FAIL','INCONCLUSIVE')), revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE TRIGGER research_certificate_immutable BEFORE UPDATE OF certificate_id,run_id,manifest_hash,evidence_json,status ON promotion_certificates
BEGIN SELECT RAISE(ABORT,'promotion evidence is immutable'); END;
CREATE TABLE research_sampling_history (
 id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id),
 chain TEXT NOT NULL, token TEXT NOT NULL, pool_revision TEXT NOT NULL, stratum TEXT NOT NULL,
 status TEXT NOT NULL, inclusion_probability REAL NOT NULL, observed_at_ms INTEGER NOT NULL
);
CREATE TRIGGER research_sampling_initial AFTER INSERT ON research_sampling BEGIN
 INSERT INTO research_sampling_history(run_id,chain,token,pool_revision,stratum,status,inclusion_probability,observed_at_ms)
 VALUES (NEW.run_id,NEW.chain,NEW.token,NEW.pool_revision,NEW.stratum,NEW.status,NEW.inclusion_probability,NEW.updated_at_ms);
END;
CREATE TRIGGER research_sampling_changed AFTER UPDATE ON research_sampling
WHEN NEW.status!=OLD.status OR NEW.inclusion_probability!=OLD.inclusion_probability BEGIN
 INSERT INTO research_sampling_history(run_id,chain,token,pool_revision,stratum,status,inclusion_probability,observed_at_ms)
 VALUES (NEW.run_id,NEW.chain,NEW.token,NEW.pool_revision,NEW.stratum,NEW.status,NEW.inclusion_probability,NEW.updated_at_ms);
END;
CREATE TABLE research_engine_states (
 run_id TEXT NOT NULL REFERENCES research_runs(run_id), model_hash TEXT NOT NULL,
 token TEXT NOT NULL, pool_revision TEXT NOT NULL, version INTEGER NOT NULL,
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 PRIMARY KEY(run_id,model_hash,token,pool_revision)
);
CREATE TRIGGER research_opportunity_terminal BEFORE UPDATE OF state ON market_opportunities
WHEN OLD.state IN ('CONSUMED','INVALIDATED','MISSED') AND NEW.state!=OLD.state
BEGIN SELECT RAISE(ABORT,'terminal opportunity cannot be revived'); END;
