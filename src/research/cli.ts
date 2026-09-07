import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { validateModel } from '../decision/model.js';
import { auditMarkdown, auditResearch } from './audit.js';
import { replay, type ReplayInput } from './replay.js';
import { evaluatePaired, selectModel } from './validation.js';
import { freezeDataset, type DatasetPlan } from './dataset.js';
import { ResearchStorage } from './storage.js';
import { Storage } from '../storage/database.js';
import { deploymentPrecheck } from './precheck.js';
import { PUBLICATION_COMPATIBILITY } from '../delivery/publication-guard.js';
import { hashValue } from './protocol.js';
import type { MarketFact } from '../gmgn/facts.js';
import { createHash } from 'node:crypto';
import { budgetCheck } from './budget-check.js';
import { measurementReport, measurementReportMarkdown } from './measurement-report.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const file = () => {
  const path = option('--file');
  if (!path) throw new Error('FILE_REQUIRED');
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text) > 64 * 1024 ** 2) throw new Error('INPUT_TOO_LARGE');
  return JSON.parse(text) as unknown;
};
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
async function main() {
  if (args[0] === 'measurement-report') {
    const report = measurementReport(file());
    if (option('--format') === 'markdown') process.stdout.write(measurementReportMarkdown(report));
    else output(report);
    return;
  }
  if (args[0] === 'budget-check') {
    output(await budgetCheck());
    return;
  }
  if (args[0] === 'manifest' && args[1] === 'validate') {
    output({ ...validateModel(file()), mode: 'RESEARCH_ONLY' });
    return;
  }
  if (args[0] === 'replay') {
    const input = file() as ReplayInput & { factIds?: string[] };
    const dbPath = option('--db');
    if (dbPath) {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        input.facts = (input.factIds ?? []).map((id) => {
          const row = db
            .prepare(
              'SELECT envelope_json,payload_json,archive_id FROM research_facts WHERE fact_id=?'
            )
            .get(id) as
            | { envelope_json: string; payload_json: string | null; archive_id: string | null }
            | undefined;
          if (!row) throw new Error('FACT_MISSING');
          let payload: unknown;
          if (row.payload_json !== null) payload = JSON.parse(row.payload_json) as unknown;
          else {
            if (!row.archive_id || !/^[a-f0-9]{64}$/.test(row.archive_id))
              throw new Error('ARCHIVE_ID_INVALID');
            const text = readFileSync(
              join(dirname(dbPath), 'research-archives', `${row.archive_id}.json`),
              'utf8'
            );
            if (
              Buffer.byteLength(text) > 4 * 1024 ** 2 + 65536 ||
              createHash('sha256').update(text).digest('hex') !== row.archive_id
            )
              throw new Error('ARCHIVE_CHECKSUM_FAILED');
            payload = (JSON.parse(text) as Record<string, unknown>)[id];
            if (payload === undefined) throw new Error('ARCHIVE_FACT_MISSING');
          }
          return { ...JSON.parse(row.envelope_json), payload } as MarketFact;
        });
      } finally {
        db.close();
      }
    }
    output(await replay(input));
    return;
  }
  if (args[0] === 'dataset' && args[1] === 'freeze') {
    const dbPath = option('--db');
    if (!dbPath) throw new Error('DATABASE_REQUIRED');
    const storage = await Storage.open(dbPath);
    try {
      output(await freezeDataset(new ResearchStorage(storage), file() as DatasetPlan));
    } finally {
      storage.close();
    }
    return;
  }
  if (args[0] === 'select') {
    output(selectModel(file() as Parameters<typeof selectModel>[0]));
    return;
  }
  if (args[0] === 'evaluate-paired') {
    const data = file() as { runHash: string; pairs: unknown };
    output(evaluatePaired(data.pairs, data.runHash));
    return;
  }
  if (args[0] === 'readiness') {
    output({
      status: 'NO_PROMOTABLE_MODEL',
      reason: 'PRICE_SOURCE_TIME_UNVERIFIED',
      protocol: 'gmgn-facts-v1',
      evidenceHash: hashValue({ contract: 'gmgn-facts-v1', priceSourceTime: 'UNKNOWN' }),
      formalPublisher: 'legacy',
      newPublisherEnabled: false,
      finalRunEligible: false,
      remainingEngineering: [
        'paired live collection',
        'frozen dry-run publisher',
        'mixed-load certificate',
        'final-run lifecycle'
      ]
    });
    return;
  }
  const dbPath = option('--db');
  if (!['audit', 'deployment-precheck'].includes(args[0] ?? '') || !dbPath)
    throw new Error(
      'USAGE: audit|deployment-precheck --db DB; manifest validate|replay|dataset freeze|select|evaluate-paired --file JSON; readiness'
    );
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (args[0] === 'deployment-precheck') {
      const report = deploymentPrecheck(
        db,
        Date.now(),
        option('--compatibility') ?? PUBLICATION_COMPATIBILITY
      );
      output(report);
      if (report.status !== 'READY') process.exitCode = 1;
    } else {
      const report = auditResearch(db);
      if (option('--format') === 'markdown') process.stdout.write(auditMarkdown(report));
      else output(report);
    }
  } finally {
    db.close();
  }
}
void main().catch(() => {
  // Never echo arbitrary user-provided JSON (it may contain credentials).
  console.error(
    'RESEARCH_COMMAND_FAILED: check command arguments, schema, immutable identities and source support'
  );
  process.exitCode = 1;
});
