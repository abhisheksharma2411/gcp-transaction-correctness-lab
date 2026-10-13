import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildCorpus } from '../src/corpus.ts';
import { crc32c } from '../src/crc32c.ts';
import { EvidenceStore } from '../src/intake.ts';
import { DEFAULT_CONFIG, run } from '../src/pipeline.ts';

const corpus = buildCorpus();
const result = run({ expectations: corpus.expectations, files: corpus.files, config: DEFAULT_CONFIG });
const d = (x: string): number => result.fileRecords.filter((f) => f.disposition === x).length;

test('crc32c matches the published check value for "123456789"', () => {
  assert.equal(crc32c('123456789'), 'e3069283');
});

test('every stored file carries a content digest and an integrity checksum', () => {
  for (const f of result.fileRecords) {
    assert.match(f.digest, /^[0-9a-f]{64}$/);
    assert.match(f.crc32c, /^[0-9a-f]{8}$/);
  }
});

test('duplicate file: the same bytes under the same name are ignored', () => {
  const again = result.fileRecords.find(
    (f) => f.declaredName === 'detail-2026-03-02.csv' && f.disposition === 'DUPLICATE_IGNORED',
  );
  assert.ok(again, 'the re-delivery should be recorded, not silently dropped');
  assert.match(again.note, /byte-identical/);
});

test('duplicate file: the same bytes under a NEW name are ignored too', () => {
  const resend = result.fileRecords.find((f) => f.declaredName === 'detail-2026-03-02-resend.csv');
  assert.ok(resend);
  assert.equal(resend.disposition, 'DUPLICATE_IGNORED');
});

test('both re-deliveries are recorded; neither is re-ingested', () => {
  assert.equal(d('DUPLICATE_IGNORED'), 2);
});

test('a name reused with different bytes is a conflict, not an overwrite', () => {
  assert.equal(d('CONTENT_CONFLICT'), 1);
  const conflict = result.fileRecords.find((f) => f.disposition === 'CONTENT_CONFLICT')!;
  assert.match(conflict.note, /different digest/);
});

test('the conflicting file is still stored as evidence of the conflict', () => {
  const conflict = result.fileRecords.find((f) => f.disposition === 'CONTENT_CONFLICT')!;
  assert.ok(conflict.byteLength > 0);
  assert.ok(conflict.digest.length === 64);
});

test('corrected file: a declared correction supersedes exactly one earlier file', () => {
  assert.equal(d('SUPERSEDED'), 1);
  const corrected = result.fileRecords.find((f) => f.declaredName === 'settlement-2026-03-04.v2.jsonl')!;
  const superseded = result.fileRecords.find((f) => f.disposition === 'SUPERSEDED')!;
  assert.equal(corrected.supersedes, superseded.fileId);
  assert.equal(superseded.supersededBy, corrected.fileId);
});

test('a superseded file contributes no records to the reconciliation', () => {
  const superseded = result.fileRecords.find((f) => f.disposition === 'SUPERSEDED')!;
  assert.equal(result.records.filter((r) => r.fileId === superseded.fileId).length, 0);
});

test('a superseded file is not deleted; its bytes remain readable', () => {
  const superseded = result.fileRecords.find((f) => f.disposition === 'SUPERSEDED')!;
  assert.ok((result.store.read(superseded.fileId) ?? '').length > 0);
});

test('the manifest is sorted and reproducible', () => {
  const a = result.store.manifest();
  const b = result.store.manifest();
  assert.deepEqual(a, b);
  const ids = a.map((m) => m.fileId);
  assert.deepEqual(ids, [...ids].sort());
});

test('file identity is the digest, not the declared name', () => {
  const store = new EvidenceStore();
  const common = {
    source: 's',
    format: 'acq-csv',
    formatVersion: '1',
    receivedAt: 0,
  };
  const a = store.admit({ ...common, declaredName: 'one.csv', bytes: 'x' });
  const b = store.admit({ ...common, declaredName: 'two.csv', bytes: 'x' });
  assert.equal(a.disposition, 'ACCEPTED');
  assert.equal(b.disposition, 'DUPLICATE_IGNORED');
  assert.equal(a.digest, b.digest);
});

test('a file arriving after the cutoff is not admitted at all', () => {
  const early = run({
    expectations: corpus.expectations,
    files: corpus.files,
    config: { ...DEFAULT_CONFIG, cutoff: Date.UTC(2026, 2, 7) },
  });
  assert.ok(
    early.fileRecords.every((f) => f.declaredName !== 'settlement-2026-03-05.jsonl'),
    'the late file must be absent, not present-and-ignored',
  );
});

test('a late file admitted at a wider cutoff produces records', () => {
  const late = result.fileRecords.find((f) => f.declaredName === 'settlement-2026-03-05.jsonl')!;
  assert.equal(late.disposition, 'ACCEPTED');
  assert.ok(result.records.some((r) => r.fileId === late.fileId));
});
