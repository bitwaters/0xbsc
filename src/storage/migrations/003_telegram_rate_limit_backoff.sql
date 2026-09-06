ALTER TABLE signals ADD COLUMN next_delivery_attempt_at_ms INTEGER;

CREATE INDEX signals_pending_attempt_idx
  ON signals(delivery_state, next_delivery_attempt_at_ms, created_at_ms)
  WHERE delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN');
