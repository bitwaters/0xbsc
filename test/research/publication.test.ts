import assert from 'node:assert/strict';
import test from 'node:test';
import { Storage } from '../../src/storage/database.js';
import { PublicationGuard } from '../../src/delivery/publication-guard.js';

void test('expired publisher lease cannot send, and UNKNOWN reservation survives lease takeover', async () => {
  const s = await Storage.open(':memory:');
  let now = 1000;
  try {
    s.db.exec(
      "INSERT INTO tokens(chain,address,first_seen_at_ms,updated_at_ms) VALUES ('bsc','0xtoken',0,0); INSERT INTO config_revisions VALUES ('cfg','{}',0);"
    );
    s.db
      .prepare(
        "INSERT INTO episodes(id,chain,token_address,route,state,config_revision_id,created_at_ms,updated_at_ms) VALUES ('ep','bsc','0xtoken','new_launch','DELIVERY_PENDING','cfg',0,0)"
      )
      .run();
    s.db
      .prepare(
        "INSERT INTO signals(id,episode_id,config_revision_id,delivery_state,quote_snapshot_json,decision_json,created_at_ms,updated_at_ms) VALUES ('sig','ep','cfg','PENDING','{}','{}',0,0)"
      )
      .run();
    const guard = new PublicationGuard(s, () => now);
    const first = await guard.acquire();
    assert.ok(first);
    assert.equal(await guard.acquire(), null);
    now += 61000;
    const second = await guard.acquire();
    assert.ok(second);
    assert.equal(await guard.reserve(first, 'sig'), false);
    assert.equal(await guard.reserve(second, 'sig'), true);
    await guard.release(second);
    const third = await guard.acquire();
    assert.ok(third);
    assert.equal(await guard.reserve(third, 'sig'), false);
    assert.equal((await s.pendingOutboxSignals(now, true)).length, 0);
    await s.expireOutdatedConfiguration('new-config', now);
    assert.deepEqual(s.db.prepare('SELECT state FROM publication_token_locks').get(), {
      state: 'UNKNOWN'
    });
  } finally {
    s.close();
  }
});
