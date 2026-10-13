#!/usr/bin/env node
/**
 * Print the negative-control matrix and fail if a control stops being
 * informative. `make verify` runs this after the tests, because a suite whose
 * controls have gone quiet is a suite that has stopped measuring.
 */

import { PROBES, evaluateControls } from '../src/controls.ts';

const outcomes = evaluateControls();
let bad = 0;

process.stdout.write('probes\n');
for (const p of PROBES) {
  const holds = p.holds();
  if (!holds) bad += 1;
  process.stdout.write(`  ${holds ? 'holds ' : 'FAILS '} ${p.id}  ${p.what}\n`);
}

process.stdout.write('\ncontrols\n');
for (const o of outcomes) {
  if (!o.ok) bad += 1;
  const note = o.informative ? o.expected.join(', ') : 'claims nothing, by design';
  process.stdout.write(`  ${o.ok ? 'ok  ' : 'BAD '} ${o.id}  ${o.label}\n`);
  process.stdout.write(`        reddens: ${o.broke.join(', ') || 'nothing'}\n`);
  process.stdout.write(`        required: ${note}\n`);
}

if (bad > 0) {
  process.stderr.write(`\ncontrols: ${bad} problem(s)\n`);
  process.exit(1);
}
process.stdout.write('\ncontrols: PASS\n');
