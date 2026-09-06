-- Cancel only obsolete message edits. Price-path/quote tracking stays active.
UPDATE price_samples SET status='CANCELLED'
WHERE task_kind LIKE 'telegram_edit_%' AND status='PENDING';

CREATE TABLE signal_delivery_snapshots (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES signals(id),
  request_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  quote_snapshot_json TEXT NOT NULL
);
ALTER TABLE signals ADD COLUMN confirmed_snapshot_id TEXT REFERENCES signal_delivery_snapshots(id);
-- Historical edited messages have no trustworthy original payload; never fabricate one.
CREATE TRIGGER delivery_snapshot_no_update BEFORE UPDATE ON signal_delivery_snapshots
BEGIN SELECT RAISE(ABORT,'delivery snapshot is immutable'); END;
CREATE TRIGGER delivery_snapshot_no_delete BEFORE DELETE ON signal_delivery_snapshots
BEGIN SELECT RAISE(ABORT,'delivery snapshot is immutable'); END;
CREATE TRIGGER confirmed_snapshot_no_change BEFORE UPDATE OF confirmed_snapshot_id ON signals
WHEN OLD.confirmed_snapshot_id IS NOT NULL AND NEW.confirmed_snapshot_id IS NOT OLD.confirmed_snapshot_id
BEGIN SELECT RAISE(ABORT,'confirmed delivery snapshot is immutable'); END;
CREATE TRIGGER no_new_telegram_edits BEFORE INSERT ON price_samples
WHEN NEW.task_kind LIKE 'telegram_edit_%'
BEGIN SELECT RAISE(ABORT,'original signal cards cannot be edited'); END;
CREATE TRIGGER no_revive_telegram_edits BEFORE UPDATE OF status ON price_samples
WHEN NEW.task_kind LIKE 'telegram_edit_%' AND NEW.status='PENDING'
BEGIN SELECT RAISE(ABORT,'original signal cards cannot be edited'); END;
CREATE TRIGGER sent_market_snapshot_no_change BEFORE UPDATE OF decision_json,quote_snapshot_json ON signals
WHEN OLD.delivery_state='SENT' AND (
 json_extract(NEW.decision_json,'$.presentation') IS NOT json_extract(OLD.decision_json,'$.presentation') OR
 json_extract(NEW.decision_json,'$.marketEntryPriceUsd') IS NOT json_extract(OLD.decision_json,'$.marketEntryPriceUsd') OR
 json_extract(NEW.decision_json,'$.marketEntryAtMs') IS NOT json_extract(OLD.decision_json,'$.marketEntryAtMs') OR
 NEW.quote_snapshot_json IS NOT OLD.quote_snapshot_json)
BEGIN SELECT RAISE(ABORT,'sent market snapshot is immutable'); END;
