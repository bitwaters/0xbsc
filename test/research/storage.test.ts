import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Storage } from '../../src/storage/database.js';
import { ResearchStorage } from '../../src/research/storage.js';
import { createMarketFact } from '../../src/gmgn/facts.js';
import { normalizeEvent } from '../../src/discovery/events.js';
import { auditResearch } from '../../src/research/audit.js';
const token = '0x' + 'a'.repeat(40);
const makeFact = () =>
  createMarketFact({
    request: { method: 'GET', path: '/v1/token/info', query: { address: token } },
    response: { data: { price: { price: '1' }, liquidity: '20' } },
    attemptId: 'physical-1',
    purpose: 'legacy_formal',
    queuedAtMs: 100,
    requestedAtMs: 200,
    receivedAtMs: 300
  });
async function fixture(run: (s: Storage, r: ResearchStorage) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'research-'));
  const s = await Storage.open(join(dir, 'test.sqlite'));
  try {
    const r = new ResearchStorage(s);
    await r.startRun('run', { mode: 'observe' }, 1);
    await run(s, r);
  } finally {
    s.close();
    await rm(dir, { recursive: true, force: true });
  }
}
void test('physical facts are idempotent, immutable and unavailable before receive time', async () =>
  fixture(async (s, r) => {
    const f = makeFact();
    assert.equal(await r.recordFact(f, 'run', 2 ** 30), true);
    assert.equal(await r.recordFact(f, 'run', 2 ** 30), false);
    assert.deepEqual(await r.factsAt(token, 299), []);
    assert.equal((await r.factsAt(token, 300))[0]?.factId, f.factId);
    assert.throws(
      () => s.db.prepare('UPDATE research_facts SET requested_at_ms=0').run(),
      /immutable/
    );
    await assert.rejects(
      r.recordFact({ ...f, factId: 'different' }, 'run', 2 ** 30),
      /conflicting/
    );
    assert.equal(auditResearch(s.db).marketBaseline, 'UNAVAILABLE');
  }));
void test('run versions are immutable and storage exhaustion is visible without deleting old data', async () =>
  fixture(async (s, r) => {
    await assert.rejects(r.startRun('run', { mode: 'changed' }, 2), /changed/);
    assert.equal(await r.recordFact(makeFact(), 'run', 1), false);
    assert.deepEqual(s.db.prepare('SELECT status FROM research_runs').get(), {
      status: 'STORAGE_BUDGET_EXHAUSTED'
    });
    assert.deepEqual(await r.factsAt(token, 1000), []);
  }));
void test('rejected market candidates remain in the public universe with bounded deterministic selection', async () =>
  fixture(async (s, r) => {
    for (let i = 0; i < 4; i++)
      await r.recordUniverse(
        normalizeEvent({
          chain: 'bsc',
          tokenAddress: '0x' + String(i).padStart(40, '0'),
          source: 'signal',
          sourceEventAtMs: null,
          observedAtMs: 100 + i * 60000,
          evidenceFamily: 'attention',
          strength: 'weak',
          expiresAtMs: 1000,
          rawPayloadRef: 'hash',
          payload: {},
          decisionEligible: false
        }),
        'run',
        'seed',
        2
      );
    assert.deepEqual(s.db.prepare('SELECT COUNT(*) n FROM research_universe').get(), { n: 4 });
    assert.deepEqual(
      s.db.prepare("SELECT COUNT(*) n FROM research_sampling WHERE status='SELECTED'").get(),
      { n: 2 }
    );
    assert.deepEqual(s.db.prepare('SELECT COUNT(*) n FROM signals').get(), { n: 0 });
  }));
