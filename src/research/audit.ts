import type { SqliteDatabase } from '../storage/database.js';

export function auditResearch(db: SqliteDatabase) {
  const schema = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='research_facts'").get();
  if (!schema)
    return {
      schema: 'NOT_INSTALLED',
      marketBaseline: 'UNAVAILABLE',
      reason: 'RESEARCH_SCHEMA_MISSING'
    };
  const endpoints = db
    .prepare(
      `SELECT endpoint,COUNT(*) AS responses,MIN(received_at_ms) AS firstReceivedAtMs,MAX(received_at_ms) AS lastReceivedAtMs,SUM(CASE WHEN json_array_length(json_extract(envelope_json,'$.qualityFlags'))=0 THEN 1 ELSE 0 END) AS withoutQualityFlags FROM research_facts GROUP BY endpoint ORDER BY endpoint`
    )
    .all();
  const physical = db
    .prepare(
      'SELECT COUNT(*) AS responses,COUNT(DISTINCT attempt_id) AS physicalAttempts FROM research_facts'
    )
    .get();
  const universe = db
    .prepare(
      'SELECT stratum,COUNT(*) AS tokens FROM research_universe GROUP BY stratum ORDER BY stratum'
    )
    .all();
  const sampling = db
    .prepare(
      'SELECT run_id,status,COUNT(*) AS count FROM research_sampling GROUP BY run_id,status ORDER BY run_id,status'
    )
    .all();
  const runs = db
    .prepare(
      'SELECT run_id,stage,status,manifest_hash,consumed FROM research_runs ORDER BY created_at_ms,run_id'
    )
    .all();
  return {
    schema: 'gmgn-facts-v1',
    marketBaseline: 'UNAVAILABLE',
    reason: 'PRICE_SOURCE_TIME_UNVERIFIED',
    physical,
    endpoints,
    universe,
    sampling,
    runs,
    capabilities: [
      {
        field: 'info.price.price',
        status: 'OBSERVED_VALUE_ONLY',
        unit: 'USD/token',
        sourceTime: 'UNVERIFIED'
      },
      { field: 'unique_new_buyers', status: 'UNSUPPORTED_FEATURE' },
      { field: 'kline.time', status: 'CANDLE_BOUNDARY_ONLY', unit: 'milliseconds' },
      { field: 'quote.tx.amount_in_usd/amount_out_usd', status: 'SIMULATED_COST_ONLY', unit: 'USD' }
    ]
  };
}
export function auditMarkdown(report: ReturnType<typeof auditResearch>): string {
  return `# 研究数据审计\n\n市场主基准：${report.marketBaseline}\n\n原因：${report.reason}\n\nInfo价格来源时间尚未验证，不能形成确认后可靠基准或晋级凭据。\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}
