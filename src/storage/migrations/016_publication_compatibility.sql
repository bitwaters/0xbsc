ALTER TABLE signals ADD COLUMN decision_format TEXT NOT NULL DEFAULT 'legacy-v1';
ALTER TABLE signals ADD COLUMN publisher_version TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE publisher_leases (
 name TEXT PRIMARY KEY CHECK(name='telegram'), owner TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
);
CREATE TABLE publication_token_locks (
 chain TEXT NOT NULL, token TEXT NOT NULL, signal_id TEXT NOT NULL REFERENCES signals(id),
 state TEXT NOT NULL CHECK(state IN ('SENT','UNKNOWN')), locked_at_ms INTEGER NOT NULL,
 PRIMARY KEY(chain,token)
);
INSERT OR IGNORE INTO publication_token_locks(chain,token,signal_id,state,locked_at_ms)
SELECT e.chain,e.token_address,s.id,CASE WHEN s.delivery_state='SENT' THEN 'SENT' ELSE 'UNKNOWN' END,s.updated_at_ms
FROM signals s JOIN episodes e ON e.id=s.episode_id WHERE s.delivery_state IN ('SENT','DELIVERY_UNKNOWN') ORDER BY s.updated_at_ms DESC;
CREATE TRIGGER publication_confirmation_lock AFTER UPDATE OF delivery_state ON signals WHEN NEW.delivery_state IN ('SENT','DELIVERY_UNKNOWN')
BEGIN
 INSERT INTO publication_token_locks(chain,token,signal_id,state,locked_at_ms)
 SELECT chain,token_address,NEW.id,CASE WHEN NEW.delivery_state='SENT' THEN 'SENT' ELSE 'UNKNOWN' END,NEW.updated_at_ms FROM episodes WHERE id=NEW.episode_id
 ON CONFLICT(chain,token) DO UPDATE SET state=CASE WHEN NEW.delivery_state='SENT' THEN 'SENT' ELSE publication_token_locks.state END;
END;
CREATE TRIGGER publication_format_immutable BEFORE UPDATE OF decision_format,publisher_version ON signals
BEGIN SELECT RAISE(ABORT,'publication format is immutable'); END;
