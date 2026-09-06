import assert from 'node:assert/strict';
import test from 'node:test';
import { runCandidateScope } from '../../src/decision/candidate-scope.js';
import { gmgnContext, withGmgnContext } from '../../src/gmgn/context.js';
import type { NormalizedEvent } from '../../src/discovery/events.js';
import type { Storage } from '../../src/storage/database.js';

void test('expired source evidence gets fresh research work time without changing evidence or formal recovery', async () => {
  let recoveryCalls = 0;
  const storage = {
    deferReadyCandidate: () => {
      recoveryCalls++;
      return Promise.resolve(0);
    }
  } as unknown as Storage;
  const event = { tokenAddress: '0xtest', observedAtMs: 100, expiresAtMs: 1000 } as NormalizedEvent;
  const before = JSON.stringify(event);
  await runCandidateScope(
    storage,
    event,
    { researchOnly: true, correlationId: 'r', now: () => 10_000 },
    () => {
      assert.equal(gmgnContext().deadlineMs, 40_000);
      assert.equal(gmgnContext().priority, 'evaluation');
      assert.equal(JSON.stringify(event), before);
      return Promise.resolve();
    }
  );
  await assert.rejects(
    runCandidateScope(
      storage,
      event,
      { researchOnly: true, correlationId: 'r', now: () => 10_000 },
      () => Promise.reject(new Error('unavailable'))
    )
  );
  assert.equal(recoveryCalls, 0);
  await assert.rejects(
    runCandidateScope(
      storage,
      event,
      { researchOnly: false, correlationId: 'f', now: () => 10_000 },
      () => {
        assert.equal(gmgnContext().deadlineMs, 1000);
        return Promise.reject(new Error('expired formal work'));
      }
    )
  );
  assert.equal(recoveryCalls, 1);
  await withGmgnContext({ deadlineMs: 11_000 }, () =>
    runCandidateScope(
      storage,
      event,
      { researchOnly: true, correlationId: 'r', now: () => 10_000 },
      () => {
        assert.equal(gmgnContext().deadlineMs, 11_000);
        return Promise.resolve();
      }
    )
  );
});
