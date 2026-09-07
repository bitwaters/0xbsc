import assert from 'node:assert/strict';
import test from 'node:test';
import { GmgnClient, GmgnError } from '../../src/gmgn/client.js';
import { GmgnApi, ScheduledCandidateGmgnApi } from '../../src/gmgn/api.js';
import { GmgnScheduler, WeightedTokenBucket, type Clock } from '../../src/gmgn/scheduler.js';
import type { LimiterState } from '../../src/gmgn/limiter-state.js';

class FakeClock implements Clock {
  value = 0;
  now(): number {
    return this.value;
  }
  sleep(ms: number): Promise<void> {
    this.value += ms;
    return Promise.resolve();
  }
  random(): number {
    return 0.5;
  }
}

void test('Quote spacing starts after completion and remains separate from other endpoint work', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock, 14, 20, 0, {
    channelCompletionIntervalsMs: { quote: 1000 }
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starts: number[] = [];
  const first = scheduler.schedule({
    weight: 2,
    priority: 'formal',
    channel: 'quote',
    run: async () => {
      starts.push(clock.now());
      await gate;
      clock.value = 800;
    }
  });
  const second = scheduler.schedule({
    weight: 2,
    priority: 'formal',
    channel: 'quote',
    run: () => {
      starts.push(clock.now());
      return Promise.resolve();
    }
  });
  let infoAt: number | null = null;
  await scheduler.schedule({
    weight: 1,
    priority: 'candidate',
    run: () => {
      infoAt = clock.now();
      return Promise.resolve();
    }
  });
  assert.equal(infoAt, 0);
  assert.deepEqual(starts, [0]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(starts, [0, 1800]);
});

void test('Quote 429 persists adaptive spacing and cannot resume until reset plus the completion gap', async () => {
  const clock = new FakeClock();
  let state: LimiterState | undefined;
  const policy = {
    channelCompletionIntervalsMs: { quote: 1000 },
    persistState: (value: LimiterState) => {
      state = structuredClone(value);
    }
  };
  const scheduler = new GmgnScheduler(clock, 14, 20, 0, policy);
  await assert.rejects(
    scheduler.schedule({
      weight: 2,
      priority: 'formal',
      channel: 'quote',
      run: () => {
        clock.value = 300;
        scheduler.noteRateLimit('quote');
        scheduler.pause(5000);
        return Promise.reject(new Error('429'));
      }
    }),
    /429/
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state?.channelBackoffMs?.quote, 2000);
  assert.equal(state?.channelNextAtMs?.quote, 7000);
  const restarted = new GmgnScheduler(clock, 14, 20, 0, { ...policy, initialState: state });
  await assert.rejects(
    restarted.schedule({
      weight: 2,
      priority: 'formal',
      channel: 'quote',
      run: () => Promise.resolve()
    }),
    /cooling down/
  );
  clock.value = 5000;
  let dispatched = 0;
  await restarted.schedule({
    weight: 2,
    priority: 'formal',
    channel: 'quote',
    run: () => {
      dispatched = clock.now();
      return Promise.resolve();
    }
  });
  assert.equal(dispatched, 7000);
  restarted.noteRateLimit('quote');
  restarted.noteRateLimit('quote');
  assert.equal(restarted.snapshot().quoteCompletionGapMs, 3000);
});

void test('a completion persistence failure stops further network work with an observable error', async () => {
  const clock = new FakeClock();
  let saves = 0;
  const scheduler = new GmgnScheduler(clock, 14, 20, 0, {
    channelCompletionIntervalsMs: { quote: 1000 },
    persistState: () => {
      if (++saves > 1) throw new Error('disk full');
    }
  });
  let requests = 0;
  const task = {
    weight: 2,
    priority: 'formal' as const,
    channel: 'quote',
    run: () => {
      requests++;
      return Promise.resolve();
    }
  };
  await scheduler.schedule(task);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(scheduler.schedule(task), /completion persistence failed/);
  assert.equal(requests, 1);
  assert.equal(scheduler.snapshot().persistenceFailed, true);
});

void test('refills weighted tokens at the soft limit and caps burst at the hard limit', () => {
  const bucket = new WeightedTokenBucket(14, 20, 0);
  assert.equal(bucket.consume(20, 0), true);
  assert.equal(bucket.waitMs(14, 0), 1_000);
  assert.equal(bucket.consume(14, 1_000), true);
  assert.equal(bucket.available(11_000), 20);
});

void test('schedules formal work before lower priority work and rejects re-entry', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock);
  const calls: string[] = [];
  const first = scheduler.schedule({
    key: 'trending',
    weight: 1,
    priority: 'discovery',
    run: () => {
      calls.push('discovery');
      return Promise.resolve('d');
    }
  });
  await assert.rejects(
    scheduler.schedule({
      key: 'trending',
      weight: 1,
      priority: 'discovery',
      run: () => Promise.resolve('duplicate')
    }),
    /already running/
  );
  const formal = scheduler.schedule({
    weight: 1,
    priority: 'formal',
    run: () => {
      calls.push('formal');
      return Promise.resolve('f');
    }
  });
  assert.deepEqual(await Promise.all([first, formal]), ['d', 'f']);
  assert.deepEqual(calls, ['discovery', 'formal']);
});

