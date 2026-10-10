// Runs every scenario and writes results/ deterministically.
//
//   node scripts/report.ts
//
// No cloud project, no credentials, no network. Re-running produces
// byte-identical output: nothing here reads a clock.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS, universalInvariants, T0, MINUTE, HOUR, DAY } from "../src/scenarios.ts";
import { SPEC_V2, CALLBACK_DEADLINE_MS } from "../src/spec.ts";
import { verify, mutateSpec, SPEC_MUTATIONS } from "../src/verify.ts";
import { MUTATIONS } from "../src/policy.ts";
import type { Mutation } from "../src/policy.ts";
import { Runtime, SERVICE, worker } from "../src/runtime.ts";
import type { CrashPoint } from "../src/runtime.ts";
import { CRASH_POINTS } from "../src/runtime.ts";
import { DatabaseBackedDriver, EngineBackedDriver, runLifecycle } from "../src/drivers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "..", "results");
mkdirSync(RESULTS, { recursive: true });

// --- E1: scenarios and transition coverage ----------------------------------

const traces = SCENARIOS.map((s) => ({ id: s.id, title: s.title, covers: s.covers, trace: s.run() }));

const permitted = SPEC_V2.transitions.map((t) => `${t.from}--${t.trigger}-->${t.to}`);
const uniquePermitted = [...new Set(permitted)].sort();
const exercised = new Set<string>();
for (const t of traces) for (const x of t.trace.transitions) exercised.add(x);
const uncovered = uniquePermitted.filter((p) => !exercised.has(p));

const refusalTally: Record<string, number> = {};
for (const t of traces) {
  for (const r of t.trace.refusals) refusalTally[r] = (refusalTally[r] ?? 0) + 1;
}

const invariantFailures: string[] = [];
for (const t of traces) {
  for (const inv of universalInvariants(t.trace)) {
    if (!inv.ok) invariantFailures.push(`${t.id}: ${inv.name}`);
  }
}

// --- E2: the crash matrix ---------------------------------------------------

/**
 * Crash at each point of the one transition that moves money, then let
 * recovery and the deadline do their work, and ask what the record says.
 *
 * The number that matters is the last column. Everything else is bookkeeping.
 */
function crashRow(point: CrashPoint): {
  point: CrashPoint; stateAfterCrash: string; recovered: string;
  finalState: string; submissions: number; timersPending: number;
} {
  const rt = new Runtime();
  const id = `crash-${point}`;
  rt.create({
    id, amountMinor: 25_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: `create-${id}`,
  });
  rt.step(id, "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  rt.step(id, "submit", SERVICE, T0 + 2 * MINUTE, { correlationId: "submit-1", crashAt: point });
  const stateAfterCrash = rt.stateOf(id);

  // A second worker inherits the entity once the lease lapses.
  const recovered = rt.recover(id, "payout-worker-2", T0 + 10 * MINUTE);

  // The redelivery of the unacknowledged task.
  rt.step(id, "submit", worker("payout-worker-2"), T0 + 11 * MINUTE, { correlationId: "submit-1" });

  // Then the deadline, then the lookup.
  rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + HOUR);
  if (rt.stateOf(id) === "RECONCILING") {
    rt.resolve(id, T0 + CALLBACK_DEADLINE_MS + HOUR + MINUTE, "resolve-1");
  }
  // Otherwise the provider simply answers.
  const token = rt.get(id).callbackToken;
  if (token !== null && rt.stateOf(id) === "SUBMITTED") {
    rt.callback(id, "settled", token, T0 + 20 * MINUTE, "cb-1");
  }

  return {
    point,
    stateAfterCrash,
    recovered,
    finalState: rt.stateOf(id),
    submissions: rt.provider.submissionCount,
    timersPending: rt.timers.pendingCount,
  };
}

const crashMatrix = CRASH_POINTS.map(crashRow);

// --- E3: where the answer lives ---------------------------------------------

/**
 * The same lifecycle on both drivers, then the engine's retention window
 * passes, then both are asked the same question.
 */
function whereTheAnswerLives() {
  const db = new DatabaseBackedDriver();
  const engine = new EngineBackedDriver();
  const a = runLifecycle(db, "po-db-1", T0);
  const b = runLifecycle(engine, "po-engine-1", T0);
  const RETENTION_MS = 90 * DAY;
  const expired = engine.expireExecutions(T0 + RETENTION_MS + DAY, RETENTION_MS);
  return {
    retentionDays: 90,
    database: { duringRun: a.finalState, afterRetention: db.stateOf("po-db-1") },
    engine: { duringRun: b.finalState, afterRetention: engine.stateOf("po-engine-1") },
    executionsExpired: expired,
  };
}

