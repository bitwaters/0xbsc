import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/database.js';

export const PUBLICATION_COMPATIBILITY = 'global-token-lock-v1';
/** A lease fences preparation; a durable UNKNOWN reservation fences the non-transactional send. */
export class PublicationGuard {
  constructor(
    private readonly storage: Storage,
    private readonly now: () => number = Date.now
  ) {}
  acquire(): Promise<string | null> {
    return this.storage.transaction(() => {
      const owner = randomUUID(),
        now = this.now();
      const result = this.storage.db
        .prepare(
          `INSERT INTO publisher_leases(name,owner,expires_at_ms) VALUES ('telegram',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at_ms=excluded.expires_at_ms WHERE publisher_leases.expires_at_ms<=?`
        )
        .run(owner, now + 60000, now);
      return result.changes === 1 ? owner : null;
    });
  }
  renew(owner: string): Promise<boolean> {
    return this.storage.write(
      () =>
        this.storage.db
          .prepare(
            "UPDATE publisher_leases SET expires_at_ms=? WHERE name='telegram' AND owner=? AND expires_at_ms>?"
          )
          .run(this.now() + 60000, owner, this.now()).changes === 1
    );
  }
  release(owner: string): Promise<void> {
    return this.storage.write(() => {
      this.storage.db
        .prepare("DELETE FROM publisher_leases WHERE name='telegram' AND owner=?")
        .run(owner);
    });
  }
  reserve(owner: string, signalId: string): Promise<boolean> {
    return this.storage.transaction(() => {
      const db = this.storage.db,
        now = this.now();
      if (
        !db
          .prepare(
            "SELECT 1 FROM publisher_leases WHERE name='telegram' AND owner=? AND expires_at_ms>?"
          )
          .get(owner, now)
      )
        return false;
      const row = db
        .prepare(
          "SELECT e.chain,e.token_address AS token FROM signals s JOIN episodes e ON e.id=s.episode_id WHERE s.id=? AND s.delivery_state='PENDING' AND s.decision_format='legacy-v1'"
        )
        .get(signalId) as { chain: string; token: string } | undefined;
      if (!row) return false;
      // Never automatically replace a reservation, including one left by a crashed sender.
      return (
        db
          .prepare(
            "INSERT OR IGNORE INTO publication_token_locks(chain,token,signal_id,state,locked_at_ms) VALUES (?,?,?,'UNKNOWN',?)"
          )
          .run(row.chain, row.token, signalId, now).changes === 1
      );
    });
  }
  knownUnsent(signalId: string): Promise<void> {
    return this.storage.write(() => {
      this.storage.db
        .prepare("DELETE FROM publication_token_locks WHERE signal_id=? AND state='UNKNOWN'")
        .run(signalId);
    });
  }
}
