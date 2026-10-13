/**
 * Negative controls.
 *
 * A suite that stays green when you remove the thing it tests is measuring
 * nothing. Each control below deliberately breaks one mechanism and names the
 * property that must go red. `tests/controls.test.ts` asserts both halves:
 * the property holds with no mutation, and fails with it.
 *
 * The last entry is a control on the controls. It breaks everything at once,
 * and is recorded as evidence of nothing for exactly that reason.
 */

import { buildCorpus } from './corpus.ts';
import { settlementTotal } from './posting.ts';
import { DEFAULT_CONFIG, NO_BANK_CUTOFF, run, type AllMutations } from './pipeline.ts';
import type { RunOutput } from './pipeline.ts';

export interface Probe {
  id: string;
  what: string;
  holds: (mutations?: AllMutations) => boolean;
}

function withConfig(config = DEFAULT_CONFIG, mutations?: AllMutations): RunOutput {
  const c = buildCorpus();
  return run({ expectations: c.expectations, files: c.files, config, mutations });
}

function count(r: RunOutput, disposition: string): number {
  return r.fileRecords.filter((f) => f.disposition === disposition).length;
}

export const PROBES: Probe[] = [
  {
    id: 'P1_DUPLICATE_FILE_IGNORED',
    what: 'a byte-identical re-delivery is recorded and not re-ingested',
    holds: (m) => count(withConfig(DEFAULT_CONFIG, m), 'DUPLICATE_IGNORED') === 2,
  },
  {
    id: 'P2_NAME_COLLISION_REFUSED',
    what: 'a file reusing a name with different bytes is a conflict, not an overwrite',
    holds: (m) => count(withConfig(DEFAULT_CONFIG, m), 'CONTENT_CONFLICT') === 1,
  },
  {
    id: 'P3_CORRECTION_SUPERSEDES',
    what: 'a declared correction retires exactly one earlier file',
    holds: (m) => count(withConfig(DEFAULT_CONFIG, m), 'SUPERSEDED') === 1,
  },
  {
    id: 'P4_CURRENCY_IS_PART_OF_IDENTITY',
    what: 'an amount reported in another currency is an exception, not a match',
    holds: (m) =>
      withConfig(DEFAULT_CONFIG, m).explanations.filter((x) => x.reason === 'CURRENCY_MISMATCH')
        .length === 1,
  },
  {
    id: 'P5_CONSERVATION',
    what: 'every internal row: expected net equals settled net plus residual',
    holds: (m) => withConfig(DEFAULT_CONFIG, m).rowBreaches.length === 0,
  },
  {
    id: 'P6_NO_POSTING_WITHOUT_CONFIRMATION',
    what: 'with no bank statement, nothing posts as settlement',
    holds: (m) =>
      withConfig(NO_BANK_CUTOFF, m).instructions.filter((i) => i.disposition === 'POST_SETTLEMENT')
        .length === 0,
  },
  {
    id: 'P7_POSTINGS_FOLLOW_THE_MATCH',
    what: 'the posted total equals the expected net of the rows a rule matched',
    holds: (m) => {
      const r = withConfig(DEFAULT_CONFIG, m);
      const posted = settlementTotal(r.instructions, 'USD');
      let fromMatch = 0;
      for (const x of r.explanations) {
        if (x.side !== 'INTERNAL' || x.currency !== 'USD') continue;
        if (x.outcome !== 'MATCHED' && x.outcome !== 'MATCHED_WITH_ADJUSTMENT') continue;
        fromMatch += x.amountMinor;
      }
      return posted === fromMatch;
    },
  },
  {
    id: 'P9_EXCEPTION_COUNT',
    what: 'the corpus raises exactly seven exception cases',
    holds: (m) => withConfig(DEFAULT_CONFIG, m).cases.length === 7,
  },
  {
    id: 'P8_PROVIDER_SIDE_PARTITIONED',
    what: 'every minor unit in a live provider file is attributed or named unattributed',
    holds: (m) => withConfig(DEFAULT_CONFIG, m).providerPartition.every((p) => p.holds),
  },
];

export interface Control {
  id: string;
  label: string;
  mutations: AllMutations;
  /** Probe ids that must go red. */
  mustBreak: string[];
  informative: boolean;
}

export const CONTROLS: Control[] = [
  {
    id: 'C1',
    label: 'ingest a re-delivered file again instead of recognising its digest',
    mutations: { intake: { ignoreDuplicateDigest: true } },
    mustBreak: ['P1_DUPLICATE_FILE_IGNORED', 'P9_EXCEPTION_COUNT'],
    informative: true,
  },
  {
    id: 'C2',
    label: 'let a file overwrite an earlier one that shares its name',
    mutations: { intake: { overwriteOnNameCollision: true } },
    mustBreak: ['P2_NAME_COLLISION_REFUSED'],
    informative: true,
  },
  {
    id: 'C3',
    label: 'ignore a declared correction and keep both versions live',
    mutations: { intake: { ignoreSupersession: true } },
    mustBreak: ['P3_CORRECTION_SUPERSEDES'],
    informative: true,
  },
  {
    id: 'C4',
    label: 'compare amounts without comparing currency',
    mutations: { match: { ignoreCurrency: true } },
    mustBreak: ['P4_CURRENCY_IS_PART_OF_IDENTITY'],
    informative: true,
  },
  {
    id: 'C5',
    label: 'absorb a within-tolerance difference instead of recording it',
    mutations: { match: { absorbResidual: true } },
    mustBreak: ['P5_CONSERVATION'],
    informative: true,
  },
  {
    id: 'C6',
    label: 'post a settlement on a match alone, with no bank confirmation',
    mutations: { posting: { postWithoutBankConfirmation: true } },
    mustBreak: ['P6_NO_POSTING_WITHOUT_CONFIRMATION'],
    informative: true,
  },
  {
    id: 'C7',
    label: 'post straight from the parsed file, skipping the posting decision',
    mutations: { posting: { postFromFile: true } },
    mustBreak: ['P7_POSTINGS_FOLLOW_THE_MATCH'],
    informative: true,
  },
  {
    id: 'C8',
    label: 'all seven at once — reddens everything and therefore shows nothing',
    mutations: {
      intake: { ignoreDuplicateDigest: true, ignoreSupersession: true, overwriteOnNameCollision: true },
      match: { ignoreCurrency: true, absorbResidual: true },
      posting: { postFromFile: true },
    },
    mustBreak: [],
    informative: false,
  },
];

export interface ControlOutcome {
  id: string;
  label: string;
  broke: string[];
  expected: string[];
  informative: boolean;
  ok: boolean;
}

export function evaluateControls(): ControlOutcome[] {
  const out: ControlOutcome[] = [];
  for (const c of CONTROLS) {
    const broke = PROBES.filter((p) => !p.holds(c.mutations)).map((p) => p.id);
    const ok = c.informative
      ? c.mustBreak.every((id) => broke.includes(id)) && broke.length < PROBES.length
      : broke.length >= PROBES.length - 1;
    out.push({ id: c.id, label: c.label, broke, expected: c.mustBreak, informative: c.informative, ok });
  }
  return out;
}
