import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { MUTATIONS } from '../scripts/mutate.ts';
import { reproduceAll, runPopulation } from '../src/run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..');

// The mutations themselves are executed by `make mutate`, which copies the
// module and runs the suite once per mutation. These tests check the things
// that can be checked without that cost: that every mutation still points at
// code that exists, and that every test it names exists too. A mutation list
// that has drifted away from the source is worse than none, because it
// reports PASS for an edit that no longer edits anything.

test('controls: every mutation still matches text in the file it edits', () => {
  for (const mutation of MUTATIONS) {
    const source = readFileSync(join(MODULE, mutation.file), 'utf8');
    assert.ok(
      source.includes(mutation.find),
      `${mutation.id} no longer matches anything in ${mutation.file}`,
    );
  }
});

test('controls: every mutation changes the file it claims to change', () => {
  for (const mutation of MUTATIONS) {
    assert.notEqual(mutation.find, mutation.replace, `${mutation.id} is a no-op edit`);
  }
});

test('controls: every test a mutation names exists in this suite', () => {
  const files = readdirSync(join(MODULE, 'tests')).filter((f) => f.endsWith('.test.ts'));
  const corpus = files.map((f) => readFileSync(join(MODULE, 'tests', f), 'utf8')).join('\n');
  for (const mutation of MUTATIONS) {
    for (const name of mutation.redTests) {
      assert.ok(corpus.includes(`'${name}'`), `${mutation.id} names a test that does not exist: ${name}`);
    }
  }
});

test('controls: exactly one mutation is the harness control', () => {
  const harness = MUTATIONS.filter((m) => m.redTests.length === 0);
  assert.equal(harness.length, 1);
  assert.equal(harness[0]!.id, 'M12');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('determinism: nothing in src/ reads the clock or a random source', () => {
  const files = readdirSync(join(MODULE, 'src')).filter((f) => f.endsWith('.ts'));
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(MODULE, 'src', file), 'utf8');
    const body = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    if (/Date\.now\s*\(/.test(body)) offenders.push(`${file}: Date.now()`);
    if (/Math\.random\s*\(/.test(body)) offenders.push(`${file}: Math.random()`);
    if (/new Date\(\s*\)/.test(body)) offenders.push(`${file}: new Date()`);
    if (/process\.env/.test(body)) offenders.push(`${file}: process.env`);
  }
  assert.deepEqual(offenders, []);
});

test('determinism: nothing in src/ consults the host time-zone database', () => {
  const files = readdirSync(join(MODULE, 'src')).filter((f) => f.endsWith('.ts'));
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(MODULE, 'src', file), 'utf8');
    if (/Intl\.DateTimeFormat/.test(text)) offenders.push(`${file}: Intl.DateTimeFormat`);
    if (/\.getFullYear\(|\.getMonth\(|\.getDate\(|\.getHours\(|\.getMinutes\(/.test(text)) {
      offenders.push(`${file}: local Date accessor`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('determinism: the population run produces identical results twice', () => {
  const first = runPopulation();
  const second = runPopulation();
  assert.deepEqual(second.tally, first.tally);
  assert.deepEqual(second.sweepAt, first.sweepAt);
  assert.deepEqual(
    second.cases.map((c) => c.packets.map((p) => p.manifestHash)),
    first.cases.map((c) => c.packets.map((p) => p.manifestHash)),
  );
});

test('determinism: every packet in the run reproduces its own manifest hash', () => {
  const result = reproduceAll(runPopulation());
  assert.equal(result.matched, result.total);
  assert.ok(result.total > 0);
});

test('determinism: make report is byte-identical on re-run', () => {
  const reportPath = join(MODULE, 'results', 'report.md');
  const jsonPath = join(MODULE, 'results', 'deadlines.json');
  execFileSync(process.execPath, [join(MODULE, 'scripts', 'report.ts')], { cwd: MODULE, stdio: 'ignore' });
  const firstReport = readFileSync(reportPath);
  const firstJson = readFileSync(jsonPath);
  execFileSync(process.execPath, [join(MODULE, 'scripts', 'report.ts')], { cwd: MODULE, stdio: 'ignore' });
  assert.ok(firstReport.equals(readFileSync(reportPath)), 'report.md differs between runs');
  assert.ok(firstJson.equals(readFileSync(jsonPath)), 'deadlines.json differs between runs');
});
