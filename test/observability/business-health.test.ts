import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessHealth } from '../../src/observability/business-health.js';
void test('business readiness detects a stalled safety pipeline and recovers on completed checks', () => {
  let now = 1000;
  const health = new BusinessHealth(() => now);
  try {
    now += 301000;
    health.safetyStarted();
    health.api('trending', {
      input: { method: 'GET', path: '/rank' },
      occurredAtMs: now,
      latencyMs: 1,
      status: 200,
      kind: 'success',
      retryCount: 0
    });
    assert.deepEqual(health.snapshot().reasons, ['SAFETY_PIPELINE_STALLED']);
    health.safetyFinished();
    health.shadowFinished();
    health.queueExpired();
    assert.equal(health.snapshot().status, 'ready');
    assert.equal(health.snapshot().queueTimeouts, 1);
    now += 301000;
    assert.ok(health.snapshot().reasons.includes('DISCOVERY_DATA_STALE'));
  } finally {
    health.close();
  }
});
