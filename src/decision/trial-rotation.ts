/** FIFO admissions: repeated discoveries refresh liveness without jumping the waiting queue. */
export interface WaitingCandidate {
  tokenAddress: string;
  key: string;
  pool?: string;
  firstQueuedAtMs: number;
  seenAtMs: number;
  eligibleAtMs: number;
}
export class TrialRotation {
  private waiting = new Map<string, WaitingCandidate>();
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
      }
      return 'refreshed';
    }
    if (this.waiting.size >= this.capacity) return 'overflow';
    this.waiting.set(candidate.tokenAddress, candidate);
    return 'queued';
  }
  take(now: number): { candidate?: WaitingCandidate; expired: WaitingCandidate[] } {
    const expired: WaitingCandidate[] = [];
    for (const [token, row] of this.waiting) {
      if (now - row.seenAtMs > this.liveMs) {
        this.waiting.delete(token);
        expired.push(row);
        return { expired };
      }
      if (row.eligibleAtMs > now) continue;
      this.waiting.delete(token);
      return { candidate: row, expired };
    }
    return { expired };
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
