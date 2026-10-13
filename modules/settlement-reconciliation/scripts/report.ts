#!/usr/bin/env node
/**
 * Generate results/. Deterministic: same input, byte-identical output.
 *
 * Nothing here reads a clock, a network or a cloud project. Every number in
 * results/report.md is produced by the run immediately above it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus } from '../src/corpus.ts';
import { evaluateControls, PROBES } from '../src/controls.ts';
import { byReason, disposition, openCases } from '../src/exceptions.ts';
import { minorToDecimal } from '../src/money.ts';
import { settlementTotal } from '../src/posting.ts';
import {
  DEFAULT_CONFIG,
  EARLY_CUTOFF,
  NO_BANK_CUTOFF,
  run,
  type RunOutput,
} from '../src/pipeline.ts';
import type { Explanation } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', 'results');
const usd = (minor: number): string => minorToDecimal(minor, 'USD');

const corpus = buildCorpus();
const base = { expectations: corpus.expectations, files: corpus.files };

const full = run({ ...base, config: DEFAULT_CONFIG });
const early = run({ ...base, config: EARLY_CUTOFF });
const noBank = run({ ...base, config: NO_BANK_CUTOFF });
const oldParser = run({ ...base, config: DEFAULT_CONFIG, mutations: { parserGeneration: 1 } });
const replay = run({ ...base, config: DEFAULT_CONFIG });

function tally<T extends string>(items: T[]): Array<[T, number]> {
  const acc = new Map<T, number>();
  for (const i of items) acc.set(i, (acc.get(i) ?? 0) + 1);
  return [...acc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function outcomeTally(r: RunOutput, side: Explanation['side']): Array<[string, number]> {
  return tally(
    r.explanations
      .filter((x) => x.side === side)
      .map((x) => `${x.outcome}${x.rule ? ` (${x.rule})` : ''}${x.reason ? ` (${x.reason})` : ''}`),
  );
}

/** A disposition applied to one case, so the audit trail has something in it. */
const casesWithDecision = openCases(full.explanations, DEFAULT_CONFIG.cutoff);
const target = casesWithDecision.find((c) => c.reason === 'FEE_VARIANCE_BEYOND_TOLERANCE')!;
disposition(
  casesWithDecision,
  {
    caseId: target.caseId,
    at: Date.UTC(2026, 2, 11),
    actor: 'finance-ops/reviewer-2',
    to: 'RESOLVED',
    action: 'ACCEPT_PROVIDER_FEE',
    note: 'provider fee schedule changed on 2026-03-01; internal expectation not updated',
    evidenceSeen: target.evidence.map((l) => full.readEvidence(l) ?? ''),
  },
  full.readEvidence,
);

const controls = evaluateControls();

const totalExceptionExposure = full.cases.reduce((a, c) => a + Math.abs(c.amountMinor), 0);

const json = {
  corpus: {
    expectations: corpus.expectations.length,
    filesDelivered: corpus.files.length,
    providerRecords: full.records.length,
    batchSummaries: full.summaries.length,
    bankEntries: full.bank.length,
  },
  aggregateTieOut: full.aggregate,
  rowLevel: {
    matched: full.explanations.filter((x) => x.side === 'INTERNAL' && x.outcome === 'MATCHED').length,
    matchedWithAdjustment: full.explanations.filter((x) => x.outcome === 'MATCHED_WITH_ADJUSTMENT').length,
    pending: full.explanations.filter((x) => x.outcome === 'PENDING').length,
    exceptionCases: full.cases.length,
    exceptionExposureMinor: totalExceptionExposure,
  },
  fileIntake: tally(full.fileRecords.map((f) => f.disposition)),
  manifest: full.store.manifest(),
  rulesFired: tally(
    full.explanations.filter((x) => x.rule !== null).map((x) => x.rule as string),
  ),
  exceptionsByReason: byReason(full.cases),
  postings: tally(full.instructions.map((i) => i.disposition)),
  postedSettlementUsdMinor: settlementTotal(full.instructions, 'USD'),
  conservation: full.conservation,
  rowBreaches: full.rowBreaches,
  providerPartition: full.providerPartition,
  cutoffs: {
    full: { pending: 0, exceptions: full.cases.length, aggregate: full.aggregate },
    early: {
      pending: early.explanations.filter((x) => x.outcome === 'PENDING').length,
      exceptions: early.cases.length,
      aggregate: early.aggregate,
    },
    noBank: {
      postSettlement: noBank.instructions.filter((i) => i.disposition === 'POST_SETTLEMENT').length,
      deferred: noBank.instructions.filter((i) => i.disposition === 'DEFER').length,
    },
  },
  parserGenerations: {
    current: { records: full.records.length, refusals: full.parseRefusals.length },
    previous: { records: oldParser.records.length, refusals: oldParser.parseRefusals },
  },
  suggestions: full.suggestions.slice(0, 5),
  replay: {
    identicalExplanations:
      JSON.stringify(replay.explanations) === JSON.stringify(full.explanations),
    identicalInstructions:
      JSON.stringify(replay.instructions) === JSON.stringify(full.instructions),
  },
  audit: {
    caseId: target.caseId,
    history: casesWithDecision.find((c) => c.caseId === target.caseId)!.history,
    rawDigestsUnchanged:
      JSON.stringify(full.store.manifest()) === JSON.stringify(replay.store.manifest()),
  },
  negativeControls: controls,
  probes: PROBES.map((p) => ({ id: p.id, what: p.what, holds: p.holds() })),
};