void test('terminal baselines and original coordinates cannot be rewritten', async () =>
  fixture(async (s, r) => {
    const f = makeFact();
    await r.recordFact(f, 'run', 2 ** 30);
    s.db
      .prepare(
        "INSERT INTO market_opportunities(opportunity_id,chain,token,pool_revision,model_hash,activation_fact_id,anchor_price,anchor_at_ms,state,state_json) VALUES ('op','bsc',?,'pool','model',?,'1',300,'READY','{}')"
      )
      .run(token, f.factId);
    s.db
      .prepare(
        "INSERT INTO evaluation_baselines(baseline_id,run_id,opportunity_id,track,protocol_hash,deadline_at_ms,status) VALUES ('b','run','op','market','v1',5000,'PENDING')"
      )
      .run();
    const update = s.db.prepare(
      "UPDATE evaluation_baselines SET status='VALID',price=?,available_at_ms=400 WHERE baseline_id='b' AND status='PENDING'"
    );
    assert.equal(update.run('1.3').changes, 1);
    assert.equal(update.run('1.1').changes, 0);
    assert.throws(
      () => s.db.prepare("UPDATE evaluation_baselines SET price='1.1'").run(),
      /terminal/
    );
    assert.throws(
      () => s.db.prepare("UPDATE market_opportunities SET anchor_price='2'").run(),
      /immutable/
    );
    assert.throws(
      () =>
        s.db.transaction(() => {
          s.db.prepare("UPDATE market_opportunities SET state='CONSUMED'").run();
          throw new Error('rollback');
        })(),
      /rollback/
    );
    assert.deepEqual(s.db.prepare('SELECT state FROM market_opportunities').get(), {
      state: 'READY'
    });
  }));

