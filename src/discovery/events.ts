import { createHash } from 'node:crypto';

export type DiscoverySource = 'signal' | 'trenches' | 'trending' | 'hot' | 'smart_money' | 'kol';
export type EvidenceFamily = 'lifecycle' | 'structure' | 'capital' | 'attention';
export type EvidenceStrength = 'weak' | 'strong';

export interface NormalizedEvent {
  key: string;
  chain: 'bsc';
  tokenAddress: string;
  source: DiscoverySource;
  sourceEventAtMs: number | null;
  observedAtMs: number;
  evidenceFamily: EvidenceFamily;
  strength: EvidenceStrength;
  expiresAtMs: number;
  rawPayloadRef: string;
  payload: Record<string, unknown>;
  decisionEligible?: boolean;
  sourceEventId?: string;
  pollKey?: string;
  snapshotHash?: string;
  snapshotSequence?: number;
}

export function stableEventKey(
  source: DiscoverySource,
  sourceEventId: string,
  tokenAddress: string
): string {
  return `${source}:${sourceEventId}:${tokenAddress.toLowerCase()}`;
}

export function snapshotHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function snapshotEventKey(
  source: DiscoverySource,
  pollKey: string,
  tokenAddress: string,
  sequence: number,
  hash: string
): string {
  return `${source}:${pollKey}:${tokenAddress.toLowerCase()}:${sequence}:${hash}`;
}

export function normalizeEvent(
  input: Omit<NormalizedEvent, 'key'> & {
    sourceEventId?: string;
    pollKey?: string;
    snapshotSequence?: number;
  }
): NormalizedEvent {
  const hash = input.snapshotHash ?? snapshotHash(input.payload);
  const key = input.sourceEventId
    ? stableEventKey(input.source, input.sourceEventId, input.tokenAddress)
    : snapshotEventKey(
        input.source,
        input.pollKey ?? input.source,
        input.tokenAddress,
        input.snapshotSequence ?? 0,
        hash
      );
  return {
    ...input,
    tokenAddress: input.tokenAddress.toLowerCase(),
    key,
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    ...(input.pollKey ? { pollKey: input.pollKey } : {}),
    ...(!input.sourceEventId
      ? { snapshotHash: hash, snapshotSequence: input.snapshotSequence ?? 0 }
      : {})
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export class KeyedSerialExecutor {
  #tails = new Map<string, Promise<void>>();
  enqueue<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    this.#tails.set(key, tail);
    void tail.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }
}

/** Keeps at most one not-yet-started operation per key, replacing it with the latest state. */
export class LatestKeyedSerialExecutor {
  #states = new Map<
    string,
    {
      running: boolean;
      pending:
        | {
            operation: () => void | Promise<void>;
            resolve(): void;
            reject(reason: unknown): void;
          }
        | undefined;
    }
  >();

  enqueue(key: string, operation: () => void | Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const state = this.#states.get(key) ?? { running: false, pending: undefined };
      state.pending?.resolve();
      state.pending = { operation, resolve, reject };
      this.#states.set(key, state);
      if (!state.running) void this.drain(key, state);
    });
  }

  private async drain(
    key: string,
    state: {
      running: boolean;
      pending:
        | {
            operation: () => void | Promise<void>;
            resolve(): void;
            reject(reason: unknown): void;
          }
        | undefined;
    }
  ): Promise<void> {
    state.running = true;
    while (state.pending) {
      const pending = state.pending;
      state.pending = undefined;
      try {
        await pending.operation();
        pending.resolve();
      } catch (error) {
        pending.reject(error);
      }
    }
    state.running = false;
    if (this.#states.get(key) === state && !state.pending) this.#states.delete(key);
  }
}

export interface PersistedSnapshot {
  source: string;
  pollKey: string;
  tokenAddress: string;
  snapshotHash: string;
  snapshotSequence: number;
  expiresAtMs: number;
}

export class SnapshotDeduplicator {
  #states = new Map<string, { hash: string; sequence: number; expiresAtMs: number }>();
  #serial = new KeyedSerialExecutor();
  constructor(snapshots: readonly PersistedSnapshot[] = []) {
    for (const snapshot of snapshots)
      this.#states.set(this.stateKey(snapshot.source, snapshot.pollKey, snapshot.tokenAddress), {
        hash: snapshot.snapshotHash,
        sequence: snapshot.snapshotSequence,
        expiresAtMs: snapshot.expiresAtMs
      });
  }
  async ingest(
    input: Omit<NormalizedEvent, 'key' | 'snapshotSequence'> & { pollKey: string },
    persist: (event: NormalizedEvent) => Promise<boolean>
  ): Promise<NormalizedEvent | null> {
    const key = this.stateKey(input.source, input.pollKey, input.tokenAddress);
    return this.#serial.enqueue(key, async () => {
      const hash = input.snapshotHash ?? snapshotHash(input.payload);
      const current = this.#states.get(key);
      if (current?.hash === hash && current.expiresAtMs > input.observedAtMs) return null;
      const event = normalizeEvent({
        ...input,
        snapshotHash: hash,
        snapshotSequence: (current?.sequence ?? 0) + 1
      });
      if (!(await persist(event))) return null;
      this.#states.set(key, {
        hash,
        sequence: event.snapshotSequence ?? 0,
        expiresAtMs: event.expiresAtMs
      });
      return event;
    });
  }
  private stateKey(source: string, pollKey: string, tokenAddress: string): string {
    return `${source}:${pollKey}:${tokenAddress.toLowerCase()}`;
  }
}
