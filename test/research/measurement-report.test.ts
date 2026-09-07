import assert from 'node:assert/strict';
import test from 'node:test';
import {
  measurementReport,
  type MeasurementReportInput
} from '../../src/research/measurement-report.js';
const sample: MeasurementReportInput['expected'][number] = {
  runId: 'run',
  modelHash: 'model',
  sampleId: 'sample',
  token: 'token',
  track: 'post_confirmation_market_v1',
  protocolHash: 'protocol',
  confirmationKind: 'ACTUAL',
  confirmationAtMs: 1000,
  horizonMs: 86400000
};
void test('report uses registered denominator even when observations and targets are absent', () => {
  const expected = Array.from({ length: 7 }, (_, i) => ({
    ...sample,
    sampleId: String(i),
    token: String(i)
  }));
  const labels = ['TP', 'SL', 'NOT_TOUCHED', 'CENSORED', 'UNKNOWN'] as const;
  const observations: MeasurementReportInput['observations'] = labels.map((outcome, i) => ({
    ...expected[i]!,
    baselineStatus: 'VALID',
    baselineReason: 'FIRST_ELIGIBLE_PRICE',
    availableAtMs: 1200 + i * 100,
    targets: [{ target: 1.3, outcome, reason: outcome }]
  }));
  observations.push({
    ...expected[5]!,
    baselineStatus: 'UNVERIFIED',
    baselineReason: 'PRICE_SOURCE_UNVERIFIED',
    availableAtMs: null,
    targets: []
  });
  const report = measurementReport({ expected, observations });
  assert.equal(report.groups.length, 4);
  const g = report.groups.find((g) => g.target === 1.3)!;
  assert.equal(g.all, 7);
  assert.equal(g.baselineCoverage, 5 / 7);
  assert.equal(g.determinationCoverage, 3 / 7);
  assert.equal(g.tpConditional, 0.5);
  assert.equal(g.tpAll, 1 / 7);
  assert.deepEqual(g.successInterval, [1 / 7, 5 / 7]);
  assert.deepEqual(g.counts, {
    TP: 1,
    SL: 1,
    NOT_TOUCHED: 1,
    CENSORED: 1,
    UNKNOWN: 1,
    MISSING_BASELINE: 2
  });
  assert.equal(g.waitMs.p95, 600);
  assert.equal(g.missingMeasurements, 1);
  assert.equal(report.groups.find((g) => g.target === 2)!.counts.CENSORED, 5);
  assert.equal(report.promotionCertificate, false);
});
void test('card horizons, protocols, runs and simulated confirmations cannot be pooled', () => {
  const expected: MeasurementReportInput['expected'] = [
    sample,
    { ...sample, confirmationKind: 'SIMULATED' },
    { ...sample, protocolHash: 'new' },
    { ...sample, runId: 'new' },
    { ...sample, track: 'card_reference_legacy', horizonMs: 3600000 }
  ];
  const report = measurementReport({ expected, observations: [] });
  assert.equal(report.groups.length, 20);
  assert.ok(
    report.groups.every((g) => g.all === 1 && g.tpConditional === null && g.waitMs.max === null)
  );
  assert.equal(
    measurementReport({ expected: [], observations: [] }).status,
    'NO_REGISTERED_SAMPLES'
  );
});
void test('changed identity, double counting, unverified success and shifted baselines are rejected', () => {
  const observation: MeasurementReportInput['observations'][number] = {
    ...sample,
    baselineStatus: 'VALID',
    baselineReason: 'VALID',
    availableAtMs: 1100,
    targets: [{ target: 1.3, outcome: 'TP', reason: 'TP' }]
  };
  assert.throws(
    () => measurementReport({ expected: [sample, sample], observations: [] }),
    /DUPLICATE/
  );
  for (const patch of [
    { token: 'other' },
    { confirmationAtMs: 1001 },
    { horizonMs: 3600000 },
    { baselineStatus: 'UNVERIFIED' },
    { availableAtMs: 7000 }
  ]) {
    assert.throws(() =>
      measurementReport({ expected: [sample], observations: [{ ...observation, ...patch }] })
    );
  }
  assert.throws(
    () => measurementReport({ expected: [sample], observations: [observation, observation] }),
    /DUPLICATE/
  );
  assert.throws(
    () =>
      measurementReport({
        expected: [sample],
        observations: [
          { ...observation, targets: [...observation.targets, ...observation.targets] }
        ]
      }),
    /DUPLICATE_TARGET/
  );
});
