import { GmgnScheduler, type Clock, type Priority } from '../gmgn/scheduler.js';
import { hashValue } from './protocol.js';
import { quantile } from './validation.js';
import type { SqliteDatabase } from '../storage/database.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const researchBudgetContractHash = () => {
  const ext = fileURLToPath(import.meta.url).endsWith('.ts') ? '.ts' : '.js';
  return hashValue({
    version: 2,
    physicalTimeoutMs: 2000,
    files: ['../gmgn/scheduler', '../gmgn/context', '../gmgn/errors', './budget'].map((path) => [
      path,
      readFileSync(new URL(path + ext, import.meta.url), 'utf8')
    ])
  });
};

export interface Arrival {
  id: string;
  atMs: number;
  weight: number;
  channel: string;
  durationMs: number;
  priority: Priority;
  research: boolean;
}

export async function recordedBudgetCheck(db: SqliteDatabase, nowMs: number, quoteGapMs = 1000) {
  const rows = db
    .prepare(
      `SELECT id,endpoint,started_at_ms,completed_at_ms,metadata_json FROM api_attempts
    WHERE started_at_ms>=? AND COALESCE(json_extract(metadata_json,'$.research'),0)=0 ORDER BY started_at_ms,id LIMIT 9000`
    )
    .all(nowMs - 900000) as {
    id: string;
    endpoint: string;
    started_at_ms: number;
    completed_at_ms: number;
    metadata_json: string;
  }[];
  if (!rows.length) throw new Error('NO_RECORDED_ARRIVALS');
  const raw = rows.map((row) => {
    const meta = JSON.parse(row.metadata_json) as {
      queuedAtMs: number;
      weight: number;
      priority: Priority;
    };
    if (
      !['formal', 'candidate', 'discovery', 'observation', 'evaluation'].includes(meta.priority) ||
      !Number.isSafeInteger(meta.queuedAtMs)
    )
      throw new Error('ARRIVAL_METADATA_UNVERIFIED');
    return {
      id: row.id,
      atMs: meta.queuedAtMs,
      weight: meta.weight,
      priority: meta.priority,
      research: false,
      channel: row.endpoint === 'quote' ? 'quote' : row.endpoint,
      durationMs: row.completed_at_ms - row.started_at_ms
    };
  });
  const start = Math.min(...raw.map((r) => r.atMs)),
    end = Math.max(...raw.map((r) => r.atMs)) - start;
  const arrivals: Arrival[] = raw.map((r) => ({ ...r, atMs: r.atMs - start }));
  for (let at = 3000; at < end; at += 30000) {
    arrivals.push(
      {
        id: `research-info-${at}`,
        atMs: at,
        weight: 1,
        channel: 'info',
        durationMs: 2000,
        priority: 'evaluation',
        research: true
      },
      {
        id: `research-holders-${at}`,
        atMs: at + 2500,
        weight: 5,
        channel: 'holders',
        durationMs: 2000,
        priority: 'evaluation',
        research: true
      },
      {
        id: `research-buy-${at}`,
        atMs: at + 5500,
        weight: 2,
        channel: 'quote',
        durationMs: 2000,
        priority: 'evaluation',
        research: true
      },
      {
        id: `research-sell-${at}`,
        atMs: at + 8000,
        weight: 2,
        channel: 'quote',
        durationMs: 2000,
        priority: 'evaluation',
        research: true
      }
    );
  }
  return budgetCheck(quoteGapMs, arrivals, 'RECORDED');
}
class VirtualClock implements Clock {
  time = 0;
  events: { at: number; sequence: number; action: () => void }[] = [];
  sequence = 0;
  now() {
    return this.time;
  }
  random() {
    return 0.5;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.at(this.time + ms, resolve));
  }
  at(at: number, action: () => void) {
    this.events.push({ at, sequence: this.sequence++, action });
  }
  async flush() {
    for (let steps = 0; steps < 100000; steps++) {
      for (let micro = 0; micro < 20; micro++) await Promise.resolve();
      this.events.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
      const event = this.events.shift();
      if (!event) return;
      this.time = event.at;
      event.action();
    }
    throw new Error('SIMULATION_DID_NOT_DRAIN');
  }
}
const defaultArrivals: Arrival[] = Array.from({ length: 4 }, (_, i) => [
  {
    id: `research-${i}`,
    atMs: i * 70000 + 3000,
    weight: 2,
    channel: 'quote',
    durationMs: 2000,
    priority: 'evaluation' as const,
    research: true
  },
  {
    id: `formal-${i}`,
    atMs: i * 70000 + 4000,
    weight: 2,
    channel: 'quote',
    durationMs: 200,
    priority: 'formal' as const,
    research: false
  },
  {
    id: `discovery-${i}`,
    atMs: i * 70000 + 4050,
    weight: 3,
    channel: 'discovery',
    durationMs: 100,
    priority: 'discovery' as const,
    research: false
  },
  {
    id: `research-sell-${i}`,
    atMs: i * 70000 + 5000,
    weight: 2,
    channel: 'quote',
    durationMs: 2000,
    priority: 'evaluation' as const,
    research: true
  }
]).flat();
async function simulate(arrivals: Arrival[], enabled: boolean, quoteGapMs: number) {
  const clock = new VirtualClock();
  const scheduler = new GmgnScheduler(clock, 14, 20, 6, {
    paced: true,
    maxConcurrent: 4,
    channelCompletionIntervalsMs: { quote: quoteGapMs },
    researchEnabled: enabled
  });
  const rows: {
    id: string;
    research: boolean;
    priority: Priority;
    weight: number;
    queuedAtMs: number;
    dispatchedAtMs: number | null;
    finishedAtMs: number;
    status: string;
  }[] = [];
  for (const arrival of arrivals.filter((a) => enabled || !a.research))
    clock.at(arrival.atMs, () => {
      let dispatchedAtMs: number | null = null;
      void scheduler
        .schedule({
          research: arrival.research,
          weight: arrival.weight,
          priority: arrival.priority,
          deadlineMs: arrival.atMs + 10000,
          channel: arrival.channel,
          run: async (admission) => {
            dispatchedAtMs = admission.dispatchedAtMs;
            await clock.sleep(arrival.durationMs);
          }
        })
        .then(
          () => 'COMPLETED',
          () => 'RESOURCE_EXCLUDED'
        )
        .then((status) => {
          rows.push({
            id: arrival.id,
            research: arrival.research,
            priority: arrival.priority,
            weight: arrival.weight,
            queuedAtMs: arrival.atMs,
            dispatchedAtMs,
            finishedAtMs: clock.now(),
            status
          });
        });
    });
  await clock.flush();
  if (rows.length !== arrivals.filter((a) => enabled || !a.research).length)
    throw new Error('INCOMPLETE_BUDGET_MEASUREMENT');
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
/** Repeatable contention counterexamples on the production scheduler; no GMGN or Telegram access. */
export async function budgetCheck(
  quoteGapMs = 1000,
  arrivals = defaultArrivals,
  source: 'SYNTHETIC' | 'RECORDED' = 'SYNTHETIC'
) {
  if (
    !arrivals.length ||
    arrivals.length > 10000 ||
    new Set(arrivals.map((a) => a.id)).size !== arrivals.length ||
    arrivals.some(
      (a) =>
        ![a.atMs, a.weight, a.durationMs].every(Number.isFinite) ||
        a.atMs < 0 ||
        a.durationMs < 0 ||
        a.weight <= 0 ||
        a.weight > 5 ||
        (a.research && a.durationMs > 2000)
    )
  )
    throw new Error('INVALID_WORKLOAD');
  const off = await simulate(arrivals, false, quoteGapMs),
    on = await simulate(arrivals, true, quoteGapMs);
  const formal = on.filter((r) => r.priority === 'formal');
  const increments = formal.map((row) => {
    const control = off.find((r) => r.id === row.id)!;
    return row.dispatchedAtMs === null || control.dispatchedAtMs === null
      ? Infinity
      : row.dispatchedAtMs - control.dispatchedAtMs;
  });
  const waits = (rows: typeof on) =>
    rows
      .filter((r) => r.priority === 'formal' && r.dispatchedAtMs !== null)
      .map((r) => r.dispatchedAtMs! - r.queuedAtMs);
  const percentiles = (values: number[]) => ({
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99)
  });
  const maximum = Math.max(...increments);
  const dispatched = on.filter((r) => r.research && r.dispatchedAtMs !== null).length;
  const measured = Number.isFinite(maximum) && dispatched > 0;
  const report = {
    version: 'scheduler-contention-fixture-v1',
    runtimeContractHash: researchBudgetContractHash(),
    workloadHash: hashValue(arrivals),
    quoteGapMs,
    status: measured && maximum <= 3000 ? 'PASS' : 'INCONCLUSIVE',
    maximumAdditionalWaitMs: Number.isFinite(maximum) ? maximum : null,
    formalOff: percentiles(waits(off)),
    formalOn: percentiles(waits(on)),
    researchDispatched: dispatched,
    researchExcluded: on.filter((r) => r.research && r.status === 'RESOURCE_EXCLUDED').length,
    productionEnablement:
      source === 'RECORDED' && measured && maximum <= 3000 && quoteGapMs + 2000 <= 3000,
    scope: source === 'RECORDED' ? 'RECORDED_ARRIVAL_MOCK_TRANSPORT' : 'SYNTHETIC_CONTENTION_ONLY',
    off,
    on
  };
  return { ...report, evidenceHash: hashValue(report) };
}
