/** Additional research traffic only. Passive copies never enter this budget. */
export class ResearchBudget {
  private tokens = 0;
  private lastMs: number;
  private recent: { atMs: number; weight: number; quote: boolean }[] = [];
  private healthySinceMs: number;
  constructor(nowMs: number) {
    this.lastMs = nowMs;
    this.healthySinceMs = nowMs - 60000;
  }
  unhealthy(nowMs: number): void {
    this.healthySinceMs = nowMs;
  }
  waitMs(weight: number, nowMs: number, quote: boolean): number {
    this.tokens = Math.min(5, this.tokens + Math.max(0, nowMs - this.lastMs) * 0.002);
    this.lastMs = nowMs;
    this.recent = this.recent.filter((r) => r.atMs > nowMs - 60000);
    let wait = Math.max(
      0,
      Math.ceil((weight - this.tokens) / 0.002),
      this.healthySinceMs + 60000 - nowMs
    );
    let minuteWeight = this.recent.reduce((s, r) => s + r.weight, 0);
    let quotes = this.recent.filter((r) => r.quote).length;
    for (const r of this.recent) {
      if (minuteWeight + weight <= 120 && (!quote || quotes < 6)) break;
      wait = Math.max(wait, r.atMs + 60000 - nowMs);
      minuteWeight -= r.weight;
      if (r.quote) quotes--;
    }
    return wait;
  }
  consume(weight: number, nowMs: number, quote: boolean): void {
    if (weight <= 0 || weight > 5 || this.waitMs(weight, nowMs, quote))
      throw new Error('RESEARCH_BUDGET_INVARIANT');
    this.tokens -= weight;
    this.recent.push({ atMs: nowMs, weight, quote });
  }
}
