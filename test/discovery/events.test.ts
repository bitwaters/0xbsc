import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KeyedSerialExecutor,
  LatestKeyedSerialExecutor,
  normalizeEvent,
  SnapshotDeduplicator,
  snapshotHash,
  stableEventKey
} from '../../src/discovery/events.js';
import { adaptGmgnResponse } from '../../src/discovery/adapters.js';

void test('creates restart-safe stable and snapshot event identifiers', () => {
  assert.equal(stableEventKey('signal', 'evt-1', '0xAB'), 'signal:evt-1:0xab');
  assert.equal(snapshotHash({ b: 2, a: 1 }), snapshotHash({ a: 1, b: 2 }));
  const event = normalizeEvent({
    chain: 'bsc',
    tokenAddress: '0xAB',
    source: 'trending',
    observedAtMs: 1,
    sourceEventAtMs: null,
    evidenceFamily: 'attention',
    strength: 'weak',
    expiresAtMs: 2,
    rawPayloadRef: 'raw:1',
    payload: { rank: 1 },
    pollKey: 'trending:1m',
    snapshotSequence: 2
  });
  assert.match(event.key, /^trending:trending:1m:0xab:2:/);
});

void test('persists snapshot state so unchanged data after restart cannot rescore', async () => {
  const initial = new SnapshotDeduplicator();
  const persisted: Array<{ event: ReturnType<typeof normalizeEvent> }> = [];
  const input = {
    chain: 'bsc' as const,
    tokenAddress: '0xAb',
    source: 'trending' as const,
    observedAtMs: 10,
    sourceEventAtMs: null,
    evidenceFamily: 'attention' as const,
    strength: 'weak' as const,
    expiresAtMs: 20,
    rawPayloadRef: 'raw:trending',
    payload: { rank: 3 },
    pollKey: 'trending:1m'
  };
  const first = await initial.ingest(input, (event) => {
    persisted.push({ event });
    return Promise.resolve(true);
  });
  assert.equal(first?.snapshotSequence, 1);
  assert.equal(await initial.ingest(input, () => Promise.resolve(true)), null);
  const restarted = new SnapshotDeduplicator(
    persisted.map(({ event }) => ({
      source: event.source,
      pollKey: event.pollKey ?? '',
      tokenAddress: event.tokenAddress,
      snapshotHash: event.snapshotHash ?? '',
      snapshotSequence: event.snapshotSequence ?? 0,
      expiresAtMs: event.expiresAtMs
    }))
  );
  assert.equal(await restarted.ingest(input, () => Promise.resolve(true)), null);
  const changed = await restarted.ingest({ ...input, payload: { rank: 2 } }, () =>
    Promise.resolve(true)
  );
  assert.equal(changed?.snapshotSequence, 2);
});

void test('allows an unchanged snapshot to renew evidence after its previous TTL expires', async () => {
  const deduplicator = new SnapshotDeduplicator();
  const input = {
    chain: 'bsc' as const,
    tokenAddress: '0xabc',
    source: 'trending' as const,
    observedAtMs: 10,
    sourceEventAtMs: null,
    evidenceFamily: 'attention' as const,
    strength: 'weak' as const,
    expiresAtMs: 20,
    rawPayloadRef: 'raw:renewal',
    payload: { rank: 1 },
    pollKey: 'trending:1m'
  };
  assert.ok(await deduplicator.ingest(input, () => Promise.resolve(true)));
  const renewed = await deduplicator.ingest({ ...input, observedAtMs: 20, expiresAtMs: 30 }, () =>
    Promise.resolve(true)
  );
  assert.equal(renewed?.snapshotSequence, 2);
});

