ALTER TABLE signals ADD COLUMN last_delivery_error TEXT;
ALTER TABLE signals ADD COLUMN delivery_attempted_at_ms INTEGER;
