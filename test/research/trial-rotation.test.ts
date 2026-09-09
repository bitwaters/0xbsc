import assert from 'node:assert/strict';
import test from 'node:test';
import { TrialRotation, type WaitingCandidate } from '../../src/decision/trial-rotation.js';
const candidate = (i: number, at = 0): WaitingCandidate => ({
  tokenAddress: '0x' + i.toString(16).padStart(40, '0'),
  key: String(i),
  firstQueuedAtMs: at,
  seenAtMs: at,
  eligibleAtMs: 0
});
void test('repeated high frequency discoveries do not overtake previously waiting candidates', () => {
  const q = new TrialRotation(1000);
  for (let i = 0; i < 200; i++) q.observe(candidate(i));
  for (let i = 0; i < 50; i++) {
    const row = q.take(0).candidate!;
    assert.equal(row.tokenAddress, candidate(i).tokenAddress);
    q.observe({ ...row, eligibleAtMs: 10 });
  }
  for (let i = 0; i < 50; i++) q.observe(candidate(i, 20));
  for (let i = 50; i < 200; i++)
    assert.equal(q.take(20).candidate?.tokenAddress, candidate(i).tokenAddress);
});
void test('cooldowns, pool changes, queue capacity and restart retain bounded fair ordering', () => {
  const q = new TrialRotation(3);
  const a = { ...candidate(1), pool: 'old', eligibleAtMs: 30 };
  q.observe(a);
  q.observe(candidate(2));
  q.observe(candidate(3));
  assert.equal(q.observe(candidate(4)), 'overflow');
  q.observe({ ...a, seenAtMs: 10, eligibleAtMs: 0 });
  assert.equal(q.take(10).candidate?.tokenAddress, candidate(2).tokenAddress);
  const restarted = new TrialRotation(3);
  restarted.restore(q.entries(), 10);
  assert.equal(restarted.take(10).candidate?.tokenAddress, candidate(3).tokenAddress);
  assert.equal(restarted.take(10).candidate, undefined);
  restarted.observe({ ...a, pool: 'new', seenAtMs: 11 });
  assert.equal(restarted.take(11).candidate?.pool, 'new');
});
void test('expired bursts are removed in bounded steps and cannot be mistaken for market failures', () => {
  const q = new TrialRotation(1000, 100);
  for (let i = 0; i < 500; i++) q.observe(candidate(i));
  const first = q.take(101);
  assert.equal(first.expired.length, 1);
  assert.equal(first.candidate, undefined);
  assert.equal(q.size, 499);
  const r = new TrialRotation();
  r.restore(q.entries(), 200000);
  assert.equal(r.size, 0);
});

void test('new observations bypass a revisit backlog while revisits cannot starve and lane survives restart', () => {
  const q = new TrialRotation(1000);
  for (let i = 0; i < 500; i++) q.observe({ ...candidate(i), revisit: true });
  for (let i = 500; i < 510; i++) q.observe(candidate(i, 10));
  const restored = new TrialRotation(1000);
  restored.restore(q.entries(), 10);
  const admitted = Array.from({ length: 8 }, () => restored.take(10).candidate!);
  assert.deepEqual(
    admitted.map((c) => c.tokenAddress),
    [500, 501, 502, 0, 503, 504, 505, 1].map((i) => candidate(i).tokenAddress)
  );
  const repeat = { ...candidate(2), revisit: true };
  restored.observe({ ...repeat, seenAtMs: 20 });
  assert.equal(
    restored.entries().find((c) => c.tokenAddress === repeat.tokenAddress)?.revisit,
    true
  );
});
