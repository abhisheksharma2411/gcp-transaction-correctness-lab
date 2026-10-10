// The mutation harness.
//
//   node scripts/mutate.ts          run every mutation
//   node scripts/mutate.ts --check  the same, with a non-zero exit on failure
//
// Each mutation copies `src/` and `tests/` into a scratch directory, edits one
// line of the copied source, and runs the tests the mutation claims to break.
// The mutation passes only when exactly the named tests fail and the rest of
// the suite still passes.
//
// This is deliberately not a simulation. A control that models what a
// mutation would do is a second implementation written by the same author on
// the same afternoon, and it agrees with the first for the same reasons. The
// only control worth having edits the code that actually runs.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..');

export interface Mutation {
  id: string;
  /** What is broken, in one line. */
  mutation: string;
  file: string;
  find: string;
  replace: string;
  /** Tests that must fail once the mutation is applied. */
  redTests: string[];
}

export const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    mutation: 'treat a due_by of 0 as a timestamp instead of a sentinel',
    file: 'src/deadline.ts',
    find: "  if (dueBySeconds === 0) return 'NO_RESPONSE_PERMITTED';",
    replace: "  if (dueBySeconds === 0) return 'PROVIDER_SUPPLIED';",
    redTests: [
      'deadline: a due_by of zero is not a date',
      'deadline: zero opens the case as unanswerable',
      'case: a case the provider permits no answer to opens terminal',
    ],
  },
  {
    id: 'M2',
    mutation: 'resolve an ambiguous civil time to the latest candidate',
    file: 'src/zones.ts',
    find: '      instant: candidates[0]!,\n      ambiguity: \'OVERLAP\',',
    replace: '      instant: candidates[candidates.length - 1]!,\n      ambiguity: \'OVERLAP\',',
    redTests: ['zones: an overlapping civil time resolves to the earlier instant'],
  },
  {
    id: 'M3',
    mutation: 'hash the manifest over item identifiers only, ignoring content',
    file: 'src/manifest.ts',
    find: '    parts.push(entry.itemId, entry.contentHash);',
    replace: '    parts.push(entry.itemId);',
    redTests: [
      'manifest: replacing a document produces a new packet version',
      'manifest: a packet whose entry digest was altered fails reproduction',
      'case: evidence changed after approval sends the case back for approval',
    ],
  },
  {
    id: 'M4',
    mutation: 'count the start date as the first business day of the window',
    file: 'src/calendar.ts',
    find: '  let remaining = count;',
    replace: '  let remaining = count > 0 ? count - 1 : 0;',
    // The first two are the ones this mutation was written for. The last two
    // were a surprise: the daylight-saving fixtures pick their dates by
    // walking the same window, so an off-by-one in the walk moves them too.
    // The declared set was corrected rather than the mutation narrowed,
    // because the coupling is real and worth knowing about.
    redTests: [
      'calendar: a five-day window skips the weekend and two holidays',
      'calendar: the start date is never counted as a business day of the window',
      'deadline: the same local cutoff moves by an hour across a daylight transition',
      'deadline: a thirty-minute daylight shift is not rounded to an hour',
    ],
  },
  {
    id: 'M5',
    mutation: 'key the duplicate check on the delivery identifier, not the case identifier',
    file: 'src/case.ts',
    find: '  const match = existing.find((c) => c.providerCaseId === notification.providerCaseId);',
    replace: '  const match = existing.find((c) => c.seenDeliveries.includes(notification.deliveryId));',
    redTests: [
      'case: a second delivery for a known case does not open a second case',
      'case: a duplicate notification does not duplicate the provisional debit',
      'case: a duplicate notification outside any platform deduplication window is still one case',
    ],
  },
  {
    id: 'M6',
    mutation: 'schedule a single task directly at a target beyond the platform horizon',
    file: 'src/timers.ts',
    find: '  const hops = Math.ceil(distance / MAX_SCHEDULE_HORIZON_MS) - 1;',
    replace: '  const hops = 0;',
    redTests: ['timers: a target beyond thirty days needs renewal hops'],
  },
  {
    id: 'M7',
    mutation: 'let a manual override reopen a terminal case',
    file: 'src/case.ts',
    find: "  if (isTerminal(kase.state)) {\n    log(kase, command.at, command.actor, 'HUMAN', 'override_refused', `case is terminal in ${kase.state}`);\n    return { ok: false, note: 'a terminal case cannot be reopened by override' };\n  }",
    replace: '  // mutation: the terminal guard has been removed',
    redTests: ['case: an override cannot reopen a terminal case'],
  },
  {
    id: 'M8',
    mutation: 'allow an approval with no recorded reason',
    file: 'src/manifest.ts',
    find: "  if (request.approvalReason.trim() === '') {\n    return { ok: false, error: 'approval requires a reason' };\n  }",
    replace: '  // mutation: the reason requirement has been removed',
    redTests: ['manifest: approval requires an actor and a reason'],
  },
  {
    id: 'M9',
    mutation: 'raise a role\u2019s classification ceiling to cardholder',
    file: 'src/access.ts',
    find: "  SUPPORT_AGENT: 'INTERNAL',",
    replace: "  SUPPORT_AGENT: 'CARDHOLDER',",
    redTests: [
      'access: no role is permitted cardholder-classified evidence',
      'access: cardholder-classified evidence is refused to every role',
      'access: a role below the classification ceiling is refused',
    ],
  },
  {
    id: 'M10',
    mutation: 'release an event-based hold without restarting the retention clock',
    file: 'src/retention.ts',
    find: '      object: { ...object, holds, clockStartedAt: at },',
    replace: '      object: { ...object, holds },',
    redTests: ['retention: releasing an event-based hold restarts the retention clock'],
  },
  {
    id: 'M11',
    mutation: 'return the current state rather than the state at the instant asked for',
    file: 'src/case.ts',
    find: '    if (entry.at > instant) break;',
    replace: '    if (false) break;',
    redTests: [
      'case: state is recoverable from the audit trail at any past instant',
      'case: the due row at a past instant reflects that instant, not the present',
    ],
  },
  {
    id: 'M12',
    mutation: 'none -- the harness control',
    file: 'src/deadline.ts',
    find: 'export const RULE_SETS: RuleSet[] = [',
    replace: 'export const RULE_SETS: RuleSet[] = [ // harness control: a comment, nothing more',
    redTests: [],
  },
];

