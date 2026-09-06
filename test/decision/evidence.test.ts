import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceBook, defaultEvidenceTtlMs, evidenceTtlMs } from '../../src/decision/evidence.js';

function evidence(
  id: string,
  family: 'lifecycle' | 'structure' | 'capital' | 'attention',
  score: number,
  strength: 'weak' | 'strong' = 'weak'
) {
  return { id, family, score, strength, createdAtMs: 0, expiresAtMs: 100, source: 'test' };
}

void test('caps each evidence family at its strongest active item', () => {
  const book = new EvidenceBook();
  assert.equal(book.add(evidence('low', 'capital', 1)), true);
  assert.equal(book.add(evidence('lower', 'capital', 0.5)), false);
  assert.equal(book.add(evidence('high', 'capital', 2)), true);
  assert.deepEqual(
    book.active(0).map((item) => item.id),
    ['high']
  );
});

void test('requires one strong or two independent weak evidence families', () => {
  const book = new EvidenceBook();
  book.add(evidence('one', 'capital', 1));
  assert.equal(book.hasMinimumEntryEvidence(0), false);
  book.add(evidence('two', 'attention', 1));
  assert.equal(book.hasMinimumEntryEvidence(0), true);
  const strong = new EvidenceBook();
  strong.add(evidence('strong', 'structure', 1, 'strong'));
  assert.equal(strong.hasMinimumEntryEvidence(0), true);
});

void test('refreshes a same-strength family only when the new evidence is newer', () => {
  const book = new EvidenceBook();
  assert.equal(
    book.add({ ...evidence('first', 'capital', 1), createdAtMs: 1, expiresAtMs: 2 }),
    true
  );
  assert.equal(
    book.add({ ...evidence('old', 'capital', 1), createdAtMs: 0, expiresAtMs: 99 }),
    false
  );
  assert.equal(
    book.add({ ...evidence('new', 'capital', 1), createdAtMs: 2, expiresAtMs: 99 }),
    true
  );
  assert.deepEqual(
    book.active(3).map((item) => item.id),
    ['new']
  );
});

void test('expires and immediately invalidates contrary evidence', () => {
  const book = new EvidenceBook();
  book.add(evidence('flow', 'capital', 1));
  assert.equal(book.invalidate('capital'), true);
  assert.equal(book.active(0).length, 0);
  book.add(evidence('short', 'attention', 1));
  assert.equal(book.active(100).length, 0);
  assert.equal(defaultEvidenceTtlMs.lifecycle, 600_000);
  assert.equal(evidenceTtlMs('attention', false), 600_000);
  assert.equal(evidenceTtlMs('attention', true), 1_800_000);
  assert.equal(
    evidenceTtlMs('structure', false, {
      lifecycle: 1,
      structure: 2,
      capital: 3,
      attention: 4,
      narrative: 5
    }),
    2_000
  );
});
