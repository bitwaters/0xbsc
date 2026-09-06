import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EpisodeTransitionError,
  recordScore,
  routeResetSatisfied,
  transition
} from '../../src/decision/episode.js';

const episode = {
  id: 'ep',
  state: 'DISCOVERED' as const,
  lowScoreChecks: 0,
  sentAtMs: null,
  endedAtMs: null
};

void test('enforces the Episode delivery path and terminal invariants', () => {
  const observing = transition(episode, 'OBSERVING', 1);
  const ready = transition(observing, 'READY', 2);
  const pending = transition(ready, 'DELIVERY_PENDING', 3);
  const sent = transition(pending, 'SENT', 4);
  assert.equal(sent.sentAtMs, 4);
  assert.equal(sent.endedAtMs, 4);
  assert.throws(() => transition(sent, 'OBSERVING', 5), EpisodeTransitionError);
  assert.throws(() => transition(observing, 'DELIVERY_PENDING', 3), EpisodeTransitionError);
});

void test('requires route-specific reset evidence before revival or continuation re-entry', () => {
  assert.equal(
    routeResetSatisfied('new_launch', {
      hasCompletedDormancy: false,
      hasHealthyPullbackAndRestart: false
    }),
    true
  );
  assert.equal(
    routeResetSatisfied('revival', {
      hasCompletedDormancy: false,
      hasHealthyPullbackAndRestart: true
    }),
    false
  );
  assert.equal(
    routeResetSatisfied('revival', {
      hasCompletedDormancy: true,
      hasHealthyPullbackAndRestart: false
    }),
    true
  );
  assert.equal(
    routeResetSatisfied('continuation', {
      hasCompletedDormancy: true,
      hasHealthyPullbackAndRestart: false
    }),
    false
  );
  assert.equal(
    routeResetSatisfied('continuation', {
      hasCompletedDormancy: false,
      hasHealthyPullbackAndRestart: true
    }),
    true
  );
});

void test('expires only after two consecutive low-score checks', () => {
  const observing = transition(episode, 'OBSERVING', 0);
  const first = recordScore(observing, 64, 65, 1);
  assert.equal(first.state, 'OBSERVING');
  assert.equal(first.lowScoreChecks, 1);
  const reset = recordScore(first, 65, 65, 2);
  assert.equal(reset.lowScoreChecks, 0);
  const expired = recordScore(recordScore(reset, 1, 65, 3), 1, 65, 4);
  assert.equal(expired.state, 'EXPIRED');
});

void test('returns a safe but temporarily costly ready candidate to observation', () => {
  const ready = transition(transition(episode, 'OBSERVING', 0), 'READY', 1);
  assert.equal(transition(ready, 'OBSERVING', 2).state, 'OBSERVING');
});