export interface MutationOutcome {
  id: string;
  mutation: string;
  /** Tests the mutation was expected to break. */
  expectedRed: string[];
  /** Tests that actually failed. */
  observedRed: string[];
  /** True when the observed failures are exactly the expected ones. */
  ok: boolean;
  note: string;
}

const TEST_FILES = [
  'tests/zones.test.ts',
  'tests/deadline.test.ts',
  'tests/manifest.test.ts',
  'tests/case.test.ts',
  'tests/timers.test.ts',
  'tests/governance.test.ts',
];

function failingTests(dir: string): string[] {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...TEST_FILES],
    { cwd: dir, encoding: 'utf8', timeout: 180_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const failures: string[] = [];
  for (const line of output.split('\n')) {
    const match = /^not ok \d+ - (.+)$/.exec(line.trim());
    if (match) failures.push(match[1]!.trim());
  }
  return failures.sort();
}

export function runMutations(): MutationOutcome[] {
  const outcomes: MutationOutcome[] = [];
  for (const mutation of MUTATIONS) {
    const dir = mkdtempSync(join(tmpdir(), 'ddw-mutate-'));
    try {
      cpSync(join(MODULE, 'src'), join(dir, 'src'), { recursive: true });
      cpSync(join(MODULE, 'tests'), join(dir, 'tests'), { recursive: true });
      const target = join(dir, mutation.file);
      const original = readFileSync(target, 'utf8');
      if (!original.includes(mutation.find)) {
        outcomes.push({
          id: mutation.id,
          mutation: mutation.mutation,
          expectedRed: mutation.redTests,
          observedRed: [],
          ok: false,
          note: `the text this mutation edits is no longer in ${mutation.file}`,
        });
        continue;
      }
      writeFileSync(target, original.replace(mutation.find, mutation.replace));
      const observed = failingTests(dir);
      const expected = [...mutation.redTests].sort();
      const missing = expected.filter((t) => !observed.includes(t));
      const extra = observed.filter((t) => !expected.includes(t));
      const notes: string[] = [];
      if (missing.length > 0) notes.push(`stayed green: ${missing.join('; ')}`);
      if (extra.length > 0) notes.push(`also red: ${extra.join('; ')}`);
      outcomes.push({
        id: mutation.id,
        mutation: mutation.mutation,
        expectedRed: expected,
        observedRed: observed,
        ok: missing.length === 0 && extra.length === 0,
        note: notes.join(' | ') || (expected.length === 0 ? 'no test broke, as intended' : 'exactly the named tests failed'),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return outcomes;
}

if (process.argv[1] && process.argv[1].endsWith('mutate.ts')) {
  const outcomes = runMutations();
  let failed = 0;
  const lines: string[] = [
    '# Mutation results',
    '',
    'Generated by `scripts/mutate.ts`. Each row copies the module, edits one',
    'line of the copied source, and runs the suite. A mutation passes only when',
    'exactly the tests it named go red and nothing else does.',
    '',
    '| id | mutation | tests that must go red | observed | result |',
    '|---|---|---|---:|---|',
  ];
  for (const outcome of outcomes) {
    const status = outcome.ok ? 'PASS' : 'FAIL';
    if (!outcome.ok) failed += 1;
    console.log(`${status}  ${outcome.id}  ${outcome.mutation}`);
    console.log(`        ${outcome.note}`);
    const named = outcome.expectedRed.length === 0 ? '(none, by design)' : outcome.expectedRed.join('; ');
    lines.push(
      `| **${outcome.id}** | ${outcome.mutation} | ${named} | ${outcome.observedRed.length} | ${status} |`,
    );
  }
  lines.push('');
  lines.push(`${outcomes.length - failed} of ${outcomes.length} mutations behaved as declared.`);
  lines.push('');
  lines.push('`M12` is the harness control. It edits a comment, so nothing should');
  lines.push('break; a harness that reported every mutation as caught would report');
  lines.push('this one too.');
  lines.push('');
  writeFileSync(join(MODULE, 'results', 'mutations.md'), lines.join('\n'));
  console.log('');
  console.log(`${outcomes.length - failed}/${outcomes.length} mutations behaved as declared`);
  console.log('wrote results/mutations.md');
  if (process.argv.includes('--check') && failed > 0) process.exit(1);
}
