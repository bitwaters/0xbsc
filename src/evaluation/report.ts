import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { summarizePathStatuses, type PathStatus } from './path.js';

/** Aggregates in-process; token addresses and individual wallet/market records are never printed. */
export function pathQualityReport(db: Database.Database) {
  const schema = db.prepare('PRAGMA table_info(price_samples)').all() as { name: string }[];
  if (!schema.some((c) => c.name === 'quality_version'))
    return { status: 'quality_v2_schema_missing', historicalRecomputed: false };
  const legacy = (
    db
      .prepare(
        "SELECT count(*) AS n FROM price_samples WHERE task_kind LIKE 'outcome_%' AND quality_version='legacy'"
      )
      .get() as { n: number }
  ).n;
  // Select earliest Episode per token+route+cohort, and latest available result within it.
  const rows = db
    .prepare(
      `WITH ranked AS (
    SELECT p.evaluation_revision_id AS revision,ep.token_address,ep.route,CASE WHEN p.signal_id IS NULL THEN 'unsent' ELSE 'sent' END AS cohort,
      p.data_json,p.status,p.evaluation_policy_json,p.entry_at_ms,p.target_at_ms,p.id,
      ROW_NUMBER() OVER(PARTITION BY p.evaluation_revision_id,ep.token_address,ep.route,p.signal_id IS NULL
        ORDER BY ep.created_at_ms,ep.id,p.status='COMPLETE' DESC,p.target_at_ms DESC,p.id DESC) AS rn
    FROM price_samples p JOIN episodes ep ON ep.id=p.episode_id
    WHERE p.task_kind LIKE 'outcome_%' AND p.quality_version='path-v2')
    SELECT revision,route,cohort,data_json AS data,status,evaluation_policy_json AS policy FROM ranked WHERE rn=1`
    )
    .all() as {
    revision: string;
    route: string;
    cohort: string;
    data: string | null;
    status: string;
    policy: string | null;
  }[];
  const groups = new Map<
    string,
    {
      total: number;
      completePaths: number;
      maxMultiples: number[];
      entryDrops: number[];
      statuses: Map<string, PathStatus[]>;
    }
  >();
  const targetsByRevision = new Map<string, Set<string>>();
  for (const row of rows) {
    const parsed = row.data
      ? (JSON.parse(row.data) as {
          outcome?: {
            path?: {
              coverage?: string;
              maxMultiple?: string | null;
              maxEntryDrop?: string | null;
              barriers?: { multiple: number; stopLoss: number; status: PathStatus }[];
            };
          };
        })
      : {};
    const targets = targetsByRevision.get(row.revision) ?? new Set<string>();
    const policy = row.policy
      ? (JSON.parse(row.policy) as { target_multiples?: number[]; stop_loss_percent?: number })
      : {};
    if (policy.stop_loss_percent !== undefined)
      for (const multiple of policy.target_multiples ?? [])
        targets.add(`${multiple}/${policy.stop_loss_percent}`);
    for (const barrier of parsed.outcome?.path?.barriers ?? [])
      targets.add(`${barrier.multiple}/${barrier.stopLoss}`);
    targetsByRevision.set(row.revision, targets);
  }
  for (const row of rows) {
    const key = `${row.revision}:${row.cohort}:${row.route}`,
      g = groups.get(key) ?? {
        total: 0,
        completePaths: 0,
        maxMultiples: [],
        entryDrops: [],
        statuses: new Map<string, PathStatus[]>()
      };
    g.total++;
    const parsed = row.data
      ? (JSON.parse(row.data) as {
          outcome?: {
            path?: {
              coverage?: string;
              maxMultiple?: string | null;
              maxEntryDrop?: string | null;
              barriers?: { multiple: number; stopLoss: number; status: PathStatus }[];
            };
          };
        })
      : {};
    const path = parsed.outcome?.path;
    if (path?.coverage === 'complete') {
      g.completePaths++;
      if (path.maxMultiple !== null && path.maxMultiple !== undefined)
        g.maxMultiples.push(Number(path.maxMultiple));
      if (path.maxEntryDrop !== null && path.maxEntryDrop !== undefined)
        g.entryDrops.push(Number(path.maxEntryDrop));
    }
    for (const target of targetsByRevision.get(row.revision) ?? []) {
      const barrier = path?.barriers?.find((b) => `${b.multiple}/${b.stopLoss}` === target);
      const status = barrier?.status ?? (row.status === 'PENDING' ? 'pending' : 'unknown');
      g.statuses.set(target, [...(g.statuses.get(target) ?? []), status]);
    }
    groups.set(key, g);
  }
  return {
    status: 'ok',
    historicalRecomputed: false,
    legacyCheckpoints: legacy,
    deduplication: 'earliest Episode per revision/token/route/cohort; latest completed checkpoint',
    groups: Object.fromEntries(
      [...groups].map(([key, g]) => [
        key,
        {
          total: g.total,
          completePaths: g.completePaths,
          maxMultipleMedian: median(g.maxMultiples),
          maxEntryDropMedian: median(g.entryDrops),
          barriers: Object.fromEntries(
            [...g.statuses].map(([target, statuses]) => [target, summarizePathStatuses(statuses)])
          )
        }
      ])
    ),
    shadow: db
      .prepare(
        `SELECT config_revision_id AS revision,json_extract(decision_json,'$.route') AS route,
      json_extract(decision_json,'$.legacyDecision') AS legacyDecision,
      json_extract(decision_json,'$.candidateQualified') AS candidateQualified,count(*) AS decisions,count(DISTINCT token_address) AS tokens
      FROM shadow_decisions GROUP BY 1,2,3,4`
      )
      .all()
  };
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  return a.length % 2
    ? a[Math.floor(a.length / 2)]!
    : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node dist/evaluation/report.js /path/to/database');
  const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
  try {
    console.log(JSON.stringify(pathQualityReport(db), null, 2));
  } finally {
    db.close();
  }
}
