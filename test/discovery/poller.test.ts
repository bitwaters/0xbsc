import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IsolatedPoller } from '../../src/discovery/poller.js';
import { DiscoveryPollingService } from '../../src/discovery/plan.js';
import { DiscoveryRuntime } from '../../src/discovery/runtime.js';
import { GmgnScheduler, type Clock } from '../../src/gmgn/scheduler.js';
import { Storage } from '../../src/storage/database.js';

class TestClock implements Clock {
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

void test('isolates source failures with capped backoff and resets after success', async () => {
  const clock = new TestClock();
  const scheduler = new GmgnScheduler(clock);
  const failing = new IsolatedPoller(scheduler, clock, {
    key: 'failing-source',
    weight: 1,
    intervalMs: 100,
    maxBackoffMs: 250
  });
  const healthy = new IsolatedPoller(scheduler, clock, {
    key: 'healthy-source',
    weight: 1,
    intervalMs: 100,
    maxBackoffMs: 250
  });
  const first = await failing.tick(() => Promise.reject(new Error('schema drift')));
  assert.equal(first.status, 'failed');
  assert.equal(first.nextDueAtMs, 100);
  assert.deepEqual(await healthy.tick(() => Promise.resolve('still-runs')), {
    status: 'success',
    value: 'still-runs',
    consecutiveFailures: 0,
    nextDueAtMs: 100
  });
  clock.value = 100;
  const second = await failing.tick(() => Promise.reject(new Error('schema drift')));
  assert.equal(second.nextDueAtMs, 300);
  clock.value = 300;
  const recovered = await failing.tick(() => Promise.resolve('recovered'));
  assert.deepEqual(recovered, {
    status: 'success',
    value: 'recovered',
    consecutiveFailures: 0,
    nextDueAtMs: 400
  });
});

void test('plans all configurable discovery sources with their own scheduler keys', async () => {
  const calls: string[] = [];
  const api = {
    signals: (groups: Array<{ signalTypes: number[] }>) => {
      calls.push(`signal:${groups[0]?.signalTypes.join(',')}`);
      return Promise.resolve({});
    },
    trenches: () => (calls.push('trenches'), Promise.resolve({})),
    rank: (interval: string) => (calls.push(`trending:${interval}`), Promise.resolve({})),
    hot: (params: Array<{ label: string }>) => (
      calls.push(`hot:${params.map((item) => item.label).join(',')}`),
      Promise.resolve({})
    ),
    smartMoney: () => (calls.push('smart_money'), Promise.resolve({})),
    kol: () => (calls.push('kol'), Promise.resolve({})),
    gas: () => (calls.push('gas'), Promise.resolve({}))
  };
  const config = {
    polling: {
      jitter_percent: 0.1,
      high_frequency_signal_seconds: 2,
      narrative_signal_seconds: 5,
      trenches_seconds: 5,
      smart_money_seconds: 2,
      kol_seconds: 3,
      trending_seconds: 5,
      trending_max_rank: 50,
      rank_change_step: 5,
      hot_short_seconds: 15,
      hot_long_seconds: 60,
      gas_seconds: 30,
      observation_seconds: 30,
      high_frequency_signal_types: [1, 6],
      narrative_signal_types: [2, 11]
    },
    gmgn: {
      endpoint_weights: {
        market_signal: 3,
        trenches: 3,
        trending: 1,
        hot: 3,
        smart_money: 1,
        kol: 1,
        gas: 1
      }
    }
  } as unknown as ConstructorParameters<typeof DiscoveryPollingService>[2];
  const clock = new TestClock();
  const service = new DiscoveryPollingService(new GmgnScheduler(clock), clock, config, api);
  assert.deepEqual(
    service.specs.map((spec) => spec.name),
    [
      'signal:high_frequency',
      'signal:narrative',
      'trenches',
      'trending:1m',
      'trending:5m',
      'trending:1h',
      'hot:short',
      'hot:long',
      'smart_money',
      'kol',
      'gas'
    ]
  );
  assert.equal(service.specs.find((spec) => spec.name === 'hot:long')?.intervalMs, 60_000);
  assert.ok((await service.tickAll()).every((outcome) => outcome.status === 'success'));
  assert.equal(calls.length, 11);
});

void test('persists adapted discovery events once and restores snapshot suppression after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-discovery-runtime-'));
  const path = join(directory, 'signal.db');
  const config = {
    polling: {
      jitter_percent: 0,
      high_frequency_signal_seconds: 1,
      narrative_signal_seconds: 1,
      trenches_seconds: 1,
      smart_money_seconds: 1,
      kol_seconds: 1,
      trending_seconds: 1,
      trending_max_rank: 50,
      rank_change_step: 5,
      hot_short_seconds: 1,
      hot_long_seconds: 1,
      gas_seconds: 1,
      observation_seconds: 1,
      high_frequency_signal_types: [1],
      narrative_signal_types: [2]
    },
    gmgn: {
      endpoint_weights: {
        market_signal: 1,
        trenches: 1,
        trending: 1,
        hot: 1,
        smart_money: 1,
        kol: 1,
        gas: 1
      }
    },
    evidence: {
      ttl_seconds: { lifecycle: 600, structure: 180, capital: 300, attention: 600, narrative: 1800 }
    }
  } as never;
  const api = {
    signals: () => Promise.resolve({ data: { list: [{ address: '0xabcdef', rank: 1 }] } }),
    trenches: () => Promise.resolve({}),
    rank: () => Promise.resolve({}),
    hot: () => Promise.resolve({}),
    smartMoney: () => Promise.resolve({}),
    kol: () => Promise.resolve({}),
    gas: () => Promise.resolve({})
  } as never;
  const clock = new TestClock();
  const first = await Storage.open(path);
  try {
    const observed: boolean[] = [];
    const runtime = new DiscoveryRuntime({
      config,
      storage: first,
      api,
      scheduler: new GmgnScheduler(clock),
      clock,
      onEventObserved: (_event, persisted) => observed.push(persisted)
    });
    await runtime.recover();
    assert.equal(await runtime.tick('signal:high_frequency'), 1);
    clock.value = 1_000;
    assert.equal(await runtime.tick('signal:high_frequency'), 0);
    assert.deepEqual(observed, [true, false]);
    assert.equal(
      (first.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      1
    );
  } finally {
    first.close();
  }
  const restarted = await Storage.open(path);
  try {
    const runtime = new DiscoveryRuntime({
      config,
      storage: restarted,
      api,
      scheduler: new GmgnScheduler(clock),
      clock
    });
    await runtime.recover();
    clock.value = 2_000;
    assert.equal(await runtime.tick('signal:high_frequency'), 0);
  } finally {
    restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('isolates a failed event consumer after persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-discovery-handler-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  const clock = new TestClock();
  const config = {
    polling: {
      jitter_percent: 0,
      high_frequency_signal_seconds: 1,
      narrative_signal_seconds: 1,
      trenches_seconds: 1,
      smart_money_seconds: 1,
      kol_seconds: 1,
      trending_seconds: 1,
      trending_max_rank: 50,
      rank_change_step: 5,
      hot_short_seconds: 1,
      hot_long_seconds: 1,
      gas_seconds: 1,
      observation_seconds: 1,
      high_frequency_signal_types: [1],
      narrative_signal_types: [2]
    },
    gmgn: {
      endpoint_weights: {
        market_signal: 1,
        trenches: 1,
        trending: 1,
        hot: 1,
        smart_money: 1,
        kol: 1,
        gas: 1
      }
    },
    evidence: {
      ttl_seconds: { lifecycle: 600, structure: 180, capital: 300, attention: 600, narrative: 1800 }
    }
  } as never;
  const api = {
    signals: () => Promise.resolve({ data: { list: [{ address: '0xabcdef', rank: 1 }] } }),
    trenches: () => Promise.resolve({}),
    rank: () => Promise.resolve({}),
    hot: () => Promise.resolve({}),
    smartMoney: () => Promise.resolve({}),
    kol: () => Promise.resolve({}),
    gas: () => Promise.resolve({})
  } as never;
  let errors = 0;
  try {
    const runtime = new DiscoveryRuntime({
      config,
      storage,
      api,
      scheduler: new GmgnScheduler(clock),
      clock,
      onEvent: () => Promise.reject(new Error('bad candidate')),
      onEventError: () => {
        errors += 1;
      }
    });
    assert.equal(await runtime.tick('signal:high_frequency'), 1);
    assert.equal(errors, 1);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('starts recurring polls before a slow bootstrap candidate completes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-discovery-start-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  const clock = new TestClock();
  const config = {
    polling: {
      jitter_percent: 0,
      high_frequency_signal_seconds: 0.001,
      narrative_signal_seconds: 60,
      trenches_seconds: 60,
      smart_money_seconds: 60,
      kol_seconds: 60,
      trending_seconds: 60,
      trending_max_rank: 50,
      rank_change_step: 5,
      hot_short_seconds: 60,
      hot_long_seconds: 60,
      gas_seconds: 60,
      observation_seconds: 60,
      high_frequency_signal_types: [1],
      narrative_signal_types: [2]
    },
    gmgn: {
      endpoint_weights: {
        market_signal: 1,
        trenches: 1,
        trending: 1,
        hot: 1,
        smart_money: 1,
        kol: 1,
        gas: 1
      }
    },
    evidence: {
      ttl_seconds: { lifecycle: 600, structure: 180, capital: 300, attention: 600, narrative: 1800 }
    }
  } as never;
  let signalCalls = 0;
  let release: (() => void) | undefined;
  const blockedCandidate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markCandidateStarted: (() => void) | undefined;
  const candidateStarted = new Promise<void>((resolve) => {
    markCandidateStarted = resolve;
  });
  const api = {
    signals: () => {
      signalCalls += 1;
      return Promise.resolve({ data: { list: [{ address: '0xabcdef', rank: 1 }] } });
    },
    trenches: () => Promise.resolve({}),
    rank: () => Promise.resolve({}),
    hot: () => Promise.resolve({}),
    smartMoney: () => Promise.resolve({}),
    kol: () => Promise.resolve({}),
    gas: () => Promise.resolve({})
  } as never;
  try {
    const runtime = new DiscoveryRuntime({
      config,
      storage,
      api,
      scheduler: new GmgnScheduler(clock),
      clock,
      onEvent: () => {
        markCandidateStarted?.();
        return blockedCandidate;
      }
    });
    await runtime.start(2);
    await candidateStarted;
    clock.value = 10;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.ok(signalCalls >= 2);
    release?.();
    runtime.stop();
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('continues discovery polling while downstream analysis is running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-discovery-non-reentrant-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  const clock = new TestClock();
  const config = {
    polling: {
      jitter_percent: 0,
      high_frequency_signal_seconds: 0.001,
      narrative_signal_seconds: 60,
      trenches_seconds: 60,
      smart_money_seconds: 60,
      kol_seconds: 60,
      trending_seconds: 60,
      trending_max_rank: 50,
      rank_change_step: 5,
      hot_short_seconds: 60,
      hot_long_seconds: 60,
      gas_seconds: 60,
      observation_seconds: 60,
      high_frequency_signal_types: [1],
      narrative_signal_types: [2]
    },
    gmgn: {
      endpoint_weights: {
        market_signal: 1,
        trenches: 1,
        trending: 1,
        hot: 1,
        smart_money: 1,
        kol: 1,
        gas: 1
      }
    },
    evidence: {
      ttl_seconds: { lifecycle: 600, structure: 180, capital: 300, attention: 600, narrative: 1800 }
    }
  } as never;
  let signalCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new DiscoveryRuntime({
    config,
    storage,
    api: {
      signals: () => {
        signalCalls += 1;
        return Promise.resolve({ data: { list: [{ address: '0xabcdef', id: 'one' }] } });
      },
      trenches: () => Promise.resolve({}),
      rank: () => Promise.resolve({}),
      hot: () => Promise.resolve({}),
      smartMoney: () => Promise.resolve({}),
      kol: () => Promise.resolve({}),
      gas: () => Promise.resolve({})
    } as never,
    scheduler: new GmgnScheduler(clock),
    clock,
    onEvent: () => gate
  });
  try {
    const first = runtime.tick('signal:high_frequency');
    await new Promise((resolve) => setImmediate(resolve));
    clock.value = 10;
    assert.equal(await runtime.tick('signal:high_frequency'), 0);
    assert.equal(signalCalls, 2);
    release();
    await runtime.work.drain();
    assert.equal(await first, 1);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('public universe includes candidates excluded by legacy ranking and snapshot deduplication', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const { runtimeConfigSchema } = await import('../../src/config/load.js');
  const config = runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')));
  config.polling.trending_max_rank = 1;
  const storage = await Storage.open(':memory:'),
    clock = new TestClock();
  const universe: string[] = [];
  const runtime = new DiscoveryRuntime({
    config,
    storage,
    clock,
    scheduler: new GmgnScheduler(clock),
    api: {
      rank: () =>
        Promise.resolve({
          data: {
            rank: [
              { address: '0x' + 'a'.repeat(40), rank: 1 },
              { address: '0x' + 'b'.repeat(40), rank: 2 }
            ]
          }
        })
    } as never,
    onUniverseObserved: (event) => universe.push(event.tokenAddress)
  });
  try {
    assert.equal(await runtime.tick('trending:1m'), 1);
    assert.equal(universe.length, 2);
    clock.value += config.polling.trending_seconds * 1000;
    assert.equal(await runtime.tick('trending:1m'), 0);
    assert.equal(universe.length, 4);
  } finally {
    storage.close();
  }
});

void test('replacement discovery delivers public candidates without writing or scheduling legacy events', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const { runtimeConfigSchema } = await import('../../src/config/load.js');
  const config = runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')));
  const storage = await Storage.open(':memory:'),
    clock = new TestClock();
  const universe: string[] = [];
  let legacyObserved = 0,
    legacyProcessed = 0;
  const runtime = new DiscoveryRuntime({
    config,
    storage,
    clock,
    scheduler: new GmgnScheduler(clock),
    universeOnly: true,
    api: {
      rank: () => Promise.resolve({ data: { rank: [{ address: '0x' + 'a'.repeat(40), rank: 1 }] } })
    } as never,
    onUniverseObserved: (event) => universe.push(event.tokenAddress),
    onEventObserved: () => {
      legacyObserved++;
    },
    onEvent: () => {
      legacyProcessed++;
      return Promise.resolve();
    }
  });
  try {
    await runtime.tick('trending:1m');
    clock.value += config.polling.trending_seconds * 1000;
    await runtime.tick('trending:1m');
    assert.equal(universe.length, 2);
    assert.equal(legacyObserved, 0);
    assert.equal(legacyProcessed, 0);
    assert.equal(
      (storage.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      0
    );
  } finally {
    storage.close();
  }
});