void test('archive resolves immutable fact IDs after online payload pruning and detects tampering', async () =>
  fixture(async (s, r) => {
    const { ResearchArchive } = await import('../../src/research/archive.js');
    const { writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'research-archive-'));
    try {
      const f = makeFact();
      await r.recordFact(f, 'run', 2 ** 30);
      const archive = new ResearchArchive(r, dir);
      await archive.pin('run', [f.factId], 2 ** 30);
      assert.deepEqual(await archive.maintain(10 * 86400000, 2 ** 30), { pruned: 0, archived: 1 });
      assert.deepEqual(await archive.resolve(f.factId), f);
      const row = s.db.prepare('SELECT archive_id FROM research_facts').get() as {
        archive_id: string;
      };
      await writeFile(join(dir, `${row.archive_id}.json`), '{}');
      await assert.rejects(archive.resolve(f.factId), /checksum/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));

void test('pinning an existing fact is idempotent even when the storage budget is full', async () =>
  fixture(async (s, r) => {
    const { ResearchArchive } = await import('../../src/research/archive.js');
    const f = makeFact();
    await r.recordFact(f, 'run', 2 ** 30);
    const archive = new ResearchArchive(r, 'unused');
    r.calibrateQuota(1000, 0);
    await archive.pin('run', [f.factId, f.factId], 5096);
    assert.equal(r.quotaBytes(), 5096);
    await archive.pin('run', [f.factId], 5096);
    assert.equal(r.quotaBytes(), 5096);
    assert.deepEqual(s.db.prepare('SELECT status FROM research_runs').get(), { status: 'ACTIVE' });
    assert.deepEqual(s.db.prepare('SELECT COUNT(*) n FROM research_fact_references').get(), {
      n: 1
    });
  }));

void test('opportunity persistence is compare-and-swap and retains the original anchor after restart', async () =>
  fixture(async (_s, r) => {
    const { watchingState } = await import('../../src/decision/opportunity.js');
    const f = makeFact();
    await r.recordFact(f, 'run', 2 ** 30);
    const state = {
      ...watchingState(token, 'unresolved', 'model'),
      status: 'READY' as const,
      opportunityId: 'op',
      activationFactId: f.factId,
      anchorPrice: '1',
      anchorAtMs: 300,
      version: 1
    };
    assert.deepEqual(
      await Promise.all([r.saveOpportunity('run', state, 0), r.saveOpportunity('run', state, 0)]),
      [true, false]
    );
    assert.deepEqual(await r.loadOpportunity('run', 'model', token, 'unresolved'), state);
    const updated = { ...state, version: 2, lastEvaluationAtMs: 600 };
    assert.equal(await r.saveOpportunity('run', updated, 1), true);
    assert.equal((await r.loadOpportunity('run', 'model', token, 'unresolved'))?.anchorPrice, '1');
  }));

void test('persisted state JSON cannot disagree with immutable anchor columns', async () =>
  fixture(async (_s, r) => {
    const { watchingState } = await import('../../src/decision/opportunity.js');
    const f = makeFact();
    await r.recordFact(f, 'run', 2 ** 30);
    const state = {
      ...watchingState(token, 'unresolved', 'model'),
      status: 'READY' as const,
      opportunityId: 'op-anchor',
      activationFactId: f.factId,
      anchorPrice: '1',
      anchorAtMs: 300,
      version: 1
    };
    await r.saveOpportunity('run', state, 0);
    await assert.rejects(
      r.saveOpportunity('run', { ...state, anchorPrice: '2', version: 2 }, 1),
      /IDENTITY_CHANGED/
    );
    assert.equal((await r.loadOpportunity('run', 'model', token, 'unresolved'))?.version, 1);
  }));

void test('baseline deadlines, CAS and outcome attempts survive retry without changing coordinates', async () =>
  fixture(async (s, r) => {
    const { MeasurementStore } = await import('../../src/research/measurement-store.js');
    const f = makeFact();
    await r.recordFact(f, 'run', 2 ** 30);
    s.db
      .prepare(
        `INSERT INTO market_opportunities(opportunity_id,chain,token,pool_revision,model_hash,activation_fact_id,anchor_price,anchor_at_ms,state,state_json)
    VALUES ('op','bsc',?,'unresolved','model',?,'1',300,'READY','{}')`
      )
      .run(token, f.factId);
    const m = new MeasurementStore(s);
    const input = {
      runId: 'run',
      opportunityId: 'op',
      track: 'post_confirmation_market_v1' as const,
      confirmationAtMs: 300,
      confirmationKind: 'SIMULATED' as const
    };
    const id = await m.begin(input);
    const value = {
      status: 'VALID' as const,
      reason: 'fixture',
      price: '1',
      availableAtMs: 301,
      sourceAtMs: 300,
      factId: f.factId
    };
    assert.equal(await m.settle(id, { ...value, availableAtMs: 6000 }), false);
    assert.equal(await m.settle(id, value), true);
    assert.equal(await m.settle(id, { ...value, price: '0.5' }), false);
    assert.equal(await m.begin(input), id);
    await assert.rejects(m.begin({ ...input, confirmationAtMs: 6000 }), /CONFIRMATION_CHANGED/);
    const task = await m.schedule(id, 1.3, 30301, 30301);
    for (let i = 0; i < 3; i++) {
      assert.equal(await m.claim(task, 40000 + i), true);
      assert.equal(await m.claim(task, 40000 + i), false);
      await m.finish(task, { outcome: 'UNKNOWN' }, 40001 + i);
    }
    assert.equal(await m.claim(task, 50000), false);
    assert.deepEqual(
      s.db
        .prepare('SELECT horizon_at_ms,attempts,status FROM research_outcome_tasks WHERE task_id=?')
        .get(task),
      { horizon_at_ms: 30301, attempts: 3, status: 'DONE' }
    );
    const second = await m.begin({ ...input, track: 'post_confirmation_quote_v1' });
    assert.equal(await m.recover(5300), 1);
    assert.equal(await m.settle(second, value), false);
  }));

void test('a bounded discovery batch does not overflow the physical fact writer queue', async () =>
  fixture(async (s) => {
    const { ResearchRecorder } = await import('../../src/research/recorder.js');
    const recorder = new ResearchRecorder(
      s,
      { mode: 'observe', run_id: 'batch', max_storage_bytes: 2 ** 30 },
      () => undefined
    );
    await recorder.start(1000);
    try {
      for (let i = 0; i < 300; i++)
        recorder.event(
          normalizeEvent({
            chain: 'bsc',
            tokenAddress: '0x' + i.toString(16).padStart(40, '0'),
            source: 'trending',
            sourceEventId: String(i),
            observedAtMs: 1000,
            sourceEventAtMs: 1000,
            evidenceFamily: 'attention',
            strength: 'weak',
            expiresAtMs: 61000,
            rawPayloadRef: 'fixture',
            payload: {}
          })
        );
      while (recorder.pending) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(recorder.stoppedReason, null);
      assert.equal(
        (s.db.prepare('SELECT COUNT(*) AS n FROM research_universe').get() as { n: number }).n,
        300
      );
    } finally {
      recorder.close();
    }
  }));
