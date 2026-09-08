import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ApiObservation } from '../gmgn/client.js';

export class BusinessHealth {
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private readonly startedAtMs: number;
  private readonly endpoints = new Map<
    string,
    { lastAttemptAtMs: number; lastSuccessAtMs: number | null; errors: number }
  >();
  private lastSafetyAttemptAtMs: number | null = null;
  private lastSafetyCompletedAtMs: number | null = null;
  private lastShadowAtMs: number | null = null;
  private queueTimeouts = 0;
  private safetyCompleted = 0;
  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = now();
    this.delay.enable();
  }
  api(endpoint: string, observation: ApiObservation): void {
    const entry = this.endpoints.get(endpoint) ?? {
      lastAttemptAtMs: 0,
      lastSuccessAtMs: null,
      errors: 0
    };
    entry.lastAttemptAtMs = observation.occurredAtMs;
    if (observation.kind === 'success') entry.lastSuccessAtMs = observation.occurredAtMs;
    else entry.errors++;
    this.endpoints.set(endpoint, entry);
  }
  safetyStarted(): void {
    this.lastSafetyAttemptAtMs = this.now();
  }
  safetyFinished(): void {
    this.lastSafetyCompletedAtMs = this.now();
    this.safetyCompleted++;
  }
  shadowFinished(): void {
    this.lastShadowAtMs = this.now();
  }
  queueExpired(): void {
    this.queueTimeouts++;
  }
  snapshot(resetDelay = false) {
    const now = this.now();
    const loopMaxMs = this.delay.max / 1e6;
    const loopP99Ms = this.delay.percentile(99) / 1e6;
    const reasons: string[] = [];
    if (loopMaxMs > 5000) reasons.push('EVENT_LOOP_BLOCKED');
    if (now - this.startedAtMs > 300000) {
      if (
        this.lastSafetyAttemptAtMs !== null &&
        now - this.lastSafetyAttemptAtMs < 300000 &&
        now - (this.lastSafetyCompletedAtMs ?? this.startedAtMs) > 300000
      )
        reasons.push('SAFETY_PIPELINE_STALLED');
      const discovery = ['hot', 'trending', 'trenches', 'market_signal', 'kol', 'smart_money'];
      if (
        !discovery.some(
          (key) => now - (this.endpoints.get(key)?.lastSuccessAtMs ?? this.startedAtMs) < 300000
        )
      )
        reasons.push('DISCOVERY_DATA_STALE');
    }
    if (resetDelay) this.delay.reset();
    return {
      status: reasons.length ? 'degraded' : 'ready',
      reasons,
      eventLoopMaxMs: loopMaxMs,
      eventLoopP99Ms: loopP99Ms,
      safetyCompleted: this.safetyCompleted,
      queueTimeouts: this.queueTimeouts,
      lastSafetyAttemptAtMs: this.lastSafetyAttemptAtMs,
      lastSafetyCompletedAtMs: this.lastSafetyCompletedAtMs,
      lastShadowAtMs: this.lastShadowAtMs,
      endpoints: Object.fromEntries(this.endpoints)
    };
  }
  close(): void {
    this.delay.disable();
  }
}