void test('expires stale queued work before it invokes the task', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock);
  await assert.rejects(
    scheduler.schedule({
      weight: 1,
      priority: 'evaluation',
      deadlineMs: -1,
      run: () => Promise.resolve('nope')
    }),
    /deadline expired/
  );
});

void test('routes candidate operations through the physical scheduler exactly once', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock, 14, 20);
  const paths: string[] = [];
  const weights = { info: 1, kline: 2, gas: 1, quote: 2 };
  const api = new ScheduledCandidateGmgnApi(
    new GmgnApi(
      new GmgnClient({
        baseUrl: 'https://invalid.example',
        apiKey: 'test',
        now: () => clock.now(),
        scheduler,
        weights,
        transport: (input) => {
          paths.push(input.path);
          return Promise.resolve({ status: 200, headers: {}, body: { data: {} } });
        }
      })
    ),
    scheduler,
    clock,
    weights
  );
  await api.token('/v1/token/info', 'token');
  await api.kline('token', '30s');
  await api.gas();
  await api.quote({
    fromAddress: 'wallet',
    inputToken: 'in',
    outputToken: 'out',
    inputAmount: '1',
    slippagePercent: 5
  });
  assert.equal(paths.length, 4);
  assert.equal(scheduler.bucket.available(clock.now()), 14);
});

void test('starts independent admitted requests concurrently while retaining their consumed weight', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock, 14, 20);
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = scheduler.schedule({
    weight: 1,
    priority: 'discovery',
    run: async () => {
      started.push('first');
      await gate;
      return 'first';
    }
  });
  const second = scheduler.schedule({
    weight: 1,
    priority: 'discovery',
    run: async () => {
      started.push('second');
      await gate;
      return 'second';
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'second']);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
});

void test('lets formal work preempt a lower-priority item waiting for tokens', async () => {
  class BlockingClock implements Clock {
    value = 0;
    sleepers: Array<{ ms: number; resolve: () => void }> = [];
    now(): number {
      return this.value;
    }
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => this.sleepers.push({ ms, resolve }));
    }
    random(): number {
      return 0.5;
    }
    wakeNext(): void {
      const sleeper = this.sleepers.shift();
      assert.ok(sleeper);
      this.value += sleeper.ms;
      sleeper.resolve();
    }
  }
  const clock = new BlockingClock();
  const scheduler = new GmgnScheduler(clock, 1, 1);
  await scheduler.schedule({ weight: 1, priority: 'discovery', run: () => Promise.resolve() });
  const calls: string[] = [];
  const lower = scheduler.schedule({
    weight: 1,
    priority: 'evaluation',
    run: () => (calls.push('evaluation'), Promise.resolve('evaluation'))
  });
  await new Promise((resolve) => setImmediate(resolve));
  const formal = scheduler.schedule({
    weight: 1,
    priority: 'formal',
    run: () => (calls.push('formal'), Promise.resolve('formal'))
  });
  clock.wakeNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['formal']);
  clock.wakeNext();
  assert.deepEqual(await Promise.all([lower, formal]), ['evaluation', 'formal']);
  assert.deepEqual(calls, ['formal', 'evaluation']);
});

