#!/usr/bin/env node
/**
 * Explain one row.
 *
 *   node scripts/explain.ts --subject exp-9201
 *   node scripts/explain.ts --reason PARTIAL_SETTLEMENT
 *   node scripts/explain.ts --exceptions
 *
 * The playbook's stated contribution is a report that says exactly why every
 * row matched, remained pending or became an exception. This is that report
 * with one row in front of you, raw evidence included.
 */

import { buildCorpus } from '../src/corpus.ts';
import { minorToDecimal } from '../src/money.ts';
import { DEFAULT_CONFIG, run } from '../src/pipeline.ts';
import type { Explanation } from '../src/types.ts';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--help') || args.length === 0) {
  process.stdout.write(
    'usage: explain.ts [--subject <id>] [--reason <REASON>] [--exceptions]\n',
  );
  process.exit(0);
}

const corpus = buildCorpus();
const r = run({ expectations: corpus.expectations, files: corpus.files, config: DEFAULT_CONFIG });

let rows: Explanation[] = r.explanations;
const subject = arg('--subject');
const reason = arg('--reason');
if (subject !== undefined) rows = rows.filter((x) => x.subjectId === subject);
if (reason !== undefined) rows = rows.filter((x) => x.reason === reason);
if (args.includes('--exceptions')) rows = rows.filter((x) => x.outcome === 'EXCEPTION');

if (rows.length === 0) {
  process.stderr.write('no matching row\n');
  process.exit(1);
}

for (const x of rows) {
  process.stdout.write(`\n${x.subjectId}  [${x.side}]  ${x.outcome}\n`);
  process.stdout.write(`  rule      ${x.rule ?? '(none)'}\n`);
  process.stdout.write(`  reason    ${x.reason ?? '(none)'}\n`);
  process.stdout.write(`  amount    ${minorToDecimal(x.amountMinor, x.currency)} ${x.currency}\n`);
  process.stdout.write(`  residual  ${minorToDecimal(x.residualMinor, x.currency)} ${x.currency}\n`);
  process.stdout.write(`  because   ${x.text}\n`);
  for (const locator of x.evidence) {
    const line = r.readEvidence(locator);
    process.stdout.write(`  evidence  ${locator}\n`);
    if (line !== undefined) process.stdout.write(`            ${line.slice(0, 160)}\n`);
  }
  const instruction = r.instructions.find((i) => i.subjectId === x.subjectId);
  if (instruction) {
    process.stdout.write(`  posting   ${instruction.disposition} — ${instruction.basis}\n`);
  }
}
process.stdout.write('\n');
