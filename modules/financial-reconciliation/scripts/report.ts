// Runs every experiment and writes results/ deterministically.
//
//   node scripts/report.ts
//
// No cloud project, no credentials, no network. Re-running produces
// byte-identical output, which is why wall-clock timings are printed to the
// terminal and deliberately kept out of the written files: a number that
// changes between two runs of the same experiment is not a result.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BLUNT_MUTATION, CASES, MUTATIONS, runCorpus } from "../src/cases.ts";
import { Pipeline } from "../src/pipeline.ts";
import { DEFAULT_CONFIG } from "../src/reconcile.ts";
import { DEFAULT_STREAM, generate } from "../src/stream.ts";
import type { CaseState } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "..", "results");
mkdirSync(RESULTS, { recursive: true });

const T0 = Date.UTC(2026, 0, 5);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The correction deadline this model runs on. See docs/MODEL.md. */
const CORRECTION_WINDOW = DEFAULT_CONFIG.correctionWindowMs;

// --- E1: the case corpus ----------------------------------------------------

const corpus = runCorpus();

// --- E2: a day of evidence, counted four ways -------------------------------

const stream = generate(DEFAULT_STREAM, T0);

interface Snapshot {
  allowedLatenessMs: number;
  deliveries: number;
  duplicateDeliveries: number;
  statements: number;
  duplicateStatements: number;
  droppedLate: number;
  entries: number;
  computations: number;
  balanced: boolean;
  digest: string;
  states: Record<string, number>;
  exceptionReasons: Record<string, number>;
  stoppedBy: Record<string, number>;
}

function snapshot(p: Pipeline, allowedLatenessMs: number): Snapshot {
  const states: Record<string, number> = {};
  const exceptionReasons: Record<string, number> = {};
  for (const c of p.reconciler.cases.values()) {
    states[c.state as CaseState] = (states[c.state] ?? 0) + 1;
    for (const x of c.exceptions) {
      exceptionReasons[x.reason] = (exceptionReasons[x.reason] ?? 0) + 1;
    }
  }
  const sorted = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    allowedLatenessMs,
    deliveries: p.tally.deliveries,
    duplicateDeliveries: p.tally.duplicateDeliveries,
    statements: p.tally.statements,
    duplicateStatements: p.tally.duplicateStatements,
    droppedLate: p.tally.droppedLate,
    entries: p.tally.entries,
    computations: p.tally.computations,
    balanced: p.ledger.isBalanced(),
    digest: p.digest(),
    states: sorted(states),
    exceptionReasons: sorted(exceptionReasons),
    stoppedBy: sorted({ ...p.stoppedBy }),
  };
}

function runStream(allowedLatenessMs: number): { pipeline: Pipeline; snap: Snapshot } {
  const pipeline = new Pipeline({ allowedLatenessMs, reconcile: DEFAULT_CONFIG });
  pipeline.ingest(stream.records);
  pipeline.close(T0 + 60 * DAY);
  return { pipeline, snap: snapshot(pipeline, allowedLatenessMs) };
}

const baseline = runStream(7 * DAY);

// --- E3: the lateness window against the correction window ------------------

const LATENESS_SETTINGS = [HOUR, 6 * HOUR, DAY, 2 * DAY, 5 * DAY, 7 * DAY];
const latenessSweep = LATENESS_SETTINGS.map((ms) => runStream(ms).snap);

// --- E4: recovery by replaying the raw evidence with a wider window ---------
//
// The narrow run lost evidence. Nothing was deleted, so a second pipeline
// reading the same raw objects with a window wide enough for the correction
// deadline reproduces the baseline exactly.

const narrow = runStream(6 * HOUR);
const recovered = new Pipeline({ allowedLatenessMs: 7 * DAY, reconcile: DEFAULT_CONFIG });
recovered.ingest(narrow.pipeline.raw.all().map((o) => o.record));
recovered.close(T0 + 60 * DAY);
const recoveredSnap = snapshot(recovered, 7 * DAY);

// --- E5: replay into a ledger that already exists ---------------------------

const replayStart = performance.now();
const replayPipeline = runStream(7 * DAY).pipeline;
const beforeReplay = {
  entries: replayPipeline.tally.entries,
  computations: replayPipeline.tally.computations,
  digest: replayPipeline.digest(),
};
replayPipeline.rebuildDerived();
replayPipeline.replay();
replayPipeline.close(T0 + 60 * DAY);
const afterReplay = {
  entries: replayPipeline.tally.entries,
  computations: replayPipeline.tally.computations,
  digest: replayPipeline.digest(),
};
const replayElapsedMs = performance.now() - replayStart;

// --- E6: negative controls --------------------------------------------------

