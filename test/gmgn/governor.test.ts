import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GmgnClient,
  GmgnError,
  parseRateLimitResponse,
  type ApiObservation
} from '../../src/gmgn/client.js';
import { GmgnScheduler, type Clock } from '../../src/gmgn/scheduler.js';
import { GmgnApi, ScheduledCandidateGmgnApi } from '../../src/gmgn/api.js';
import { withGmgnContext } from '../../src/gmgn/context.js';
import { LimiterStateFile } from '../../src/gmgn/limiter-state.js';

class FakeClock implements Clock {
  value = 1_788_652_800_000;
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
const ok = { status: 200, headers: {}, body: { code: 0, data: {} } };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

void test('network retries consume a second physical weight admission', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock);
  let calls = 0;
  const observed: ApiObservation[] = [];
  const client = new GmgnClient({
    baseUrl: 'https://invalid.example',
    apiKey: 'test',
    now: () => clock.now(),
    scheduler,
    weights: { holders: 5 },
    transport: () =>
      ++calls === 1 ? Promise.reject(new Error('connection reset')) : Promise.resolve(ok),
    onObservation: (value) => observed.push(value)
  });
  await client.read({ method: 'GET', path: '/v1/market/token_top_holders' });
  assert.equal(calls, 2);
  assert.equal(scheduler.bucket.available(clock.now()), 10);
  assert.deepEqual(
    observed.map((x) => [x.retryCount, x.attempt?.weight]),
    [
      [0, 5],
      [1, 5]
    ]
  );
  assert.notEqual(observed[0]?.attempt?.id, observed[1]?.attempt?.id);
});

void test('a concurrent 429 prevents a pending network retry and rejects queued work without charging it', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock);
  let rejectFirst!: (error: Error) => void;
  let calls = 0;
  const client = new GmgnClient({
    baseUrl: 'https://invalid.example',
    apiKey: 'test',
    now: () => clock.now(),
    scheduler,
    weights: { info: 1, quote: 2 },
    transport: () => {
      if (++calls === 1)
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      return Promise.resolve({
        status: 429,
        headers: {},
        body: { code: 429, error: 'RATE_LIMIT_BANNED', reset_at: clock.now() / 1000 + 300 }
      });
    }
  });
  const one = client.read({ method: 'GET', path: '/v1/token/info' });
  const firstRejected = assert.rejects(one, /cooling down/);
  await assert.rejects(client.read({ method: 'GET', path: '/v1/trade/quote' }), /rate limit/);
  rejectFirst(new Error('connection reset'));
  await firstRejected;
  await assert.rejects(client.read({ method: 'GET', path: '/v1/token/info' }), /cooling down/);
  assert.equal(calls, 2);
  assert.equal(scheduler.bucket.available(clock.now()), 17);
  assert.equal(scheduler.cooldownUntilMs - clock.now(), 300250);
});

void test('mixed 1/2/3/5-weight attempts and retries never exceed the hard rolling budget', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock, 14, 20, 6, { paced: true, maxConcurrent: 4 });
  const observed: ApiObservation[] = [];
  let calls = 0;
  const failed = new Set<number>();
  const client = new GmgnClient({
    baseUrl: 'https://invalid.example',
    apiKey: 'test',
    now: () => clock.now(),
    scheduler,
    weights: { info: 1, kline: 2, market_signal: 3, holders: 5 },
    transport: (input) => {
      calls++;
      const id = Number(input.query?.caseId);
      if (id % 7 === 0 && !failed.has(id)) {
        failed.add(id);
        return Promise.reject(new Error('reset'));
      }
      return Promise.resolve(ok);
    },
    onObservation: (value) => observed.push(value)
  });
  const paths = [
    '/v1/token/info',
    '/v1/market/token_kline',
    '/v1/market/token_signal',
    '/v1/market/token_top_holders'
  ];
  await withGmgnContext({ deadlineMs: clock.now() + 120000 }, () =>
    Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        client.read({ method: 'GET', path: paths[i % 4]!, query: { caseId: i } })
      )
    )
  );
  assert.ok(calls > 80);
  assert.equal(observed.length, calls);
  for (const row of observed) {
    const end = row.attempt!.startedAtMs;
    const sum = observed
      .filter((x) => x.attempt!.startedAtMs > end - 1000 && x.attempt!.startedAtMs <= end)
      .reduce((total, x) => total + x.attempt!.weight, 0);
    assert.ok(sum <= 20, `rolling weight ${sum}`);
  }
});