const answerLocation = whereTheAnswerLives();

// --- E4: negative controls --------------------------------------------------

/**
 * One lifecycle that touches every runtime check, run clean and then with each
 * check removed in turn.
 *
 * Deliberately small and explicit. A control that silently covers everything
 * proves nothing about any particular check, so this scenario is written to
 * exercise each one exactly once: a terminal re-entry, a stale version, an
 * unleased write, a failing guard, and a mismatched callback token.
 */
function probe(mutation?: Mutation) {
  const rt = new Runtime(mutation === undefined ? {} : { mutation });
  const id = "probe";
  rt.create({
    id, amountMinor: 900_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "create",
  });
  rt.step(id, "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  // The initiator tries to approve their own payout: a guard refusal.
  rt.step(id, "review_approve", { id: "initiator-1", kind: "operator", approvalLimitMinor: 10_000_000 },
    T0 + 2 * MINUTE, { correlationId: "self-approve" });
  // A reviewer acting on a version that has already moved: a concurrency refusal.
  rt.step(id, "review_approve", { id: "reviewer-9", kind: "operator", approvalLimitMinor: 10_000_000 },
    T0 + 3 * MINUTE, { correlationId: "approve-stale", expectedVersion: 0 });
  rt.step(id, "review_approve", { id: "reviewer-9", kind: "operator", approvalLimitMinor: 10_000_000 },
    T0 + 4 * MINUTE, { correlationId: "approve" });
  // A worker that holds no lease: a lease refusal.
  rt.step(id, "submit", worker("stranger"), T0 + 5 * MINUTE, { correlationId: "submit-x", takeLease: false });
  rt.step(id, "submit", SERVICE, T0 + 6 * MINUTE, { correlationId: "submit" });
  const token = rt.get(id).callbackToken ?? "";
  // A callback carrying the wrong token: a correlation refusal.
  rt.callback(id, "settled", "wrong-token", T0 + HOUR, "cb-bad");
  rt.callback(id, "settled", token, T0 + HOUR + 1, "cb-good");
  // After the terminal state: a terminal refusal and a stale-version refusal.
  rt.step(id, "submit", SERVICE, T0 + HOUR + 3, { correlationId: "submit-again" });
  rt.step(id, "authorize", SERVICE, T0 + HOUR + 4, { correlationId: "auth", expectedVersion: 0 });
  const p = rt.get(id);
  return {
    finalState: p.state,
    providerSubmissions: rt.provider.submissionCount,
    historyLength: p.history.length,
    refusals: rt.refusals.map((r) => r.code),
  };
}

const baseline = probe();

const runtimeControls = MUTATIONS.map((m) => {
  let after: ReturnType<typeof probe> | null = null;
  let threw = "";
  try { after = probe(m); } catch (e) { threw = (e as Error).message.slice(0, 60); }
  const changed: string[] = [];
  if (threw !== "") changed.push(`threw: ${threw}`);
  else if (after !== null) {
    if (after.finalState !== baseline.finalState) changed.push(`final state ${baseline.finalState} -> ${after.finalState}`);
    if (after.providerSubmissions !== baseline.providerSubmissions) {
      changed.push(`submissions ${baseline.providerSubmissions} -> ${after.providerSubmissions}`);
    }
    if (after.historyLength !== baseline.historyLength) {
      changed.push(`history length ${baseline.historyLength} -> ${after.historyLength}`);
    }
    const lost = baseline.refusals.filter((r) => !after!.refusals.includes(r));
    if (lost.length > 0) changed.push(`refusals lost: ${[...new Set(lost)].join(", ")}`);
  }
  return { removed: m, detected: changed.length > 0, evidence: changed };
});

const specControls = SPEC_MUTATIONS.map((m) => {
  const findings = verify(mutateSpec(SPEC_V2, m));
  const failed = findings.filter((f) => !f.ok).map((f) => f.check);
  return { removed: m, checksTurnedRed: failed, detected: failed.length > 0 };
});

// --- write ------------------------------------------------------------------

const verification = verify(SPEC_V2);

const payload = {
  generatedFrom: "scripts/report.ts",
  evaluatedAt: new Date(T0).toISOString(),
  note: "Deterministic. No cloud project, no credentials, no network.",
  specVersion: SPEC_V2.version,
  verification,
  transitionCoverage: {
    permitted: uniquePermitted.length,
    exercised: uniquePermitted.length - uncovered.length,
    uncovered,
  },
  scenarios: traces.map((t) => ({
    id: t.id, title: t.title, covers: t.covers,
    finalState: t.trace.finalState,
    providerSubmissions: t.trace.providerSubmissions,
    refusals: t.trace.refusals,
    extra: t.trace.extra,
  })),
  refusalTally,
  universalInvariantFailures: invariantFailures,
  crashMatrix,
  answerLocation,
  negativeControls: { runtime: runtimeControls, spec: specControls },
};
writeFileSync(join(RESULTS, "report.json"), JSON.stringify(payload, null, 2) + "\n");

const l: string[] = [];
l.push("# durable-money-state-machine results");
l.push("");
l.push("Generated by `scripts/report.ts`. Deterministic: no cloud project, no");
l.push("credentials, no network.");
l.push("");
l.push("## Where the crash lands");
l.push("");
l.push("One payout, one transition that moves money, and a process that dies at");
l.push("each point of that transition in turn. After the crash a second worker");
l.push("inherits the entity, the unacknowledged task is redelivered, and the");
l.push("deadline runs.");
l.push("");
l.push("| crash point | state recorded | recovery | final state | provider submissions |");
l.push("|---|---|---|---|---:|");
for (const r of crashMatrix) {
  l.push(`| \`${r.point}\` | ${r.stateAfterCrash} | ${r.recovered} | **${r.finalState}** | **${r.submissions}** |`);
}
l.push("");
l.push("Every row submits once. The row to read twice is");
l.push("`after-commit-before-actions`: the payout records a submission that never");
l.push("happened, and the only thing that discovers it is the deadline.");
l.push("");
l.push("## Where the answer lives");
l.push("");
l.push("The same lifecycle, run on two drivers executing the same transition");
l.push("table. Then the orchestrator's execution-retention window passes, and");
l.push("both are asked the same question: what is the state of this payout?");
l.push("");
l.push("| driver | during the run | after the retention window |");
l.push("|---|---|---|");
l.push(`| application-owned row | ${answerLocation.database.duringRun} | ${answerLocation.database.afterRetention ?? "**no answer**"} |`);
l.push(`| orchestration execution | ${answerLocation.engine.duringRun} | ${answerLocation.engine.afterRetention ?? "**no answer**"} |`);
l.push("");
l.push(`Retention modelled at ${answerLocation.retentionDays} days; ${answerLocation.executionsExpired} execution(s) aged out.`);
l.push("");
l.push("## Transition coverage");
l.push("");
l.push(`**${uniquePermitted.length - uncovered.length} of ${uniquePermitted.length}** distinct permitted transitions are exercised by the scenarios.`);
if (uncovered.length > 0) l.push(`Uncovered: ${uncovered.join(", ")}.`);
l.push("");
l.push("Refusals raised across all scenarios, by the check that raised them:");
l.push("");
l.push("| refusal | count |");
l.push("|---|---:|");
for (const [k, v] of Object.entries(refusalTally).sort()) l.push(`| \`${k}\` | ${v} |`);
l.push("");
l.push("## Scenarios");
l.push("");
l.push("| id | scenario | covers | final state | submissions |");
l.push("|---|---|---|---|---:|");
for (const t of traces) {
  l.push(`| **${t.id}** | ${t.title} | ${t.covers} | ${t.trace.finalState} | ${t.trace.providerSubmissions} |`);
}
l.push("");
l.push(`Universal invariant failures: ${invariantFailures.length === 0 ? "none" : invariantFailures.join("; ")}.`);
l.push("");
l.push("## Specification verification");
l.push("");
l.push("| check | result | detail |");
l.push("|---|---|---|");
for (const f of verification) l.push(`| \`${f.check}\` | ${f.ok ? "PASS" : "**FAIL**"} | ${f.detail} |`);
l.push("");
l.push("## Negative controls");
l.push("");
l.push("A suite written by the same hand as the implementation proves nothing");
l.push("until each check has been shown to fail when the thing it checks is");
l.push("removed.");
l.push("");
l.push("### Runtime checks removed");
l.push("");
l.push("| check removed | detected | what changed |");
l.push("|---|---|---|");
for (const c of runtimeControls) {
  l.push(`| \`${c.removed}\` | ${c.detected ? "yes" : "**no**"} | ${c.evidence.join("; ") || "—"} |`);
}
l.push("");
l.push("### Specification defects introduced");
l.push("");
l.push("| defect | checks that turn red | detected |");
l.push("|---|---|---|");
for (const c of specControls) {
  l.push(`| \`${c.removed}\` | ${c.checksTurnedRed.map((x) => `\`${x}\``).join(", ") || "—"} | ${c.detected ? "yes" : "**no**"} |`);
}
l.push("");
writeFileSync(join(RESULTS, "report.md"), l.join("\n"));

console.log("wrote results/report.json and results/report.md");