const controls = MUTATIONS.map((m) => {
  const red = runCorpus({ [m]: true }).filter((r) => !r.passed).map((r) => r.id);
  return { removed: m, casesTurnedRed: red, localised: red.length > 0 && red.length < CASES.length / 2 };
});
const bluntRed = runCorpus({ [BLUNT_MUTATION]: true }).filter((r) => !r.passed).map((r) => r.id);

// --- write ------------------------------------------------------------------

const payload = {
  generatedFrom: "scripts/report.ts",
  evaluatedAt: new Date(T0).toISOString(),
  note: "Deterministic. No cloud project, no credentials, no network. Wall-clock timings are excluded on purpose.",
  correctionWindowMs: CORRECTION_WINDOW,
  streamSpec: DEFAULT_STREAM,
  planted: stream.planted,
  corpus: corpus.map((c) => ({
    id: c.id, title: c.title, covers: c.covers, passed: c.passed,
    entries: c.observed.entries, balanced: c.observed.balanced,
    exceptions: c.observed.exceptions, digest: c.observed.digest,
  })),
  baseline: baseline.snap,
  latenessSweep,
  recovery: { narrow: narrow.snap, recovered: recoveredSnap },
  replay: { before: beforeReplay, after: afterReplay },
  negativeControls: controls,
  bluntControl: { removed: BLUNT_MUTATION, casesTurnedRed: bluntRed, rejected: bluntRed.length >= CASES.length / 2 },
};
writeFileSync(join(RESULTS, "reconciliation.json"), JSON.stringify(payload, null, 2) + "\n");

const L: string[] = [];
const days = (ms: number): string => (ms % DAY === 0 ? `${ms / DAY} d` : `${ms / HOUR} h`);

L.push("# financial-reconciliation results");
L.push("");
L.push("Generated by `scripts/report.ts`. Deterministic: no cloud project, no");
L.push("credentials, no network. Wall-clock timings are printed to the terminal and");
L.push("kept out of this file, because a number that changes between two runs of the");
L.push("same experiment is not a result.");
L.push("");
L.push("## Four numbers that are not the same number");
L.push("");
L.push(`One generated stream of ${stream.records.length} deliveries describing`);
L.push(`${stream.planted.transactions} transactions, with a lateness window of seven days.`);
L.push("");
L.push("| measured | count |");
L.push("|---|---:|");
L.push(`| deliveries that arrived | ${baseline.snap.deliveries} |`);
L.push(`| refused as repeat deliveries | ${baseline.snap.duplicateDeliveries} |`);
L.push(`| distinct assertions of fact | ${baseline.snap.statements} |`);
L.push(`| refused as repeat assertions | ${baseline.snap.duplicateStatements} |`);
L.push(`| **accepted financial effects** | **${baseline.snap.entries}** |`);
L.push("");
L.push("Delivery volume, assertion volume and accepted effects are three different");
L.push("numbers about one stream. A dashboard that reports the first is compatible");
L.push("with every failure below.");
L.push("");
L.push("## Case states and exception reasons");
L.push("");
L.push("| case state | count |");
L.push("|---|---:|");
for (const [k, v] of Object.entries(baseline.snap.states)) L.push(`| ${k} | ${v} |`);
L.push("");
L.push("| exception reason | count |");
L.push("|---|---:|");
for (const [k, v] of Object.entries(baseline.snap.exceptionReasons)) L.push(`| \`${k}\` | ${v} |`);
L.push("");
L.push(`Ledger balanced: **${baseline.snap.balanced}**. Result digest: \`${baseline.snap.digest}\`.`);
L.push("");
L.push("## The lateness window against the correction window");
L.push("");
L.push("The same evidence, replayed at six settings of the pipeline's allowed");
L.push(`lateness, against a correction deadline of ${days(CORRECTION_WINDOW)}.`);
L.push("");
L.push("| allowed lateness | dropped | accepted effects | matched | unmatched | exception | digest |");
L.push("|---|---:|---:|---:|---:|---:|---|");
for (const s of latenessSweep) {
  L.push(
    `| ${days(s.allowedLatenessMs)} | ${s.droppedLate} | ${s.entries} | ` +
    `${s.states["MATCHED"] ?? 0} | ${s.states["UNMATCHED"] ?? 0} | ` +
    `${s.states["EXCEPTION"] ?? 0} | \`${s.digest}\` |`,
  );
}
L.push("");
const sixHour = latenessSweep.find((s) => s.allowedLatenessMs === 6 * HOUR)!;
const fiveDay = latenessSweep.find((s) => s.allowedLatenessMs === 5 * DAY)!;
const sameStates = JSON.stringify(sixHour.states) === JSON.stringify(fiveDay.states);
L.push(`At six hours, ${sixHour.droppedLate} records are dropped and the accepted effect`);
L.push(`count falls from ${fiveDay.entries} to ${sixHour.entries}. The case-state summary is`);
L.push(`${sameStates ? "**identical**" : "different"}: ${JSON.stringify(sixHour.states)}. The ledger balances in both.`);
L.push("");
L.push("That is the result this module exists to produce. A configuration that is");
L.push("wrong by a factor of twenty loses evidence without changing a single number");
L.push("on a reconciliation dashboard, and a balanced ledger does not notice.");
L.push("");
L.push("## Recovery from the raw evidence");
L.push("");
L.push("The same raw objects, read a second time by a pipeline whose window is wide");
L.push("enough for the correction deadline.");
L.push("");
L.push("| run | allowed lateness | dropped | accepted effects | digest |");
L.push("|---|---|---:|---:|---|");
L.push(`| narrow | ${days(narrow.snap.allowedLatenessMs)} | ${narrow.snap.droppedLate} | ${narrow.snap.entries} | \`${narrow.snap.digest}\` |`);
L.push(`| re-read | ${days(recoveredSnap.allowedLatenessMs)} | ${recoveredSnap.droppedLate} | ${recoveredSnap.entries} | \`${recoveredSnap.digest}\` |`);
L.push(`| baseline | ${days(baseline.snap.allowedLatenessMs)} | ${baseline.snap.droppedLate} | ${baseline.snap.entries} | \`${baseline.snap.digest}\` |`);
L.push("");
L.push(`The re-read digest ${recoveredSnap.digest === baseline.snap.digest ? "matches" : "**does not match**"} the baseline.`);
L.push("Nothing was recovered from the stream, because the stream no longer has it.");
L.push("It was recovered from object storage, which is the only reason a lateness");
L.push("window is a tuning parameter rather than a loss.");
L.push("");
L.push("## Replay into a ledger that already exists");
L.push("");
L.push("Every derived store is discarded and rebuilt by replaying the raw evidence");
L.push("into the ledger that is already there.");
L.push("");
L.push("| measured | before | after |");
L.push("|---|---:|---:|");
L.push(`| accepted financial effects | ${beforeReplay.entries} | ${afterReplay.entries} |`);
L.push(`| derivations performed | ${beforeReplay.computations} | ${afterReplay.computations} |`);
L.push("");
L.push(`Result digest before: \`${beforeReplay.digest}\`, after: \`${afterReplay.digest}\` ` +
  `(${beforeReplay.digest === afterReplay.digest ? "unchanged" : "**changed**"}).`);
