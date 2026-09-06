import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canReenterFromFreshTrigger,
  eventDrivenReevaluationAtMs,
  episodeExpiryAtMs,
  klineResolutionForRoute,
  staggeredEvaluationAtMs
} from '../../src/decision/episode-policy.js';
import { recordScore, transition } from '../../src/decision/episode.js';
import { EvidenceBook } from '../../src/decision/evidence.js';
import { ObservationPool } from '../../src/decision/observation-pool.js';

class SimulatedClock {
  constructor(public nowMs: number) {}
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

void test('applies route expiry, narrative extension, and requires a fresh post-terminal trigger', () => {
  const expiry = { new_launch: 15, revival: 30, continuation: 15, narrative: 60 };
  assert.equal(episodeExpiryAtMs(0, 'new_launch', expiry, false), 15 * 60_000);
  assert.equal(episodeExpiryAtMs(0, 'new_launch', expiry, true), 60 * 60_000);
  assert.equal(
    canReenterFromFreshTrigger({ state: 'EXPIRED', endedAtMs: 100 }, 101, 150, 60),
    true
  );
  assert.equal(
    canReenterFromFreshTrigger({ state: 'EXPIRED', endedAtMs: 100 }, 100, 150, 60),
    false
  );
  assert.equal(canReenterFromFreshTrigger({ state: 'SENT', endedAtMs: 100 }, 101, 150, 60), false);
});

void test('uses route-appropriate Kline and deterministically spreads refreshes over the next window', () => {
  assert.equal(eventDrivenReevaluationAtMs(1_000), 1_000);
  assert.equal(klineResolutionForRoute('revival'), '1m');
  assert.equal(klineResolutionForRoute('new_launch'), '30s');
  const due = Array.from({ length: 60 }, (_, index) =>
    staggeredEvaluationAtMs(1_000, `0x${index.toString(16)}`, 'continuation')
  );
  assert.ok(due.every((atMs) => atMs > 1_000 && atMs <= 31_000));
  assert.ok(new Set(due).size > 40);
  assert.equal(
    staggeredEvaluationAtMs(1_000, '0xab', 'revival'),
    staggeredEvaluationAtMs(1_000, '0xab', 'revival')
  );
});

void test('simulates the observation lifecycle across expiry, reverse flow, capacity, staggering and restart', () => {
  const clock = new SimulatedClock(1_000_000);
  const episode = {
    id: 'simulated',
    state: 'DISCOVERED' as const,
    lowScoreChecks: 0,
    sentAtMs: null,
    endedAtMs: null
  };
  const expiryMinutes = { new_launch: 15, revival: 30, continuation: 15, narrative: 60 };
  const expiresAtMs = episodeExpiryAtMs(clock.nowMs, 'revival', expiryMinutes, false);
  let active = transition(episode, 'OBSERVING', clock.nowMs);
  const evidence = new EvidenceBook();
  evidence.add({
    id: 'capital-inflow',
    family: 'capital',
    score: 1,
    strength: 'strong',
    source: 'smart_money',
    createdAtMs: clock.nowMs,
    expiresAtMs: clock.nowMs + 300_000
  });
  assert.equal(evidence.hasMinimumEntryEvidence(clock.nowMs), true);
  clock.advance(300_000);
  assert.equal(evidence.active(clock.nowMs).length, 0);

  evidence.add({
    id: 'capital-inflow-again',
    family: 'capital',
    score: 1,
    strength: 'strong',
    source: 'smart_money',
    createdAtMs: clock.nowMs,
    expiresAtMs: clock.nowMs + 300_000
  });
  assert.equal(evidence.invalidate('capital'), true);
  assert.equal(evidence.hasMinimumEntryEvidence(clock.nowMs), false);

  const pool = new ObservationPool(60, 20);
  for (let index = 0; index < 60; index += 1)
    assert.equal(
      pool.admit({
        id: `pool-${index}`,
        route: 'new_launch',
        score: 65 + index / 100,
        completeness: 0.7,
        evidenceFreshness: 1,
        active: true
      }).admitted,
      true
    );
  const replacement = pool.admit({
    id: 'strong-replacement',
    route: 'revival',
    score: 90,
    completeness: 1,
    evidenceFreshness: 1,
    active: true
  });
  assert.equal(replacement.admitted, true);
  assert.equal(replacement.demotedId, 'pool-0');
  assert.equal(pool.active.length, 60);

  const staggered = Array.from({ length: 60 }, (_, index) =>
    staggeredEvaluationAtMs(clock.nowMs, `0x${index.toString(16)}`, 'revival')
  );
  assert.ok(staggered.every((dueAtMs) => dueAtMs > clock.nowMs && dueAtMs <= clock.nowMs + 30_000));
  assert.ok(new Set(staggered).size > 40);

  clock.nowMs = expiresAtMs;
  active = recordScore(active, 64, 65, clock.nowMs);
  clock.advance(1);
  active = recordScore(active, 64, 65, clock.nowMs);
  assert.equal(active.state, 'EXPIRED');
  const persistedAfterRestart = JSON.parse(JSON.stringify(active)) as typeof active;
  clock.advance(1);
  assert.equal(
    canReenterFromFreshTrigger(persistedAfterRestart, clock.nowMs, clock.nowMs, 120_000),
    true
  );
});
