/**
 * The posting decision is the boundary with Article 14.
 *
 * These tests state, mechanically, that a provider file never becomes ledger
 * truth on its own: a settlement posting needs a deterministic match AND a
 * bank entry confirming the batch, and an exception needs a named person.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildCorpus } from '../src/corpus.ts';
import { disposition, openCases } from '../src/exceptions.ts';
import { ADJUSTMENT_ACCOUNT, decidePostings, settlementTotal } from '../src/posting.ts';
import { DEFAULT_CONFIG, EARLY_CUTOFF, NO_BANK_CUTOFF, run } from '../src/pipeline.ts';

const corpus = buildCorpus();
const L = corpus.landmarks;
const base = { expectations: corpus.expectations, files: corpus.files };
const r = run({ ...base, config: DEFAULT_CONFIG });
const noBank = run({ ...base, config: NO_BANK_CUTOFF });
const early = run({ ...base, config: EARLY_CUTOFF });

const of = (id: string) => r.instructions.filter((i) => i.subjectId === id);
const count = (d: string, src = r) => src.instructions.filter((i) => i.disposition === d).length;

test('with no bank statement, nothing is posted as settlement', () => {
  assert.equal(noBank.bank.length, 0);
  assert.equal(count('POST_SETTLEMENT', noBank), 0);
  assert.ok(count('DEFER', noBank) > 150);
});

test('the same row is matched in both runs and posts in only one of them', () => {
  const id = L.splitCapture!;
  const a = r.explanations.find((x) => x.subjectId === id)!;
  const b = noBank.explanations.find((x) => x.subjectId === id)!;
  assert.equal(a.rule, b.rule);
  assert.equal(a.outcome, b.outcome);
  assert.equal(r.instructions.find((i) => i.subjectId === id)!.disposition, 'POST_SETTLEMENT');
  assert.equal(noBank.instructions.find((i) => i.subjectId === id)!.disposition, 'DEFER');
});

test('every settlement posting names both a rule and a bank confirmation', () => {
  for (const i of r.instructions) {
    if (i.disposition !== 'POST_SETTLEMENT') continue;
    assert.match(i.basis, /^matched by M[1-5]_/);
    assert.match(i.basis, /confirmed by dep-\d+/);
    assert.ok(i.evidence.some((e) => e.startsWith('bank:')));
  }
});

test('a deferred instruction says what it is waiting for', () => {
  for (const i of noBank.instructions) {
    if (i.disposition !== 'DEFER') continue;
    assert.ok(/no bank entry confirms|no settlement evidence/.test(i.basis));
    assert.equal(i.netMinor, 0);
  }
});

test('an exception holds; it does not post', () => {
  for (const id of [L.missingProviderRecord!, L.partialSettlement!, L.currencyMismatch!]) {
    const [i] = of(id);
    assert.equal(i!.disposition, 'HOLD');
    assert.equal(i!.netMinor, 0);
    assert.match(i!.basis, /no posting until a disposition exists/);
  }
});

test('a within-tolerance difference posts an adjustment rather than vanishing', () => {
  const adj = of(L.toleranceOver!).filter((i) => i.disposition === 'POST_ADJUSTMENT');
  assert.equal(adj.length, 1);
  assert.equal(adj[0]!.netMinor, 1);
  assert.match(adj[0]!.basis, new RegExp(ADJUSTMENT_ACCOUNT));
});

test('the two within-tolerance residuals are posted separately, not netted', () => {
  const a = of(L.toleranceOver!).find((i) => i.disposition === 'POST_ADJUSTMENT')!;
  const b = of(L.toleranceUnder!).find((i) => i.disposition === 'POST_ADJUSTMENT')!;
  assert.equal(a.netMinor + b.netMinor, 0, 'they cancel');
  assert.equal(count('POST_ADJUSTMENT'), 2, 'and both are still posted');
});

test('the posted total equals the expected net of the matched rows', () => {
  let fromMatch = 0;
  for (const x of r.explanations) {
    if (x.side !== 'INTERNAL' || x.currency !== 'USD') continue;
    if (!x.outcome.startsWith('MATCHED')) continue;
    fromMatch += x.amountMinor;
  }
  assert.equal(settlementTotal(r.instructions, 'USD'), fromMatch);
});

test('the posted total is less than the bank deposits, by the held exceptions', () => {
  const bank = r.bank.reduce((a, b) => a + b.amountMinor, 0);
  assert.ok(settlementTotal(r.instructions, 'USD') < bank);
});

test('a dispositioned exception becomes an adjustment that cites the case', () => {
  const cases = openCases(r.explanations, DEFAULT_CONFIG.cutoff);
  const target = cases.find((c) => c.reason === 'MISSING_PROVIDER_RECORD')!;
  disposition(
    cases,
    {
      caseId: target.caseId,
      at: Date.UTC(2026, 2, 12),
      actor: 'finance-ops/reviewer-1',
      to: 'WRITTEN_OFF',
      action: 'WRITE_OFF',
      note: 'provider confirmed the capture never reached it; raised with the acquirer',
      evidenceSeen: target.evidence.map((l) => r.readEvidence(l) ?? ''),
    },
    r.readEvidence,
  );
  const again = decidePostings({
    explanations: r.explanations,
    records: new Map(r.records.map((x) => [x.recordId, x])),
    depositsByBatch: r.depositsByBatch,
    cases,
  });
  const i = again.find((x) => x.subjectId === target.subjectId)!;
  assert.equal(i.disposition, 'POST_ADJUSTMENT');
  assert.match(i.basis, /WRITE_OFF by finance-ops\/reviewer-1/);
  assert.ok(i.evidence.some((e) => e.startsWith('case:')));
});

test('a pending position defers rather than posting zero', () => {
  const pendingIds = early.explanations.filter((x) => x.outcome === 'PENDING').map((x) => x.subjectId);
  assert.ok(pendingIds.length > 0);
  for (const id of pendingIds.slice(0, 5)) {
    const i = early.instructions.find((x) => x.subjectId === id)!;
    assert.equal(i.disposition, 'DEFER');
    assert.match(i.basis, /the position is open, not wrong/);
  }
});

test('posting instructions are a function of the match, not of the file', () => {
  const fromFile = decidePostings({
    explanations: r.explanations,
    records: new Map(r.records.map((x) => [x.recordId, x])),
    depositsByBatch: r.depositsByBatch,
    cases: r.cases,
    mutations: { postFromFile: true },
  });
  assert.notEqual(settlementTotal(fromFile, 'USD'), settlementTotal(r.instructions, 'USD'));
  assert.equal(fromFile.length, r.records.length);
});

test('every instruction has a stable identifier and the list is sorted', () => {
  const ids = r.instructions.map((i) => i.instructionId);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
});