void test('serializes events for one token while allowing other tokens to start', async () => {
  const executor = new KeyedSerialExecutor();
  const sequence: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = executor.enqueue('0xa', async () => {
    sequence.push('a1-start');
    await gate;
    sequence.push('a1-end');
  });
  const second = executor.enqueue('0xa', () => {
    sequence.push('a2');
  });
  const parallel = executor.enqueue('0xb', () => {
    sequence.push('b1');
  });
  await parallel;
  assert.deepEqual(sequence, ['a1-start', 'b1']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(sequence, ['a1-start', 'b1', 'a1-end', 'a2']);
});

void test('coalesces queued work for one token to its latest persisted state', async () => {
  const executor = new LatestKeyedSerialExecutor();
  const sequence: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = executor.enqueue('0xa', async () => {
    sequence.push('first');
    await gate;
  });
  const superseded = executor.enqueue('0xa', () => {
    sequence.push('superseded');
  });
  const latest = executor.enqueue('0xa', () => {
    sequence.push('latest');
  });
  await superseded;
  assert.deepEqual(sequence, ['first']);
  release();
  await Promise.all([first, latest]);
  assert.deepEqual(sequence, ['first', 'latest']);
});

void test('adapts every discovery source into BSC events and keeps unknown Signals audit-only', () => {
  const base = {
    pollKey: 'test',
    observedAtMs: 1_000,
    ttlMs: 100,
    response: {
      data: { list: [{ address: '0xabc', id: 'evt', trigger_at: 2, side: 'buy' }] }
    }
  };
  for (const source of ['trenches', 'trending', 'hot', 'smart_money', 'kol'] as const) {
    const [event] = adaptGmgnResponse({ ...base, source });
    assert.equal(event?.source, source);
    assert.equal(event?.tokenAddress, '0xabc');
    assert.equal(event?.sourceEventAtMs, 2_000);
    assert.match(event?.rawPayloadRef ?? '', /^sha256:/);
  }
  const [known] = adaptGmgnResponse({
    ...base,
    source: 'signal',
    response: { data: [{ token_address: '0xabc', id: 'one', signal_type: 12, trigger_at: 2 }] }
  });
  const [unknown] = adaptGmgnResponse({
    ...base,
    source: 'signal',
    response: { data: [{ token_address: '0xabc', id: 'two', signal_type: 999 }] }
  });
  assert.equal(known?.evidenceFamily, 'capital');
  assert.equal(known?.decisionEligible, true);
  assert.equal(unknown?.decisionEligible, false);
});

void test('adapts audited nested Rank, Hot, SmartMoney and KOL response shapes', () => {
  const common = { pollKey: 'live-shape', observedAtMs: 1_000, ttlMs: 100 };
  const trending = adaptGmgnResponse({
    ...common,
    source: 'trending',
    maxRank: 1,
    response: {
      data: {
        code: 0,
        data: {
          rank: [
            { address: '0xabc', liquidity: 10 },
            { address: '0xdef', liquidity: 20 }
          ]
        }
      }
    }
  });
  assert.deepEqual(
    trending.map((event) => event.tokenAddress),
    ['0xabc']
  );
  assert.equal(trending[0]?.payload.rank, 1);

  const hot = adaptGmgnResponse({
    ...common,
    source: 'hot',
    narrativeTtlMs: 1_800,
    response: { data: [{ interval: '1m', tokens: [{ address: '0xabc' }] }] }
  });
  assert.equal(hot[0]?.payload.hot_interval, '1m');
  assert.equal(hot[0]?.pollKey, 'live-shape:1m');
  assert.equal(hot[0]?.expiresAtMs, 2_800);

  for (const source of ['smart_money', 'kol'] as const) {
    const events = adaptGmgnResponse({
      ...common,
      source,
      response: {
        data: {
          list: [
            { base_address: '0xabc', transaction_hash: `${source}-buy`, side: 'buy', timestamp: 1 },
            {
              base_address: '0xdef',
              transaction_hash: `${source}-sell`,
              side: 'sell',
              timestamp: 1
            }
          ]
        }
      }
    });
    assert.deepEqual(
      events.map((event) => event.tokenAddress),
      ['0xabc', '0xdef']
    );
    assert.equal(events[0]?.sourceEventId, `${source}-buy`);
    assert.equal(events[1]?.payload.contrary, true);
  }
});

void test('buckets rank movement so small wiggles do not create decision snapshots', () => {
  const adaptRank = (rank: number) =>
    adaptGmgnResponse({
      source: 'trending',
      pollKey: 'trending:1m',
      observedAtMs: 1_000,
      ttlMs: 100,
      rankChangeStep: 5,
      response: { data: { list: [{ address: '0xabc', rank }] } }
    })[0]?.snapshotHash;
  assert.equal(adaptRank(1), adaptRank(5));
  assert.notEqual(adaptRank(5), adaptRank(6));
});

void test('keeps Hot time windows in independent snapshot streams', async () => {
  const events = adaptGmgnResponse({
    source: 'hot',
    pollKey: 'hot:short',
    observedAtMs: 1_000,
    ttlMs: 100,
    response: {
      data: [
        { interval: '1m', tokens: [{ address: '0xabc' }] },
        { interval: '5m', tokens: [{ address: '0xabc' }] }
      ]
    }
  });
  assert.deepEqual(
    events.map((event) => event.pollKey),
    ['hot:short:1m', 'hot:short:5m']
  );
  const deduplicator = new SnapshotDeduplicator();
  for (const event of events)
    assert.ok(
      await deduplicator.ingest({ ...event, pollKey: event.pollKey! }, () => Promise.resolve(true))
    );
  for (const event of events)
    assert.equal(
      await deduplicator.ingest({ ...event, pollKey: event.pollKey! }, () => Promise.resolve(true)),
      null
    );
});

void test('deduplicates snapshot volatility while retaining meaningful rank and safety changes', () => {
  const adapt = (price: string, rank: number, isHoneypot: boolean, top10 = 0.2) =>
    adaptGmgnResponse({
      source: 'trending',
      pollKey: 'trending:1m',
      response: {
        data: {
          data: {
            rank: [
              {
                address: '0xabc',
                price,
                volume: price,
                rank,
                is_honeypot: isHoneypot,
                top_10_holder_rate: top10
              }
            ]
          }
        }
      },
      observedAtMs: 1,
      ttlMs: 1_000,
      maxRank: 50,
      snapshotSafetyThresholds: {
        maxBuyTax: 0.05,
        maxSellTax: 0.05,
        maxTop10Percent: 0.5,
        maxTeamPercent: 0.1
      }
    })[0]!;
  assert.equal(adapt('1', 1, false).snapshotHash, adapt('2', 1, false).snapshotHash);
  assert.notEqual(adapt('1', 1, false).snapshotHash, adapt('1', 6, false).snapshotHash);
  assert.notEqual(adapt('1', 1, false).snapshotHash, adapt('1', 1, true).snapshotHash);
  assert.equal(adapt('1', 1, false, 0.2).snapshotHash, adapt('1', 1, false, 0.49).snapshotHash);
  assert.notEqual(adapt('1', 1, false, 0.49).snapshotHash, adapt('1', 1, false, 0.51).snapshotHash);
});

void test('uses the mapped evidence-family TTL for Signal events', () => {
  const [capital] = adaptGmgnResponse({
    source: 'signal',
    pollKey: 'signal',
    observedAtMs: 1_000,
    ttlMs: 999,
    ttlByFamilyMs: { capital: 300 },
    response: { data: [{ token_address: '0xabc', id: 'capital', signal_type: 12 }] }
  });
  assert.equal(capital?.expiresAtMs, 1_300);
});

void test('keeps an auditable raw digest while excluding inline base64 payloads from SQLite events', () => {
  const input = {
    source: 'trenches' as const,
    pollKey: 'trenches',
    observedAtMs: 1_000,
    ttlMs: 100,
    response: {
      data: { list: [{ address: '0xabc', liquidity: 10, logo_small_base64: 'very-large-binary' }] }
    }
  };
  const [first] = adaptGmgnResponse(input);
  const [changedArtwork] = adaptGmgnResponse({
    ...input,
    response: {
      data: { list: [{ address: '0xabc', liquidity: 10, logo_small_base64: 'other-binary' }] }
    }
  });
  assert.equal(first?.payload.logo_small_base64, undefined);
  assert.notEqual(first?.rawPayloadRef, changedArtwork?.rawPayloadRef);
  assert.equal(first?.snapshotHash, changedArtwork?.snapshotHash);
});

void test('replay keeps changed snapshots and asynchronous sources while filtering ranks beyond the configured boundary', async () => {
  const deduplicator = new SnapshotDeduplicator();
  const persisted: ReturnType<typeof normalizeEvent>[] = [];
  const input = {
    source: 'trending' as const,
    pollKey: 'trending:1m',
    observedAtMs: 1_000,
    ttlMs: 100,
    maxRank: 50,
    response: { data: { list: [{ address: '0xabc', rank: 50, liquidity: 10 }] } }
  };
  const [first] = adaptGmgnResponse(input);
  assert.ok(first);
  assert.ok(
    await deduplicator.ingest(
      { ...first, pollKey: first.pollKey! },
      (event) => (persisted.push(event), Promise.resolve(true))
    )
  );
  assert.equal(
    await deduplicator.ingest({ ...first, pollKey: first.pollKey! }, () => Promise.resolve(true)),
    null
  );
  const [changed] = adaptGmgnResponse({
    ...input,
    response: { data: { list: [{ address: '0xabc', rank: 45, liquidity: 11 }] } }
  });
  assert.ok(changed);
  assert.ok(
    await deduplicator.ingest(
      { ...changed, pollKey: changed.pollKey! },
      (event) => (persisted.push(event), Promise.resolve(true))
    )
  );
  const [otherSource] = adaptGmgnResponse({ ...input, source: 'hot', pollKey: 'hot:1m' });
  assert.equal(otherSource?.source, 'hot');
  assert.equal(persisted.length, 2);
  assert.deepEqual(
    adaptGmgnResponse({ ...input, response: { data: { list: [{ address: '0xdef', rank: 51 }] } } }),
    []
  );
});
