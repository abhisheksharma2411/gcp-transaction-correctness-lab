/**
 * The core invariant, and the experiment the article is built on.
 *
 * Every expected monetary amount is matched, legitimately pending, explained
 * by a recorded adjustment, or assigned to an owned exception. No difference
 * disappears through aggregation — including, deliberately, inside this
 * checker: the conservation test is per row, because a per-currency version
 * cannot see two residuals that cancel.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildCorpus } from '../src/corpus.ts';
import { netOf } from '../src/money.ts';
import { providerNetFromRaw } from '../src/oracle.ts';
import { DEFAULT_CONFIG, run } from '../src/pipeline.ts';

const corpus = buildCorpus();
const r = run({ expectations: corpus.expectations, files: corpus.files, config: DEFAULT_CONFIG });

test('THE EXPERIMENT: the period tie-out is exactly zero', () => {
  assert.equal(r.aggregate.expected, r.aggregate.provider);
  assert.equal(r.aggregate.provider, r.aggregate.bank);
  assert.equal(r.aggregate.difference, 0);
  assert.equal(r.aggregate.differenceToProvider, 0);
});

test('THE EXPERIMENT: and seven rows inside it are wrong', () => {
  assert.equal(r.cases.length, 7);
  const exposure = r.cases.reduce((a, c) => a + Math.abs(c.amountMinor), 0);
  assert.equal(exposure, 150655);
});

test('the internal and provider sides each carry the same unexplained amount', () => {
  const usd = r.conservation.find((c) => c.currency === 'USD')!;
  const part = r.providerPartition.find((p) => p.currency === 'USD')!;
  assert.equal(usd.residualMinor, 63085);
  assert.equal(part.unattributedMinor, 63085);
});

test('row conservation: expected net equals settled net plus residual, every row', () => {
  assert.deepEqual(r.rowBreaches, []);
});

test('currency conservation holds in every currency', () => {
  assert.ok(r.conservation.length >= 2);
  for (const c of r.conservation) assert.equal(c.holds, true);
});

test('the EUR expectation is entirely unexplained in EUR', () => {
  const eur = r.conservation.find((c) => c.currency === 'EUR')!;
  assert.equal(eur.settledMinor, 0);
  assert.equal(eur.expectedMinor, eur.residualMinor);
});

test('provider conservation: every minor unit is attributed or named unattributed', () => {
  for (const p of r.providerPartition) assert.equal(p.holds, true);
});

test('the oracle re-derives the provider total from the raw bytes', () => {
  const live = r.store.live().map((f) => ({
    fileId: f.fileId,
    format: f.format,
    bytes: r.store.read(f.fileId) ?? '',
  }));
  const raw = providerNetFromRaw(live);
  let viaParser = 0;
  for (const rec of r.records) viaParser += rec.netMinor;
  let viaOracle = 0;
  for (const v of raw.values()) viaOracle += v;
  assert.equal(viaOracle, viaParser);
});

test('the oracle reads by field name, so a column order change cannot agree with it', () => {
  const reordered =
    'merchant_ref,txn_id,type,gross,fee,net,currency,event_date,batch_id\n' +
    'ord-1,tx-1,CAPTURE,100.00,3.00,97.00,USD,2026-03-02,bt-01\n';
  const totals = providerNetFromRaw([{ fileId: 'f-x', format: 'acq-csv', bytes: reordered }]);
  assert.equal(totals.get('USD'), 9700);
});

test('expected totals are independently derivable from the expectations', () => {
  let expected = 0;
  for (const e of corpus.expectations) expected += netOf(e.grossMinor, e.expectedFeeMinor);
  assert.equal(expected, r.aggregate.expected);
});

test('every expectation appears in exactly one internal explanation', () => {
  const internal = r.explanations.filter((x) => x.side === 'INTERNAL');
  assert.equal(internal.length, corpus.expectations.length);
  assert.equal(new Set(internal.map((x) => x.subjectId)).size, corpus.expectations.length);
});

test('an aggregate tie-out at the deposit level is blind to all seven defects', () => {
  // Removing every defect would not change the period number, which is the
  // point: the number was already right.
  assert.equal(r.aggregate.difference, 0);
  assert.ok(r.cases.length > 0);
});

test('the report numbers are stable across two runs of the pipeline', () => {
  const again = run({ expectations: corpus.expectations, files: corpus.files, config: DEFAULT_CONFIG });
  assert.deepEqual(again.aggregate, r.aggregate);
  assert.deepEqual(again.conservation, r.conservation);
  assert.deepEqual(again.providerPartition, r.providerPartition);
});
