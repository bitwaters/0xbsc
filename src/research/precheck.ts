import type { SqliteDatabase } from '../storage/database.js';
import { PUBLICATION_COMPATIBILITY } from '../delivery/publication-guard.js';

export function deploymentPrecheck(db: SqliteDatabase, nowMs: number, targetCompatibility: string) {
  const hasLocks = Boolean(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='publication_token_locks'").get()
  );
  if (!hasLocks) return { status: 'BLOCKED', reason: 'COMPATIBILITY_MIGRATION_REQUIRED' };
  const lease = db
    .prepare("SELECT expires_at_ms FROM publisher_leases WHERE name='telegram'")
    .get() as { expires_at_ms: number } | undefined;
  const pending = db
    .prepare(
      "SELECT decision_format,delivery_state,COUNT(*) AS count FROM signals WHERE delivery_state IN ('PENDING','DELIVERY_UNKNOWN') GROUP BY decision_format,delivery_state"
    )
    .all();
  const locks = db
    .prepare('SELECT state,COUNT(*) AS count FROM publication_token_locks GROUP BY state')
    .all();
  const queued = db
    .prepare("SELECT COUNT(*) AS n FROM signals WHERE delivery_state='PENDING'")
    .get() as { n: number };
  return {
    status:
      targetCompatibility !== PUBLICATION_COMPATIBILITY
        ? 'BLOCKED'
        : lease && lease.expires_at_ms > nowMs
          ? 'DRAIN_REQUIRED'
          : queued.n
            ? 'DRAIN_REQUIRED'
            : 'READY',
    targetCompatibility,
    requiredCompatibility: PUBLICATION_COMPATIBILITY,
    pending,
    locks,
    databaseRollback: 'FORBIDDEN',
    unknownLocksMustRemain: true
  };
}
