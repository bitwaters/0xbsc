import type { SqliteDatabase } from '../storage/database.js';
import { PUBLICATION_COMPATIBILITY } from '../delivery/publication-guard.js';
import { PublicationGuard } from '../delivery/publication-guard.js';
import type { Storage } from '../storage/database.js';

/** Caller obtains the target image ID/labels through Docker inspect, never from a guessed default. */
export interface RollbackImage {
  imageId: string;
  compatibility: string;
}
export async function drainPreparation(
  storage: Storage,
  image: RollbackImage,
  now: () => number = Date.now
) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image.imageId) ||
    image.compatibility !== PUBLICATION_COMPATIBILITY
  )
    throw new Error('INCOMPATIBLE_ROLLBACK_IMAGE');
  const guard = new PublicationGuard(storage, now);
  const owner = await guard.acquire();
  if (!owner) return { status: 'BLOCKED', reason: 'PUBLISHER_STILL_ACTIVE', cancelled: 0 };
  try {
    return await storage.transaction(() => {
      const db = storage.db;
      // Recheck fencing inside the mutation transaction. UNKNOWN and SENT are never cleared.
      if (
        !db
          .prepare('SELECT 1 FROM publisher_leases WHERE owner=? AND expires_at_ms>?')
          .get(owner, now())
      )
        throw new Error('DRAIN_LEASE_EXPIRED');
      const pending = db
        .prepare(
          `SELECT id,episode_id FROM signals WHERE delivery_state='PENDING'
        AND NOT EXISTS(SELECT 1 FROM publication_token_locks WHERE signal_id=signals.id)`
        )
        .all() as { id: string; episode_id: string }[];
      for (const signal of pending) {
        db.prepare(
          `UPDATE signals SET delivery_state='SEND_FAILED',delivery_failure_kind='pre_send_cancelled',
          last_delivery_error='DEPLOYMENT_DRAIN',updated_at_ms=? WHERE id=? AND delivery_state='PENDING'`
        ).run(now(), signal.id);
        db.prepare(
          "UPDATE episodes SET state='SEND_FAILED',updated_at_ms=?,ended_at_ms=? WHERE id=? AND state='DELIVERY_PENDING'"
        ).run(now(), now(), signal.episode_id);
      }
      return {
        status: 'DRAINED',
        cancelled: pending.length,
        imageId: image.imageId,
        databaseRollback: 'FORBIDDEN',
        unknownLocksPreserved: true
      };
    });
  } finally {
    await guard.release(owner);
  }
}

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
