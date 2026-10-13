import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildCorpus } from '../src/corpus.ts';
import { decimalToMinor, minorToDecimal } from '../src/money.ts';
import { ParseRefusal, isoDateToMs, parseFile } from '../src/parsers.ts';
import { DEFAULT_CONFIG, run } from '../src/pipeline.ts';
import type { FileRecord } from '../src/types.ts';

const corpus = buildCorpus();
const base = { expectations: corpus.expectations, files: corpus.files };
const current = run({ ...base, config: DEFAULT_CONFIG });
const previous = run({ ...base, config: DEFAULT_CONFIG, mutations: { parserGeneration: 1 } });

function fakeFile(format: string): FileRecord {
  return {
    fileId: 'f-test', source: 'test', declaredName: 't', digest: '0'.repeat(64),
    crc32c: '00000000', format, formatVersion: '1', receivedAt: 0, byteLength: 0,
    disposition: 'ACCEPTED', supersedes: null, supersededBy: null, note: '',
  };
}

test('two provider formats reach the same canonical record shape', () => {
  const sources = new Set(current.records.map((r) => r.parserVersion));
  assert.ok(sources.has('acq-csv@2'));
  assert.ok(sources.has('psp-jsonl@1'));
});

test('every normalized record carries its parser version', () => {
  for (const r of current.records) assert.match(r.parserVersion, /@\d+$/);
});

test('every normalized record locates its own raw evidence', () => {
  for (const r of current.records) {
    assert.ok(r.fileId.length > 0);
    assert.ok(r.line >= 2 || r.parserVersion.startsWith('psp'));
    assert.ok(current.readEvidence(`${r.fileId}#${r.line}`) !== undefined);
  }
});

test('parser version change: the old suite refuses the new schema', () => {
  assert.equal(previous.parseRefusals.length, 1);
  assert.match(previous.parseRefusals[0]!.message, /version 2 schema/);
});

test('parser version change: refusing loses records rather than inventing them', () => {
  assert.ok(previous.records.length < current.records.length);
});

test('the new suite re-parses an old file to the identical canonical records', () => {
  const v1File = current.fileRecords.find(
    (f) => f.declaredName === 'detail-2026-03-02.csv' && f.disposition === 'ACCEPTED',
  )!;
  const bytes = current.store.read(v1File.fileId)!;
  const withGen2 = parseFile(v1File, bytes, 2).records.map((r) => ({ ...r, parserVersion: '' }));
  const withGen1 = parseFile(v1File, bytes, 1).records.map((r) => ({ ...r, parserVersion: '' }));
  assert.deepEqual(withGen2, withGen1);
});

test('an unrecognised header is refused, not guessed at', () => {
  assert.throws(
    () => parseFile(fakeFile('acq-csv'), 'a,b,c\n1,2,3\n', 2),
    (e: unknown) => e instanceof ParseRefusal,
  );
});

test('an unknown format is refused', () => {
  assert.throws(() => parseFile(fakeFile('camt.053'), '{}', 2), ParseRefusal);
});

test('a provider row whose stated net contradicts its gross and fee is not repaired', () => {
  const bytes = 'txn_id,merchant_ref,type,gross,fee,net,currency,event_date,batch_id\n' +
    'tx-1,ord-1,CAPTURE,100.00,3.00,99.00,USD,2026-03-02,bt-01\n';
  const [rec] = parseFile(fakeFile('acq-csv'), bytes, 2).records;
  assert.equal(rec!.grossMinor, 10000);
  assert.equal(rec!.feeMinor, 300);
  assert.equal(rec!.netMinor, 9900, 'the parser keeps what the provider said');
});

test('an amount that is not two decimal places is a parse failure', () => {
  assert.throws(() => decimalToMinor('12.3', 'USD'));
  assert.throws(() => decimalToMinor('12', 'USD'));
  assert.throws(() => decimalToMinor('1,200.00', 'USD'));
});

test('minor units round-trip through the decimal rendering', () => {
  for (const v of [0, 1, -1, 99, 100, -2500, 1621534]) {
    assert.equal(decimalToMinor(minorToDecimal(v, 'USD'), 'USD'), v);
  }
});

test('an unsupported currency is refused rather than defaulted', () => {
  const bytes = 'txn_id,merchant_ref,type,gross,fee,net,currency,event_date,batch_id\n' +
    'tx-1,ord-1,CAPTURE,100.00,3.00,97.00,JPY,2026-03-02,bt-01\n';
  assert.throws(() => parseFile(fakeFile('acq-csv'), bytes, 2), ParseRefusal);
});

test('an unknown transaction type is refused rather than mapped to a guess', () => {
  const bytes = 'txn_id,merchant_ref,type,gross,fee,net,currency,event_date,batch_id\n' +
    'tx-1,ord-1,ADVANCE,100.00,3.00,97.00,USD,2026-03-02,bt-01\n';
  assert.throws(() => parseFile(fakeFile('acq-csv'), bytes, 2), ParseRefusal);
});

test('dates are read as UTC days, not as local time', () => {
  assert.equal(isoDateToMs('2026-03-04'), Date.UTC(2026, 2, 4));
});

test('the bank statement and the settlement summary parse into their own shapes', () => {
  assert.equal(current.bank.length, 3);
  assert.equal(current.summaries.length, 4);
  for (const s of current.summaries) assert.ok(s.payoutRef.startsWith('po-'));
});

test('a settlement summary states the business day it covers', () => {
  for (const s of current.summaries) {
    assert.ok(s.businessDate > 0);
    assert.ok(s.fundingDate >= s.businessDate);
  }
});
