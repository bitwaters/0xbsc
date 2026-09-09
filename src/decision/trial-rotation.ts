/** FIFO within first-observation and revisit lanes; at most three fresh admissions before a revisit. */
export interface WaitingCandidate {
  tokenAddress: string;
  key: string;
  pool?: string;
  firstQueuedAtMs: number;
  seenAtMs: number;
  eligibleAtMs: number;
  revisit?: boolean;
}
export class TrialRotation {
  private waiting = new Map<string, WaitingCandidate>();
  private freshStreak = 0;
  constructor(
    readonly capacity = 20000,
    readonly liveMs = 120000
  ) {}
  get size() {
    return this.waiting.size;
  }
  has(token: string) {
    return this.waiting.has(token);
  }
  observe(candidate: WaitingCandidate): 'queued' | 'refreshed' | 'overflow' {
    const old = this.waiting.get(candidate.tokenAddress);
    if (old) {
      old.seenAtMs = candidate.seenAtMs;
      old.key = candidate.key;
      if (candidate.pool && candidate.pool !== old.pool) {
        old.pool = candidate.pool;
        old.eligibleAtMs = Math.min(old.eligibleAtMs, candidate.seenAtMs);
        old.revisit = false;
      }
      return 'refreshed';
    }
    if (this.waiting.size >= this.capacity) return 'overflow';
    this.waiting.set(candidate.tokenAddress, candidate);
    return 'queued';
  }
  take(now: number): { candidate?: WaitingCandidate; expired: WaitingCandidate[] } {
    const expired: WaitingCandidate[] = [];
    let fresh: WaitingCandidate | undefined, revisit: WaitingCandidate | undefined;
    for (const [token, row] of this.waiting) {
      if (now - row.seenAtMs > this.liveMs) {
        this.waiting.delete(token);
        expired.push(row);
        return { expired };
      }
      if (row.eligibleAtMs > now) continue;
      if (row.revisit) revisit ??= row;
      else fresh ??= row;
      if (fresh && revisit) break;
    }
    const candidate = fresh && (!revisit || this.freshStreak < 3) ? fresh : revisit;
    if (candidate) {
      this.waiting.delete(candidate.tokenAddress);
      this.freshStreak = candidate.revisit ? 0 : Math.min(3, this.freshStreak + 1);
    }
    return { ...(candidate ? { candidate } : {}), expired };
  }
  entries(): WaitingCandidate[] {
    return [...this.waiting.values()].map((r) => ({ ...r }));
  }
  restore(rows: WaitingCandidate[], now: number) {
    for (const row of rows) {
      if (
        /^0x[0-9a-f]{40}$/.test(row.tokenAddress) &&
        Number.isFinite(row.seenAtMs) &&
        row.seenAtMs <= now &&
        now - row.seenAtMs <= this.liveMs &&
        Number.isFinite(row.eligibleAtMs) &&
        Number.isFinite(row.firstQueuedAtMs)
      )
        this.observe(row);
    }
  }
}
