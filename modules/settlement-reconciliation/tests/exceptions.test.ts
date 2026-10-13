import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildCorpus } from '../src/corpus.ts';
import { DispositionRefused, byReason, digestOf, disposition, openCases } from '../src/exceptions.ts';
import { DEFAULT_CONFIG, run } from '../src/pipeline.ts';
import type { ExceptionCase } from '../src/types.ts';

const corpus = buildCorpus();
const r = run({ expectations: corpus.expectations, files: corpus.files, config: DEFAULT_CONFIG });

const fresh = (): ExceptionCase[] => openCases(r.explanations, DEFAULT_CONFIG.cutoff);
const seen = (c: ExceptionCase): string[] => c.evidence.map((l) => r.readEvidence(l) ?? '');

const ok = (c: ExceptionCase, over: Partial<Parameters<typeof disposition>[1]> = {}) => ({
  caseId: c.caseId,
  at: Date.UTC(2026, 2, 11),
  actor: 'finance-ops/reviewer-1',
  to: 'ASSIGNED' as const,
  action: 'ASSIGN',
  note: 'picked up for review',
  evidenceSeen: seen(c),
  ...over,
});

test('a case is opened for every exception, and for nothing else', () => {
  const cases = fresh();
  assert.equal(cases.length, r.explanations.filter((x) => x.outcome === 'EXCEPTION').length);
  assert.equal(cases.length, 7);
});

test('every case names a reason an investigator can act on', () => {
  const reasons = new Set(fresh().map((c) => c.reason));
  assert.deepEqual(
    [...reasons].sort(),
    [
      'CURRENCY_MISMATCH',
      'DUPLICATE_PROVIDER_RECORD',
      'FEE_VARIANCE_BEYOND_TOLERANCE',
      'MISSING_PROVIDER_RECORD',
      'PARTIAL_SETTLEMENT',
      'UNKNOWN_TO_LEDGER',
    ],
  );
});

test('the exception summary reports count and exposure per reason', () => {
  const summary = byReason(fresh());
  const total = summary.reduce((a, s) => a + s.exposureMinor, 0);
  assert.equal(total, 150655);
});

test('a case starts open with an empty history', () => {
  for (const c of fresh()) {
    assert.equal(c.state, 'OPEN');
    assert.deepEqual(c.history, []);
  }
});

test('a disposition is appended, never substituted', () => {
  const cases = fresh();
  const c = cases[0]!;
  disposition(cases, ok(c), r.readEvidence);
  disposition(cases, ok(c, { to: 'PENDING_EVIDENCE', action: 'REQUEST_FILE', note: 'asked the provider to resend' }), r.readEvidence);
  disposition(cases, ok(c, { to: 'RESOLVED', action: 'ACCEPT', note: 'provider confirmed the figure' }), r.readEvidence);
  assert.equal(c.history.length, 3);
  assert.deepEqual(c.history.map((h) => h.action), ['ASSIGN', 'REQUEST_FILE', 'ACCEPT']);
  assert.equal(c.state, 'RESOLVED');
});

test('an unnamed actor is refused', () => {
  const cases = fresh();
  assert.throws(() => disposition(cases, ok(cases[0]!, { actor: '  ' }), r.readEvidence), DispositionRefused);
});

test('an empty note is refused', () => {
  const cases = fresh();
  assert.throws(() => disposition(cases, ok(cases[0]!, { note: '' }), r.readEvidence), DispositionRefused);
});

test('an illegal transition is refused', () => {
  const cases = fresh();
  const c = cases[0]!;
  disposition(cases, ok(c, { to: 'RESOLVED', action: 'ACCEPT', note: 'done' }), r.readEvidence);
  assert.throws(() => disposition(cases, ok(c, { to: 'ASSIGNED' }), r.readEvidence), DispositionRefused);
});

test('a decision taken against different evidence is refused', () => {
  const cases = fresh();
  const c = cases.find((x) => x.evidence.length > 0)!;
  assert.throws(
    () => disposition(cases, ok(c, { evidenceSeen: ['something the file does not say'] }), r.readEvidence),
    DispositionRefused,
  );
});

test('the recorded evidence digest is reproducible from the raw bytes', () => {
  const cases = fresh();
  const c = cases.find((x) => x.evidence.length > 0)!;
  disposition(cases, ok(c), r.readEvidence);
  assert.equal(c.history[0]!.evidenceDigest, digestOf(seen(c)));
});

test('a disposition cannot alter raw evidence', () => {
  const before = JSON.stringify(r.store.manifest());
  const cases = fresh();
  for (const c of cases) {
    disposition(cases, ok(c, { to: 'WRITTEN_OFF', action: 'WRITE_OFF', note: 'closed for the test' }), r.readEvidence);
  }
  assert.equal(JSON.stringify(r.store.manifest()), before);
});

test('a disposition cannot alter the reconciliation it is about', () => {
  const before = JSON.stringify(r.explanations);
  const cases = fresh();
  disposition(cases, ok(cases[0]!), r.readEvidence);
  assert.equal(JSON.stringify(r.explanations), before);
});

test('a terminal case accepts no further disposition', () => {
  const cases = fresh();
  const c = cases[1]!;
  disposition(cases, ok(c, { to: 'WRITTEN_OFF', action: 'WRITE_OFF', note: 'uncollectable' }), r.readEvidence);
  assert.throws(() => disposition(cases, ok(c, { to: 'RESOLVED', action: 'REOPEN', note: 'changed my mind' }), r.readEvidence), DispositionRefused);
});

test('an unknown case id is refused', () => {
  const cases = fresh();
  assert.throws(() => disposition(cases, ok(cases[0]!, { caseId: 'case-9999' }), r.readEvidence), DispositionRefused);
});
