ALTER TABLE signals ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE signals ADD COLUMN telegram_tracking_stopped INTEGER NOT NULL DEFAULT 0 CHECK (telegram_tracking_stopped IN (0, 1));
ALTER TABLE signals ADD COLUMN telegram_deleted INTEGER NOT NULL DEFAULT 0 CHECK (telegram_deleted IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS signals_telegram_message_idx
  ON signals(telegram_chat_id, telegram_message_id)
  WHERE telegram_chat_id IS NOT NULL AND telegram_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_actions (
  id INTEGER PRIMARY KEY,
  signal_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('copy', 'refresh', 'bought', 'stop', 'delete')),
  user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (signal_id) REFERENCES signals(id),
  UNIQUE(signal_id, action, user_id)
);
