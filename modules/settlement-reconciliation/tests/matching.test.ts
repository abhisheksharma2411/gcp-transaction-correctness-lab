import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildCorpus } from '../src/corpus.ts';
import { DEFAULT_CONFIG, EARLY_CUTOFF, run } from '../src/pipeline.ts';
import type { Explanation } from '../src/types.ts';

const corpus = buildCorpus();
const L = corpus.landmarks;
const base = { expectations: corpus.expectations, files: corpus.files };
const r = run({ ...base, config: DEFAULT_CONFIG });
const early = run({ ...base, config: EARLY_CUTOFF });

const find = (id: string): Explanation => {
  const x = r.explanations.find((e) => e.subjectId === id);
  assert.ok(x, `no explanation for ${id}`);
  return x;
};
const byReason = (reason: string): Explanation[] =>
  r.explanations.filter((e) => e.reason === reason);

test('one to one: the provider transaction identifier matches most rows', () => {
  const m1 = r.explanations.filter((e) => e.rule === 'M1_PROVIDER_TXN_ID');
  assert.ok(m1.length > 150);
});

test('one to one, different identifier: reference, amount and currency match it', () => {
  const x = find(L.reissuedByProvider!);
  assert.equal(x.rule, 'M2_REF_AMOUNT_CURRENCY');
  assert.equal(x.outcome, 'MATCHED');
});

test('refund across days: a refund settled two days later still matches', () => {
  const x = find(L.refundAcrossDays!);
  assert.equal(x.rule, 'M3_REFUND_ACROSS_DAYS');
  assert.equal(x.outcome, 'MATCHED');
  assert.ok(x.amountMinor < 0, 'a refund is a negative expectation');
});

test('many to one: two provider rows summing to one expectation match it', () => {
  const x = find(L.splitCapture!);
  assert.equal(x.rule, 'M4_SPLIT_TO_ONE');
  assert.equal(x.counterpartIds.length, 2);
  assert.equal(x.residualMinor, 0);
});

test('partial settlement: the shortfall is named, not netted away', () => {
  const x = find(L.partialSettlement!);
  assert.equal(x.rule, 'M5_PARTIAL_SETTLEMENT');
  assert.equal(x.reason, 'PARTIAL_SETTLEMENT');
  assert.equal(x.residualMinor, 19420);
});

test('missing provider transaction: an expectation with no provider row', () => {
  const x = find(L.missingProviderRecord!);
  assert.equal(x.reason, 'MISSING_PROVIDER_RECORD');
  assert.equal(x.counterpartIds.length, 0);
  assert.equal(x.residualMinor, 43665);
});

test('provider transaction not known internally', () => {
  const unknown = byReason('UNKNOWN_TO_LEDGER');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]!.side, 'PROVIDER');
  assert.equal(unknown[0]!.residualMinor, 43665);
});

test('the missing and the unknown have the same amount and are not the same row', () => {
  const missing = find(L.missingProviderRecord!);
  const unknown = byReason('UNKNOWN_TO_LEDGER')[0]!;
  assert.equal(missing.residualMinor, unknown.residualMinor);
  assert.notEqual(missing.subjectId, unknown.subjectId);
  assert.equal(missing.counterpartIds.length, 0);
});

test('fee difference beyond tolerance is an exception on both sides of zero', () => {
  const fee = byReason('FEE_VARIANCE_BEYOND_TOLERANCE');
  assert.equal(fee.length, 2);
  const residuals = fee.map((f) => f.residualMinor).sort((a, b) => a - b);
  assert.deepEqual(residuals, [-120, 120]);
});

test('fee difference within tolerance is matched and the residual is recorded', () => {
  const over = find(L.toleranceOver!);
  const under = find(L.toleranceUnder!);
  assert.equal(over.outcome, 'MATCHED_WITH_ADJUSTMENT');
  assert.equal(under.outcome, 'MATCHED_WITH_ADJUSTMENT');
  assert.deepEqual([under.residualMinor, over.residualMinor].sort((a, b) => a - b), [-1, 1]);
});