void test('formal Quote overtakes queued evaluation Quotes and uses the original scope deadline', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const priorities: string[] = [];
  const api = new ScheduledCandidateGmgnApi(
    new GmgnApi(
      new GmgnClient({
        baseUrl: 'https://invalid.example',
        apiKey: 'test',
        now: () => clock.now(),
        scheduler,
        weights: { quote: 2 },
        transport: async (input) => {
          order.push(String(input.query?.output_token));
          if (order.length === 1) await gate;
          return ok;
        },
        onObservation: (value) => priorities.push(value.attempt!.priority)
      })
    ),
    scheduler,
    clock,
    { quote: 2 }
  );
  const quote = (outputToken: string) =>
    api.quote({
      fromAddress: 'wallet',
      inputToken: 'in',
      outputToken,
      inputAmount: '1',
      slippagePercent: 5
    });
  const one = quote('first');
  const low = withGmgnContext({ priority: 'evaluation' }, () => quote('background'));
  const high = quote('formal');
  const expired = withGmgnContext({ deadlineMs: clock.now() + 10 }, () => quote('expired'));
  const rejected = assert.rejects(expired, /deadline expired/);
  await turn();
  clock.value += 11;
  release();
  await Promise.all([one, low, high, rejected]);
  assert.deepEqual(order, ['first', 'formal', 'background']);
  assert.deepEqual(priorities, ['formal', 'formal', 'evaluation']);
});

void test('reset parsing preserves body bans, respects later headers, and fails closed on missing or stale values', () => {
  const now = 1_788_652_800_000;
  const body = { code: 429, error: 'RATE_LIMIT_BANNED', reset_at: now / 1000 + 300 };
  const result = parseRateLimitResponse(
    {
      status: 429,
      headers: { 'X-RateLimit-Reset': String(now / 1000 + 2), 'Retry-After': '400' },
      body
    },
    now
  );
  assert.equal(result.retryAtMs, now + 400250);
  assert.equal(result.fallbackUsed, false);
  assert.equal(
    parseRateLimitResponse({ status: 429, headers: {}, body: null }, now).retryAtMs,
    now + 30000
  );
  assert.equal(
    parseRateLimitResponse(
      { status: 429, headers: { 'x-ratelimit-reset': '0' }, body: { error: 'RATE_LIMIT_BANNED' } },
      now
    ).retryAtMs,
    now + 300000
  );
});

void test('HTTP 200 business rate limit is classified and no malformed body can hide HTTP 429', async () => {
  for (const response of [
    { status: 200, headers: {}, body: { code: 429, error: 'RATE_LIMIT_EXCEEDED' } },
    { status: 429, headers: {}, body: null }
  ]) {
    const clock = new FakeClock();
    const client = new GmgnClient({
      baseUrl: 'https://invalid.example',
      apiKey: 'test',
      now: () => clock.now(),
      transport: () => Promise.resolve(response)
    });
    await assert.rejects(
      client.read({ method: 'GET', path: '/x' }),
      (error: unknown) => error instanceof GmgnError && error.kind === 'rate_limit'
    );
    assert.equal(client.cooldownUntilMs, clock.now() + 30000);
  }
});

