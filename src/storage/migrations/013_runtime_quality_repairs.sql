-- Keep legacy delivery_state and original error text for history/rollback compatibility.
ALTER TABLE signals ADD COLUMN delivery_failure_kind TEXT
  CHECK (delivery_failure_kind IN ('pre_send_cancelled','preparation_failed','telegram_failed'));
UPDATE signals SET delivery_failure_kind = CASE
  WHEN last_delivery_error GLOB 'pre_send_*' THEN 'pre_send_cancelled'
  WHEN last_delivery_error GLOB 'preparation_failed:*' THEN 'preparation_failed'
  ELSE 'telegram_failed' END
WHERE delivery_state='SEND_FAILED';

ALTER TABLE price_samples ADD COLUMN path_capture_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE price_samples ADD COLUMN initial_checkpoint_json TEXT;