void test('keeps the configured burst reserve available for formal work', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock, 14, 20, 6);
  await scheduler.schedule({
    weight: 14,
    priority: 'discovery',
    run: () => Promise.resolve()
  });
  assert.equal(scheduler.bucket.available(clock.now()), 6);
  await scheduler.schedule({
    weight: 6,
    priority: 'formal',
    run: () => Promise.resolve()
  });
  assert.equal(scheduler.bucket.available(clock.now()), 0);
});

void test('keeps discovery ahead of candidate analysis and candidate analysis ahead of observation', async () => {
  class BlockingClock implements Clock {
    value = 0;
    sleepers: Array<{ ms: number; resolve: () => void }> = [];
    now(): number {
      return this.value;
    }
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => this.sleepers.push({ ms, resolve }));
    }
    random(): number {
      return 0.5;
    }
    wakeNext(): void {
      const sleeper = this.sleepers.shift();
      assert.ok(sleeper);
      this.value += sleeper.ms;
      sleeper.resolve();
    }
  }
  const clock = new BlockingClock();
  const scheduler = new GmgnScheduler(clock, 1, 1);
  await scheduler.schedule({ weight: 1, priority: 'formal', run: () => Promise.resolve() });
  const calls: string[] = [];
  const observation = scheduler.schedule({
    weight: 1,
    priority: 'observation',
    run: () => (calls.push('observation'), Promise.resolve())
  });
  await new Promise((resolve) => setImmediate(resolve));
  const candidate = scheduler.schedule({
    weight: 1,
    priority: 'candidate',
    run: () => (calls.push('candidate'), Promise.resolve())
  });
  const discovery = scheduler.schedule({
    weight: 1,
    priority: 'discovery',
    run: () => (calls.push('discovery'), Promise.resolve())
  });
  clock.wakeNext();
  await new Promise((resolve) => setImmediate(resolve));
  clock.wakeNext();
  await new Promise((resolve) => setImmediate(resolve));
  clock.wakeNext();
  await Promise.all([observation, candidate, discovery]);
  assert.deepEqual(calls, ['discovery', 'candidate', 'observation']);
});

void test('Quotes share one in-flight request and recover after a failed leg', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock, 14, 20);
  let calls = 0,
    active = 0,
    maximum = 0;
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<unknown>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const api = new ScheduledCandidateGmgnApi(
    new GmgnApi(
      new GmgnClient({
        baseUrl: 'https://invalid.example',
        apiKey: 'test',
        now: () => clock.now(),
        scheduler,
        weights: { quote: 2 },
        transport: async () => {
          const number = ++calls;
          active++;
          maximum = Math.max(maximum, active);
          try {
            if (number === 1) await first;
            return { status: 200, headers: {}, body: { ok: true } };
          } finally {
            active--;
          }
        }
      })
    ),
    scheduler,
    clock,
    { quote: 2 }
  );
  const input = {
    fromAddress: 'wallet',
    inputToken: 'in',
    outputToken: 'out',
    inputAmount: '1',
    slippagePercent: 5
  };
  const one = api.quote(input);
  const rejected = assert.rejects(one, /limited/);
  const two = api.quote(input);
  const three = api.quote(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  rejectFirst(new GmgnError('schema', 'limited'));
  await Promise.all([rejected, two, three]);
  assert.equal(maximum, 1);
  assert.equal(calls, 3);
});
