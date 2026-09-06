import assert from 'node:assert/strict';
import test from 'node:test';
import { latencyReports, stageLatencyReports } from '../../src/observability/latency.js';

void test('reports path/load percentiles without promoting budgets to SLOs', () => {
  const [report] = latencyReports([
    { path: 'deep_data', loadBand: 'low', durationMs: 10, failed: false },
    { path: 'deep_data', loadBand: 'low', durationMs: 20, failed: false },
    { path: 'deep_data', loadBand: 'low', durationMs: 40, failed: true }
  ]);
  assert.equal(report?.sampleCount, 3);
  assert.equal(report?.p50, 10);
  assert.equal(report?.p95, 20);
  assert.equal(report?.failureRate, 1 / 3);
  assert.equal(report?.theoreticalBudgetMs, 3000);
  assert.equal(report?.budgetStatus, 'theoretical_only');
});

void test('separates correlated stage timings by stage and load band', () => {
  const reports = stageLatencyReports([
    {
      correlationId: 'a',
      loadBand: 'normal',
      stage: 'api_batch',
      startedAtMs: 0,
      completedAtMs: 20,
      failed: false
    },
    {
      correlationId: 'b',
      loadBand: 'normal',
      stage: 'api_batch',
      startedAtMs: 0,
      completedAtMs: 40,
      failed: false
    },
    {
      correlationId: 'a',
      loadBand: 'normal',
      stage: 'telegram_confirmation',
      startedAtMs: 20,
      completedAtMs: 50,
      failed: true
    }
  ]);
  assert.deepEqual(
    reports.map((report) => [report.path, report.sampleCount, report.p50, report.failureRate]),
    [
      ['api_batch', 2, 20, 0],
      ['telegram_confirmation', 1, null, 1]
    ]
  );
  assert.ok(reports.every((report) => report.budgetStatus === 'theoretical_only'));
});
