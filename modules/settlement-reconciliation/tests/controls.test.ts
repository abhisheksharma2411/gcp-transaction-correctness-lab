/**
 * Negative controls, and the guard on the controls themselves.
 *
 * A green suite proves nothing unless breaking the mechanism turns it red.
 * Each control here breaks exactly one thing and names what must fail. The
 * last one breaks everything and is recorded as evidence of nothing.
 *
 * The final test in this file is the one that matters most to the programme:
 * it asserts that the conservation oracle shares no code with the pipeline it
 * checks, by reading the import list rather than trusting a comment.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONTROLS, PROBES, evaluateControls } from '../src/controls.ts';

const outcomes = evaluateControls();

test('every probe holds with no mutation applied', () => {
  for (const p of PROBES) assert.equal(p.holds(), true, `${p.id} — ${p.what}`);
});

for (const c of CONTROLS.filter((x) => x.informative)) {
  test(`control ${c.id}: ${c.label}`, () => {
    const o = outcomes.find((x) => x.id === c.id)!;
    for (const id of c.mustBreak) {
      assert.ok(o.broke.includes(id), `${c.id} should have reddened ${id}, broke: ${o.broke.join(',')}`);
    }
    assert.ok(o.broke.length < PROBES.length, `${c.id} broke everything and so shows nothing`);
  });
}

test('harness guard: a mutation that reddens every probe is evidence of nothing', () => {
  const blunt = outcomes.find((x) => x.id === 'C8')!;
  assert.equal(blunt.informative, false);
  assert.ok(
    blunt.broke.length >= PROBES.length - 1,
    'the blunt control must redden essentially everything, or it is not blunt',
  );
  assert.deepEqual(blunt.expected, [], 'a blunt control must claim nothing');
});

test('harness guard: the probes are not all the same probe', () => {
  const broken = new Set(outcomes.filter((o) => o.informative).flatMap((o) => o.broke));
  assert.ok(broken.size >= 6, 'informative controls should reach most of the probe set');
  const untouched = PROBES.filter((p) => !broken.has(p.id)).map((p) => p.id);
  assert.deepEqual(untouched, [], `no control reaches ${untouched.join(', ')}`);
});

test('the digest check and the name check overlap, and the suite says so', () => {
  // Removing the digest test does not let a re-delivery through on its own:
  // the name-collision guard catches the same-name copy. Only the copy sent
  // under a NEW name depends on the digest. Both guards are recorded.
  const c1 = outcomes.find((x) => x.id === 'C1')!;
  assert.ok(c1.broke.includes('P1_DUPLICATE_FILE_IGNORED'));
  assert.ok(c1.broke.includes('P2_NAME_COLLISION_REFUSED'));
});

test('ORACLE ISOLATION: the conservation oracle imports nothing from the pipeline', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'oracle.ts'), 'utf8');
  const imports = [...src.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]!);
  assert.deepEqual(
    imports.sort(),
    ['./types.ts'],
    'oracle.ts must not import money, parsers, match, posting or intake',
  );
  assert.ok(/import type/.test(src), 'the one import must be type-only, so nothing executes');
});

test('ORACLE ISOLATION: the oracle converts decimals by a different method', () => {
  const oracle = readFileSync(join(import.meta.dirname, '..', 'src', 'oracle.ts'), 'utf8');
  const money = readFileSync(join(import.meta.dirname, '..', 'src', 'money.ts'), 'utf8');
  assert.ok(/parseFloat/.test(oracle), 'the oracle parses with parseFloat');
  assert.ok(!/parseFloat/.test(money), 'the pipeline parses with a regex');
  assert.ok(/\^\(-\?\)/.test(money) || /RegExp|\/\^/.test(money));
});

test('ORACLE ISOLATION: the matcher does not import the oracle', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'match.ts'), 'utf8');
  assert.ok(!/oracle/.test(src));
});