test('a duplicated provider row is named as a duplicate, not as an unknown', () => {
  const dup = byReason('DUPLICATE_PROVIDER_RECORD');
  assert.equal(dup.length, 1);
  assert.equal(dup[0]!.side, 'PROVIDER');
});

test('currency is part of identity: the same number in another currency is an exception', () => {
  const x = find(L.currencyMismatch!);
  assert.equal(x.reason, 'CURRENCY_MISMATCH');
  assert.equal(x.currency, 'EUR');
  assert.equal(x.counterpartIds.length, 1);
});

test('one bank deposit covering two settlement batches', () => {
  const dep = find(L.multiBatchDeposit!);
  assert.equal(dep.side, 'BANK');
  assert.equal(dep.outcome, 'MATCHED');
  assert.equal(dep.counterpartIds.length, 2);
  assert.equal(dep.residualMinor, 0);
});

test('a negative payout is a debit and still ties out', () => {
  const dep = find(L.negativeDeposit!);
  assert.ok(dep.amountMinor < 0, 'the provider debited the account');
  assert.equal(dep.outcome, 'MATCHED');
});

test('every bank entry is explained', () => {
  const bankRows = r.explanations.filter((e) => e.side === 'BANK');
  assert.equal(bankRows.length, r.bank.length);
});

test('late file: before it arrives the position is pending, not an exception', () => {
  const pending = early.explanations.filter((e) => e.outcome === 'PENDING');
  assert.equal(pending.length, 22);
  assert.equal(early.cases.length, r.cases.length);
});

test('late file: the deposit arrives before the detail and still ties to the summary', () => {
  const dep = early.explanations.find((e) => e.subjectId === L.negativeDeposit!)!;
  assert.equal(dep.outcome, 'MATCHED');
});

test('late file: once it arrives the pending positions resolve', () => {
  assert.equal(r.explanations.filter((e) => e.outcome === 'PENDING').length, 0);
});

test('exactly seven exception cases, and each names a reason', () => {
  assert.equal(r.cases.length, 7);
  for (const c of r.cases) assert.ok(c.reason.length > 0);
});

test('every explanation cites the evidence it used', () => {
  for (const x of r.explanations) {
    if (x.counterpartIds.length > 0) assert.ok(x.evidence.length > 0, x.subjectId);
    for (const e of x.evidence) assert.match(e, /[#:]/);
  }
});

test('every explanation carries prose a person can read', () => {
  for (const x of r.explanations) assert.ok(x.text.length > 20, x.subjectId);
});

test('no provider record is both matched and unmatched', () => {
  const seen = new Set<string>();
  for (const x of r.explanations) {
    if (x.side === 'BANK') continue;
    const ids = x.side === 'PROVIDER' ? [x.subjectId] : x.counterpartIds;
    for (const id of ids) {
      assert.ok(!seen.has(id), `${id} appears twice`);
      seen.add(id);
    }
  }
  assert.equal(seen.size, r.records.length);
});

test('heuristic suggestions exist and none of them decided anything', () => {
  assert.ok(r.suggestions.length > 0);
  const suggested = new Set(r.suggestions.map((s) => s.recordId));
  for (const x of r.explanations) {
    for (const id of x.counterpartIds) {
      assert.ok(!suggested.has(id), 'a suggested record was consumed by a rule');
    }
  }
});

test('the top suggestion pairs the missing row with the unknown row', () => {
  const top = r.suggestions[0]!;
  assert.equal(top.expectationId, L.missingProviderRecord!);
  assert.equal(top.score, 1);
  const unknown = r.explanations.find((e) => e.reason === 'UNKNOWN_TO_LEDGER')!;
  assert.equal(top.recordId, unknown.subjectId);
});