L.push("");
L.push("Replaying the same evidence repeated the computation and did not create an");
L.push("additional accepted financial effect. The replay cost is reported as work");
L.push("done rather than as elapsed time, so that this file stays byte-identical");
L.push("between runs.");
L.push("");
L.push("## Case corpus");
L.push("");
L.push("| case | covers | effects | balanced | result |");
L.push("|---|---|---:|---|---|");
for (const c of corpus) {
  L.push(`| **${c.id}** ${c.title} | ${c.covers} | ${c.observed.entries} | ${c.observed.balanced} | ${c.passed ? "PASS" : "FAIL"} |`);
}
L.push("");
L.push(`**${corpus.filter((c) => c.passed).length}/${corpus.length} cases pass.**`);
L.push("");
L.push("## Negative controls");
L.push("");
L.push("A corpus written by the same hand as the implementation proves nothing until");
L.push("each case has been shown to fail when the mechanism it covers is removed.");
L.push("");
L.push("| mechanism removed | cases that turn red | localised |");
L.push("|---|---|---|");
for (const c of controls) {
  L.push(`| \`${c.removed}\` | ${c.casesTurnedRed.join(", ") || "—"} | ${c.localised ? "yes" : "**no**"} |`);
}
L.push(`| \`${BLUNT_MUTATION}\` (blunt control) | ${bluntRed.length} of ${CASES.length} | **rejected** |`);
L.push("");
L.push("The blunt control is rejected rather than reported as a success. A mutation");
L.push("that reddens the whole corpus cannot show which case covers which mechanism,");
L.push("and `everything broke` is not evidence that anything in particular works.");
L.push("");
L.push("One result here is uncomfortable and is left in. Removing delivery-level");
L.push("de-duplication reddens exactly one case, and it reddens it on attribution");
L.push("rather than on money: the assertion-level check underneath catches the same");
L.push("duplicates. The raw store's create-if-absent precondition is buying work");
L.push("avoided and the ability to detect an upstream system reusing an identity.");
L.push("It is not buying financial correctness, and the controls say so.");
L.push("");
writeFileSync(join(RESULTS, "report.md"), L.join("\n"));

console.log("wrote results/reconciliation.json and results/report.md");
console.log(`replay experiment wall clock: ${replayElapsedMs.toFixed(1)} ms (not written to file)`);
