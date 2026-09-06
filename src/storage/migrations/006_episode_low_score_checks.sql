ALTER TABLE episodes ADD COLUMN low_score_checks INTEGER NOT NULL DEFAULT 0 CHECK (low_score_checks >= 0);
