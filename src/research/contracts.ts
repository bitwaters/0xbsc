import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { hashValue, protocolHash } from './protocol.js';
import { researchBudgetContractHash } from './budget-check.js';
import { PUBLICATION_COMPATIBILITY } from '../delivery/publication-guard.js';

/** Explicit semantic dependencies. Repository/docs commit IDs are deliberately not evidence identities. */
const dependencies = [
  '../decision/model',
  '../decision/opportunity',
  '../decision/preparation',
  '../decision/dry-publisher',
  '../decision/runtime',
  '../decision/pre-send',
  '../decision/episode',
  '../gmgn/facts',
  '../gmgn/quote',
  '../gmgn/limits',
  '../config/load',
  '../discovery/adapters',
  '../discovery/events',
  '../gmgn/client',
  '../gmgn/context',
  '../gmgn/api',
  '../gmgn/scheduler',
  '../safety/gmgn-adapter',
  '../safety/deep-gate',
  '../safety/permission-gate',
  '../safety/lazy-runtime',
  '../safety/coordinated-exit',
  '../quote/gate',
  '../quote/gmgn-provider',
  '../delivery/publication-guard',
  '../delivery/outbox',
  './protocol',
  './measurement',
  './measurement-store',
  './baseline-sampler',
  './outcome-collector',
  './quote-exits',
  './budget',
  './budget-check',
  './runtime',
  './replay',
  './candidates',
  './selection',
  './final-run',
  './ledger',
  './contracts',
  './validation'
];
export function semanticBuild() {
  const extension = fileURLToPath(import.meta.url).endsWith('.ts') ? '.ts' : '.js';
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pending = dependencies.map((path) => new URL(path + extension, import.meta.url));
  const seen = new Set<string>();
  const files: { path: string; hash: string }[] = [];
  while (pending.length) {
    const url = pending.pop()!;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    if (seen.size > 300) throw new Error('SEMANTIC_DEPENDENCY_BOUND');
    const text = readFileSync(url, 'utf8');
    files.push({
      path: relative(root, fileURLToPath(url)).replace(/\.(ts|js)$/, ''),
      hash: hashValue(text)
    });
    for (const match of text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)\.js['"]/g))
      pending.push(new URL(match[1]! + extension, url));
  }
  files.push({
    path: 'package-lock.json',
    hash: hashValue(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'))
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { hash: hashValue(files), files };
}
export function frozenContracts(modelHash: string, riskHash: string, controlHash: string) {
  return {
    version: 1,
    modelHash,
    riskHash,
    controlHash,
    codeHash: semanticBuild().hash,
    marketProtocolHash: protocolHash('post_confirmation_market_v1'),
    quoteProtocolHash: protocolHash('post_confirmation_quote_v1'),
    diagnosticProtocolHash: protocolHash('decision_market_replay_v1'),
    budgetContractHash: researchBudgetContractHash(),
    publisherVersion: 'dry-publisher-v1',
    template: 'opportunity-card-v1',
    compatibility: PUBLICATION_COMPATIBILITY
  };
}
export type FrozenContracts = ReturnType<typeof frozenContracts>;
