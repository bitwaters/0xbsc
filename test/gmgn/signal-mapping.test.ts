import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canContributeToDecision,
  classifySignalType,
  mapSignalType,
  signalMappingVersion
} from '../../src/gmgn/signal-mapping.js';

void test('maps officially documented BSC Signal semantics to evidence families', () => {
  assert.deepEqual(mapSignalType(12), {
    signalType: 12,
    semanticCategory: 'smart_degen_buy',
    evidenceFamily: 'capital',
    version: signalMappingVersion
  });
  assert.deepEqual(mapSignalType(11), {
    signalType: 11,
    semanticCategory: 'community_takeover',
    evidenceFamily: 'lifecycle',
    version: signalMappingVersion
  });
  assert.equal(canContributeToDecision(6), true);
  assert.equal(canContributeToDecision(14), false);
  assert.equal(canContributeToDecision(17), false);
});

void test('unknown Signal types are auditable but cannot score or trigger', () => {
  assert.equal(canContributeToDecision(999), false);
  assert.match(signalMappingVersion, /^gmgn-skills-market-signal-/);
  assert.deepEqual(classifySignalType(999), {
    signalType: 999,
    mappingVersion: signalMappingVersion,
    mapping: null,
    decisionEligible: false
  });
});
