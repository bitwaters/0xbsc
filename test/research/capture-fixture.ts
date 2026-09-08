import { Storage } from '../../src/storage/database.js';
import { ResearchStorage } from '../../src/research/storage.js';
import { createMarketFact } from '../../src/gmgn/facts.js';
export const token = '0x' + 'a'.repeat(40),
  pool = '0x' + 'b'.repeat(40),
  epoch = 1800000000000;
export async function captureFixture() {
  const storage = await Storage.open(':memory:');
  const research = new ResearchStorage(storage);
  await research.startRun('run', { mode: 'collect' }, epoch - 1000);
  const fact = createMarketFact({
    request: { method: 'GET', path: '/v1/token/info', query: { address: token } },
    response: { data: { price: { price: '1' }, liquidity: '100', biggest_pool_address: pool } },
    attemptId: 'initial',
    queuedAtMs: epoch - 100,
    requestedAtMs: epoch - 100,
    receivedAtMs: epoch,
    purpose: 'shared_collection'
  });
  await research.recordFact(fact, 'run', 2 ** 30);
  storage.db
    .prepare(
      `INSERT INTO market_opportunities(opportunity_id,chain,token,pool_revision,model_hash,activation_fact_id,anchor_price,anchor_at_ms,state,state_json)
    VALUES ('op','bsc',? ,?,'model',?,'1',?,'READY','{}')`
    )
    .run(token, pool, fact.factId, epoch);
  return { storage, research, fact };
}