void test('restart preserves cooldown and admits only one recovery probe until it succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmgn-limiter-'));
  try {
    const clock = new FakeClock();
    const file = new LimiterStateFile(join(dir, 'state.json'), 'https://invalid.example', 'test');
    const first = new GmgnScheduler(clock, 14, 20, 6, {
      paced: true,
      persistState: (state) => file.save(state)
    });
    first.pause(clock.now() + 300000);
    const restarted = new GmgnScheduler(clock, 14, 20, 6, {
      paced: true,
      maxConcurrent: 4,
      initialState: file.read()
    });
    const run = () => Promise.resolve('ok');
    await assert.rejects(
      restarted.schedule({ weight: 1, priority: 'formal', run }),
      /cooling down/
    );
    clock.value += 300001;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const probe = restarted.schedule({
      weight: 1,
      priority: 'formal',
      run: async () => {
        started++;
        await gate;
      }
    });
    const next = restarted.schedule({
      weight: 1,
      priority: 'formal',
      run: () => {
        started++;
        return Promise.resolve();
      }
    });
    await turn();
    assert.equal(started, 1);
    release();
    await Promise.all([probe, next]);
    assert.equal(started, 2);
    assert.equal(
      new LimiterStateFile(
        join(dir, 'state.json'),
        'https://invalid.example',
        'different-key'
      ).read().blockedUntilMs,
      0
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('unmapped endpoints cannot silently consume weight one', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const client = new GmgnClient({
    baseUrl: 'https://invalid.example',
    apiKey: 'test',
    now: () => clock.now(),
    scheduler: new GmgnScheduler(clock),
    weights: {},
    transport: () => {
      calls++;
      return Promise.resolve(ok);
    }
  });
  await assert.rejects(client.read({ method: 'GET', path: '/unmapped' }), /missing configured/);
  assert.equal(calls, 0);
});

void test('discovery and candidate Gas share fresh data without charging cache hits', async () => {
  const clock = new FakeClock();
  const scheduler = new GmgnScheduler(clock);
  let calls = 0;
  const client = new GmgnClient({
    baseUrl: 'https://invalid.example',
    apiKey: 'test',
    now: () => clock.now(),
    scheduler,
    weights: { gas: 1 },
    transport: () => {
      calls++;
      return Promise.resolve({ ...ok, body: { code: 0, data: { native_token_usd_price: '300' } } });
    }
  });
  const raw = new GmgnApi(client, 5000, () => clock.now());
  const candidate = new ScheduledCandidateGmgnApi(raw, scheduler, clock, { gas: 1 });
  await withGmgnContext({ priority: 'discovery' }, () => raw.gas());
  await candidate.gas();
  assert.equal(calls, 1);
  assert.equal(scheduler.bucket.available(clock.now()), 19);
  clock.value += 5001;
  await candidate.gas();
  assert.equal(calls, 2);
});

void test('Quote endpoint spacing does not block ready market reads and is restart-safe', async () => {
  const clock = new FakeClock();
  const saved: Array<{ channelNextAtMs?: Record<string, number> }> = [];
  const scheduler = new GmgnScheduler(clock, 14, 20, 0, {
    paced: true,
    maxConcurrent: 4,
    channelIntervalsMs: { quote: 600 },
    persistState: (state) => saved.push(state)
  });
  const times: number[] = [];
  const quote = () =>
    scheduler.schedule({
      weight: 2,
      priority: 'formal',
      channel: 'quote',
      run: () => {
        times.push(clock.now());
        return Promise.resolve();
      }
    });
  await quote();
  const firstAt = times[0]!;
  let marketAt = 0;
  const market = scheduler.schedule({
    weight: 1,
    priority: 'discovery',
    run: () => {
      marketAt = clock.now();
      return Promise.resolve();
    }
  });
  await Promise.all([market, quote(), quote()]);
  assert.ok(marketAt < firstAt + 600);
  assert.ok(times[1]! - times[0]! >= 600);
  assert.ok(times[2]! - times[1]! >= 600);
  assert.equal(saved.at(-1)?.channelNextAtMs?.quote, times[2]! + 600);
});
