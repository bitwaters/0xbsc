import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchBudget } from '../../src/research/budget.js';
import { GmgnScheduler } from '../../src/gmgn/scheduler.js';
void test('research empty bucket admits weight five after 2.5 seconds and enforces minute quote quota', () => {
  const budget = new ResearchBudget(0);
  assert.equal(budget.waitMs(5, 0, false), 2500);
  assert.equal(budget.waitMs(5, 2500, false), 0);
  budget.consume(5, 2500, false);
  assert.equal(budget.waitMs(1, 2500, false), 500);
  const quotes = new ResearchBudget(0);
  for (let i = 1; i <= 6; i++) quotes.consume(2, i * 1000, true);
  assert.equal(quotes.waitMs(2, 7000, true), 54000);
  quotes.unhealthy(7000);
  assert.equal(quotes.waitMs(1, 10000, false), 57000);
});
void test('scheduler research is opt-in and cannot impersonate formal traffic', async () => {
  const clock = { now: () => 0, sleep: () => Promise.resolve(), random: () => 0 };
  const scheduler = new GmgnScheduler(clock, 14, 20, 6);
  await assert.rejects(
    scheduler.schedule({
      research: true,
      priority: 'formal',
      weight: 1,
      run: () => Promise.resolve(1)
    }),
    /RESEARCH_ADMISSION_DISABLED/
  );
  await assert.rejects(
    scheduler.schedule({
      research: true,
      priority: 'evaluation',
      weight: 1,
      run: () => Promise.resolve(1)
    }),
    /RESEARCH_ADMISSION_DISABLED/
  );
});
void test('shared scheduler charges physical research once and preserves formal reserve', async () => {
  let now = 0;
  const scheduler = new GmgnScheduler(
    {
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      random: () => 0
    },
    14,
    20,
    6,
    { researchEnabled: true, paced: true }
  );
  const result = await scheduler.schedule({
    research: true,
    priority: 'evaluation',
    weight: 5,
    run: (admission) => Promise.resolve(admission)
  });
  assert.equal(result.dispatchedAtMs, 2500);
  assert.ok(result.availableWeight >= 6);
});

void test('mixed arrivals measure formal delay and pause the research sell leg', async () => {
  const { budgetCheck } = await import('../../src/research/budget-check.js');
  const report = await budgetCheck();
  assert.equal(report.status, 'PASS');
  assert.ok(report.maximumAdditionalWaitMs! <= 3000);
  assert.ok(report.researchDispatched > 0);
  assert.ok(report.researchExcluded > 0);
  assert.equal(report.productionEnablement, false);
  assert.equal((await budgetCheck(2000)).status, 'INCONCLUSIVE');
});

void test('unregistered research pacing fails and recovered monitoring requires 60 healthy seconds', async () => {
  let now = 0;
  const clock = {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
    random: () => 0
  };
  assert.throws(
    () => new GmgnScheduler(clock, 14, 20, 6, { researchEnabled: true }),
    /registered paced/
  );
  const scheduler = new GmgnScheduler(clock, 14, 20, 6, { researchEnabled: true, paced: true });
  scheduler.setResearchMonitoringHealthy(false);
  now = 100000;
  scheduler.setResearchMonitoringHealthy(true);
  assert.equal(scheduler.researchBudget.waitMs(1, now, false), 60000);
  await assert.rejects(
    scheduler.schedule({
      research: true,
      priority: 'evaluation',
      weight: 1,
      deadlineMs: now + 1000,
      run: () => Promise.resolve()
    }),
    /deadline/
  );
});
