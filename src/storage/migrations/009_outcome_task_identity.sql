DELETE FROM price_samples
WHERE task_kind LIKE 'outcome_%'
  AND id NOT IN (
    SELECT id
    FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY episode_id, task_kind
               ORDER BY
                 CASE status WHEN 'COMPLETE' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
                 completed_at_ms DESC,
                 id ASC
             ) AS row_number
      FROM price_samples
      WHERE task_kind LIKE 'outcome_%'
    ) ranked
    WHERE row_number = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS price_samples_one_outcome_checkpoint_idx
  ON price_samples(episode_id, task_kind)
  WHERE task_kind LIKE 'outcome_%';