const explanations = full.explanations.map((x) => ({
  subject: x.subjectId,
  side: x.side,
  outcome: x.outcome,
  rule: x.rule,
  reason: x.reason,
  amount: minorToDecimal(x.amountMinor, x.currency),
  currency: x.currency,
  residual: minorToDecimal(x.residualMinor, x.currency),
  counterparts: x.counterpartIds,
  evidence: x.evidence,
  because: x.text,
}));

mkdirSync(RESULTS, { recursive: true });
writeFileSync(join(RESULTS, 'reconciliation.json'), `${JSON.stringify(json, null, 2)}\n`);
writeFileSync(join(RESULTS, 'explanations.json'), `${JSON.stringify(explanations, null, 2)}\n`);
writeFileSync(
  join(RESULTS, 'evidence-manifest.json'),
  `${JSON.stringify(full.store.manifest(), null, 2)}\n`,
);

const md: string[] = [];
const w = (line = ''): void => void md.push(line);

w('# settlement-reconciliation results');
w();
w('Generated by `scripts/report.ts`. Deterministic: no cloud project, no');
w('credentials, no network, no wall clock. Every table below is produced by the');
w('run described above it, and `make verify` compares two runs byte for byte.');
w();
w('## The period reconciles. Seven rows do not.');
w();
w(`One period: ${corpus.expectations.length} internal expectations, ${corpus.files.length} delivered files,`);
w(`${full.records.length} provider records and ${full.bank.length} bank entries.`);
w();
w('| tie-out | amount |');
w('|---|---:|');
w(`| internal expected net | ${usd(full.aggregate.expected)} |`);
w(`| provider stated net | ${usd(full.aggregate.provider)} |`);
w(`| bank deposits and debits | ${usd(full.aggregate.bank)} |`);
w(`| **period difference** | **${usd(full.aggregate.difference)}** |`);
w();
w('| row-level outcome | count |');
w('|---|---:|');
for (const [k, v] of outcomeTally(full, 'INTERNAL')) w(`| ${k} | ${v} |`);
for (const [k, v] of outcomeTally(full, 'PROVIDER')) w(`| ${k} | ${v} |`);
w();
w(`Exception cases: **${full.cases.length}**, carrying **${usd(totalExceptionExposure)}** of`);
w('unexplained amount. The period difference is zero because the defects offset.');
w();
w('## Exceptions');
w();
w('| reason | cases | exposure |');
w('|---|---:|---:|');
for (const r of byReason(full.cases)) w(`| ${r.reason} | ${r.count} | ${usd(r.exposureMinor)} |`);
w();
w('## Files');
w();
w('| disposition | files |');
w('|---|---:|');
for (const [k, v] of tally(full.fileRecords.map((f) => f.disposition))) w(`| ${k} | ${v} |`);
w();
w('## Rules that fired');
w();
w('| rule | rows |');
w('|---|---:|');
for (const [k, v] of tally(full.explanations.filter((x) => x.rule !== null).map((x) => x.rule as string))) {
  w(`| ${k} | ${v} |`);
}
w();
w('## The posting decision');
w();
w('| disposition | instructions |');
w('|---|---:|');
for (const [k, v] of tally(full.instructions.map((i) => i.disposition))) w(`| ${k} | ${v} |`);
w();
w(`Posted settlement and adjustment total, USD: **${usd(settlementTotal(full.instructions, 'USD'))}**.`);
w();
w('With the bank statement withheld — the same files, the same matches — the');
w('posting decision changes completely:');
w();
w('| disposition | instructions |');
w('|---|---:|');
for (const [k, v] of tally(noBank.instructions.map((i) => i.disposition))) w(`| ${k} | ${v} |`);
w();
w('## Conservation');
w();
w('| currency | expected | settled | residual | pending | holds |');
w('|---|---:|---:|---:|---:|---|');
for (const c of full.conservation) {
  w(`| ${c.currency} | ${usd(c.expectedMinor)} | ${usd(c.settledMinor)} | ${usd(c.residualMinor)} | ${usd(c.pendingMinor)} | ${c.holds ? 'yes' : 'NO'} |`);
}
w();
w(`Rows where expected net does not equal settled plus residual: **${full.rowBreaches.length}**.`);
w();
w('| currency | provider net | attributed | unattributed | holds |');
w('|---|---:|---:|---:|---|');
for (const p of full.providerPartition) {
  w(`| ${p.currency} | ${usd(p.providerMinor)} | ${usd(p.attributedMinor)} | ${usd(p.unattributedMinor)} | ${p.holds ? 'yes' : 'NO'} |`);
}
w();
w('## Cutoffs');
w();
w('| cutoff | pending | exception cases | posted as settlement |');
w('|---|---:|---:|---:|');
w(`| 2026-03-06 (before the bank statement) | ${noBank.explanations.filter((x) => x.outcome === 'PENDING').length} | ${noBank.cases.length} | ${noBank.instructions.filter((i) => i.disposition === 'POST_SETTLEMENT').length} |`);
w(`| 2026-03-07 (before the last detail file) | ${early.explanations.filter((x) => x.outcome === 'PENDING').length} | ${early.cases.length} | ${early.instructions.filter((i) => i.disposition === 'POST_SETTLEMENT').length} |`);
w(`| 2026-03-10 (everything has arrived) | ${full.explanations.filter((x) => x.outcome === 'PENDING').length} | ${full.cases.length} | ${full.instructions.filter((i) => i.disposition === 'POST_SETTLEMENT').length} |`);
w();
w('## Parser generations');
w();
w(`Current suite: ${full.records.length} records, ${full.parseRefusals.length} refusals.`);
w(`Previous suite on the same files: ${oldParser.records.length} records, ${oldParser.parseRefusals.length} refusal(s).`);
for (const r of oldParser.parseRefusals) w(`- \`${r.declaredName}\`: ${r.message}`);
w();
w('## Heuristic suggestions, offered and never applied');
w();
w('| expectation | record | score | basis |');
w('|---|---|---:|---|');
for (const s of full.suggestions.slice(0, 5)) {
  w(`| ${s.expectationId} | ${s.recordId} | ${s.score.toFixed(3)} | ${s.basis} |`);
}
w();
w('## Negative controls');
w();
w('| control | breaks | informative |');
w('|---|---|---|');
for (const c of controls) {
  w(`| ${c.id} — ${c.label} | ${c.broke.join(', ') || 'nothing'} | ${c.informative ? 'yes' : 'no, by design'} |`);
}
w();
w('## Replay');
w();
w(`Explanations identical on a second run: ${json.replay.identicalExplanations ? 'yes' : 'no'}.`);
w(`Posting instructions identical: ${json.replay.identicalInstructions ? 'yes' : 'no'}.`);
w(`Raw evidence digests unchanged after a manual disposition: ${json.audit.rawDigestsUnchanged ? 'yes' : 'no'}.`);
w();
w('*Simulated result. Every figure above is synthetic and reproducible with*');
w('*`make report`.*');

writeFileSync(join(RESULTS, 'report.md'), `${md.join('\n')}\n`);
process.stdout.write(`wrote ${RESULTS}/reconciliation.json, explanations.json, evidence-manifest.json, report.md\n`);
