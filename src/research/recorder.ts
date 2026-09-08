import type { RuntimeConfig } from '../config/types.js';
import type { NormalizedEvent } from '../discovery/events.js';
import type { MarketFact } from '../gmgn/facts.js';
import { ResearchStorage } from './storage.js';
import type { Storage } from '../storage/database.js';
import { dirname, join } from 'node:path';
import { ResearchArchive } from './archive.js';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { measureResearchInBackground } from './maintenance.js';

/** Passive, bounded observer. It cannot call an API or feed the formal candidate queue. */
export class ResearchRecorder {
  readonly research: ResearchStorage;
  pending = 0;
  stoppedReason: string | null = null;
  private readonly events = new Map<string, NormalizedEvent>();
  private eventDrain = false;
  private maintenanceRunning = false;
  private closed = false;
  readonly archive: ResearchArchive;
  private maintenance: ReturnType<typeof setInterval> | null = null;
  constructor(
    storage: Storage,
    readonly config: NonNullable<RuntimeConfig['research']>,
    private readonly onError: (reason: string) => void
  ) {
    this.research = new ResearchStorage(storage);
    this.archive = new ResearchArchive(
      this.research,
      join(dirname(storage.db.name), 'research-archives')
    );
  }
  async start(nowMs: number, frozenManifest: unknown = this.config): Promise<void> {
    if (this.config.mode !== 'off') {
      await this.research.startRun(this.config.run_id, frozenManifest, nowMs);
      const active = await this.research.storage.write(() =>
        this.research.storage.db
          .prepare("SELECT 1 FROM research_runs WHERE run_id=? AND status='ACTIVE'")
          .get(this.config.run_id)
      );
      if (!active) {
        this.stop('RESEARCH_RUN_NOT_ACTIVE');
        return;
      }
      // In-memory databases are test-only and cannot be shared with a worker.
      try {
        if (this.research.storage.db.name !== ':memory:') await this.calibrate(false);
      } catch {
        this.stop('RESEARCH_QUOTA_CALIBRATION_FAILED');
        return;
      }
      this.maintenance = setInterval(
        () =>
          this.enqueue(async () => {
            if (this.maintenanceRunning || this.closed) return;
            this.maintenanceRunning = true;
            try {
              await this.calibrate(true);
            } finally {
              this.maintenanceRunning = false;
            }
          }),
        60000
      );
      this.maintenance.unref();
    }
  }
  fact(fact: MarketFact): void {
    this.enqueue(async () => {
      const inserted = await this.research.recordFact(
        fact,
        this.config.run_id,
        this.config.max_storage_bytes
      );
      if (!inserted) {
        const active = await this.research.storage.write(() =>
          this.research.storage.db
            .prepare("SELECT 1 FROM research_runs WHERE run_id=? AND status='ACTIVE'")
            .get(this.config.run_id)
        );
        if (!active) this.stop('RESEARCH_RUN_NOT_ACTIVE');
      }
    });
  }
  event(event: NormalizedEvent): void {
    if (this.config.mode === 'off' || this.stoppedReason) return;
    if (this.events.size >= 2000) {
      this.stop('RESEARCH_UNIVERSE_BACKLOG');
      return;
    }
    this.events.set(event.key, event);
    if (this.eventDrain) return;
    this.eventDrain = true;
    this.enqueue(async () => {
      try {
        while (this.events.size && !this.stoppedReason && !this.closed) {
          await yieldToIO();
          if (this.closed || this.stoppedReason) break;
          const batch: NormalizedEvent[] = [];
          for (const [key, event] of this.events) {
            this.events.delete(key);
            batch.push(event);
            if (batch.length === 50) break;
          }
          // Batch only research writes; release the event loop between bounded commits.
          await this.research.recordUniverseBatch(
            batch,
            this.config.run_id,
            this.config.run_id,
            20,
            this.config.max_storage_bytes
          );
        }
      } finally {
        this.eventDrain = false;
      }
    });
  }
  private enqueue(operation: () => Promise<void>): void {
    if (this.config.mode === 'off' || this.stoppedReason) return;
    if (this.pending >= 200) {
      this.stop('RESEARCH_WRITE_BACKLOG');
      return;
    }
    this.pending++;
    void yieldToIO()
      .then(() => (this.closed ? undefined : operation()))
      .catch((error: unknown) => {
        const code =
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          /^SQLITE_[A-Z_]+$/.test(error.code)
            ? error.code
            : null;
        this.stop(
          error instanceof Error && /^RESEARCH_MAINTENANCE_[A-Z_]+$/.test(error.message)
            ? error.message
            : code
              ? `RESEARCH_WRITE_FAILED_${code}`
              : 'RESEARCH_WRITE_FAILED'
        );
      })
      .finally(() => {
        this.pending--;
      });
  }
  stop(reason: string): void {
    if (this.stoppedReason) return;
    this.stoppedReason = reason;
    this.events.clear();
    this.close();
    this.onError(reason);
    void this.research.storage
      .recordOperationTrace({
        correlationId: randomUUID(),
        stage: 'research_failure',
        occurredAtMs: Date.now(),
        metadata: { runId: this.config.run_id, reason }
      })
      .catch(() => undefined);
    void this.research.storage
      .write(() => {
        this.research.storage.db
          .prepare(
            "UPDATE research_runs SET status='INCONCLUSIVE' WHERE run_id=? AND status='ACTIVE'"
          )
          .run(this.config.run_id);
      })
      .catch(() => undefined);
  }
  private async calibrate(maintain: boolean): Promise<void> {
    if (this.research.storage.db.name === ':memory:') return;
    const checkpoint = this.research.quotaCheckpoint();
    const bytes = await measureResearchInBackground(
      this.research.storage,
      join(dirname(this.research.storage.db.name), 'research-archives'),
      this.config.max_storage_bytes,
      maintain
    );
    if (!this.closed) this.research.calibrateQuota(bytes, checkpoint);
  }
  close(): void {
    this.closed = true;
    this.events.clear();
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = null;
  }
}
