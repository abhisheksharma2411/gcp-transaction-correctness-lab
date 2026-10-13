import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildCorpus } from '../src/corpus.ts';
import { DEFAULT_CONFIG, run } from '../src/pipeline.ts';
import type { RawFile } from '../src/types.ts';

const corpus = buildCorpus();
const base = { expectations: corpus.expectations, files: corpus.files };
const r = run({ ...base, config: DEFAULT_CONFIG });

test('the corpus is deterministic: two builds are identical', () => {
  const a = buildCorpus();
  const b = buildCorpus();
  assert.deepEqual(a.expectations, b.expectations);
  assert.deepEqual(a.files, b.files);
});

test('replay: the same evidence produces the same accepted result', () => {
  const again = run({ ...base, config: DEFAULT_CONFIG });
  assert.deepEqual(again.explanations, r.explanations);
  assert.deepEqual(again.instructions, r.instructions);
  assert.deepEqual(again.store.manifest(), r.store.manifest());
});

test('replay: re-running does not create a second posting', () => {
  const again = run({ ...base, config: DEFAULT_CONFIG });
  assert.equal(again.instructions.length, r.instructions.length);
  const ids = new Set(again.instructions.map((i) => i.instructionId));
  assert.equal(ids.size, again.instructions.length);
});

test('file arrival order does not change the accepted result', () => {
  // Everything but the duplicate, conflict and correction pair, which are
  // ordered by definition: a correction that arrives first is not a correction.
  const files = [...corpus.files];
  const movable = files.filter(
    (f) => f.corrects === undefined && f.declaredName !== 'detail-2026-03-02.csv' && f.declaredName !== 'detail-2026-03-02-resend.csv',
  );
  const fixed = files.filter((f) => !movable.includes(f));
  const reordered: RawFile[] = [...fixed, ...movable.reverse()].sort(
    (a, b) => a.receivedAt - b.receivedAt,
  );
  const again = run({ expectations: corpus.expectations, files: reordered, config: DEFAULT_CONFIG });
  assert.deepEqual(
    again.explanations.map((x) => [x.subjectId, x.outcome, x.reason, x.residualMinor]),
    r.explanations.map((x) => [x.subjectId, x.outcome, x.reason, x.residualMinor]),
  );
});

test('replay recomputes; it does not read a cached decision', () => {
  const trimmed = corpus.files.filter((f) => f.declaredName !== 'settlement-2026-03-05.jsonl');
  const without = run({ expectations: corpus.expectations, files: trimmed, config: DEFAULT_CONFIG });
  assert.notEqual(without.explanations.length, 0);
  assert.notDeepEqual(
    without.explanations.map((x) => x.outcome),
    r.explanations.map((x) => x.outcome),
  );
});

test('the explanation list is sorted, so two runs diff cleanly', () => {
  const ids = r.explanations.map((x) => x.subjectId);
  assert.deepEqual(ids, [...ids].sort());
});

test('nothing in src reads a clock', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(import.meta.dirname, '..', 'src');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue;
    const body = readFileSync(join(dir, name), 'utf8');
    for (const line of body.split('\n')) {
      const code = line.split('//')[0] ?? '';
      assert.ok(!/Date\.now\(\)/.test(code), `${name}: ${line.trim()}`);
      assert.ok(!/new Date\(\s*\)/.test(code), `${name}: ${line.trim()}`);
    }
  }
});
