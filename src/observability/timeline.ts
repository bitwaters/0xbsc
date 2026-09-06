import { randomUUID } from 'node:crypto';
import type { OperationTrace, Storage } from '../storage/database.js';

export class OperationTimeline {
  readonly correlationId: string;

  constructor(
    private readonly storage: Storage,
    correlationId: string = randomUUID(),
    private readonly now: () => number = Date.now
  ) {
    this.correlationId = correlationId;
  }

  record(stage: OperationTrace['stage'], metadata?: unknown): Promise<void> {
    return this.storage.recordOperationTrace({
      correlationId: this.correlationId,
      stage,
      occurredAtMs: this.now(),
      ...(metadata === undefined ? {} : { metadata })
    });
  }
}
