// The auditor. It never ran the saga.
//
// Everything in this file is computed from the participants' own effect
// ledgers and the saga definition. It does not read a saga record, it does not
// call the orchestrator, and it does not re-derive a command id. That is the
// point: the most reliable defect in this programme is a checker that shares
// arithmetic with the thing it checks, and a failure matrix scored by the
// orchestrator that produced it would be exactly that.
//
// The orchestrator says where it thinks the saga got to. The auditor says what
// the five services actually did. `reconcile` is the only place the two meet,
// and a disagreement is a defect in the orchestrator, not in the auditor.

import { pivotIndex } from "./saga.ts";
import type { Definition } from "./saga.ts";
import type { EffectRecord, SagaState, StepName } from "./types.ts";

/** What the effect ledgers say happened to one saga. */
export type Verdict = "COMPLETED" | "COMPENSATED" | "UNRESOLVED";

export interface Violation {
  readonly code: string;
  readonly step: StepName;
  readonly detail: string;
}

export interface AuditResult {
  readonly sagaId: string;
  readonly verdict: Verdict;
  /** Steps with a live, uncompensated effect. */
  readonly live: readonly StepName[];
  readonly applied: readonly StepName[];
  readonly compensated: readonly StepName[];
  readonly violations: readonly Violation[];
}

function countBy(rows: readonly EffectRecord[], kind: "applied" | "compensated"): Map<StepName, number> {
  const m = new Map<StepName, number>();
  for (const r of rows) {
    if (r.kind !== kind) continue;
    m.set(r.step, (m.get(r.step) ?? 0) + 1);
  }
  return m;
}

/**
 * Score one saga from the participants' records alone.
 *
 * `all` is every record every participant holds; this function picks out the
 * ones carrying `sagaId` and ignores everything else, which is also how a real
 * reconciliation job would have to work.
 */
export function audit(def: Definition, all: readonly EffectRecord[], sagaId: string): AuditResult {
  const rows = all.filter((r) => r.sagaId === sagaId);
  const appliedCounts = countBy(rows, "applied");
  const compensatedCounts = countBy(rows, "compensated");
  const violations: Violation[] = [];

  for (const [step, n] of appliedCounts) {
    if (n > 1) {
      violations.push({
        code: "DUPLICATE_EFFECT", step,
        detail: `${n} applied effects for one saga step`,
      });
    }
  }

  // A compensation record names a step. The forward step and its compensation
  // are different command names, so the compensation record is matched back to
  // the step it undoes through the definition rather than through string
  // equality on the orchestrator's key.
  const compensatedSteps = new Set<StepName>();
  for (const [name] of compensatedCounts) {
    const forward = def.steps.find((s) => s.compensation === name || s.name === name);
    if (forward === undefined) {
      violations.push({ code: "UNKNOWN_COMPENSATION_RECORD", step: name, detail: "no step in this definition declares it" });
      continue;
    }
    compensatedSteps.add(forward.name);
    if ((appliedCounts.get(forward.name) ?? 0) === 0) {
      violations.push({
        code: "COMPENSATION_WITHOUT_EFFECT", step: forward.name,
        detail: "a compensation record exists for a step that never applied",
      });
    }
  }

  const appliedSteps = [...appliedCounts.keys()].sort();
  const pivot = def.steps[pivotIndex(def)]!;
  const pivotApplied = (appliedCounts.get(pivot.name) ?? 0) > 0;

  if (pivotApplied && compensatedSteps.size > 0) {
    for (const s of compensatedSteps) {
      violations.push({
        code: "COMPENSATED_AFTER_PIVOT", step: s,
        detail: "an effect was undone although the saga had already committed",
      });
    }
  }

  const live = appliedSteps.filter((s) => !compensatedSteps.has(s)).sort();

  let verdict: Verdict;
  const afterPivot = def.steps.slice(pivotIndex(def)).map((s) => s.name);
  if (pivotApplied && afterPivot.every((n) => (appliedCounts.get(n) ?? 0) > 0)) {
    verdict = "COMPLETED";
  } else if (!pivotApplied && live.length === 0) {
    verdict = "COMPENSATED";
  } else {
    verdict = "UNRESOLVED";
  }

  if (verdict === "COMPLETED") {
    const auth = (appliedCounts.get("authorize_payment") ?? 0) > 0;
    if (!auth) {
      violations.push({
        code: "CAPTURE_WITHOUT_AUTHORIZATION", step: pivot.name,
        detail: "the ledgers show a capture with no authorization behind it",
      });
    }
  }

  // A live, uncompensated effect is deliberately *not* a violation. A saga
  // stopped in a state a person owns has live effects by design, and that is
  // the whole purpose of the state. The live list is the evidence; whether it
  // is a defect depends on what the saga claims, which only `reconcile` knows.

  return {
    sagaId, verdict, live, applied: appliedSteps,
    compensated: [...compensatedSteps].sort(), violations,
  };
}

/** The outcome classes the failure matrix reports. */
export type Outcome = "COMPLETED" | "COMPENSATED" | "MANUAL" | "PENDING";

export function outcomeOf(state: SagaState): Outcome {
  switch (state) {
    case "COMPLETED": return "COMPLETED";
    case "COMPENSATED": return "COMPENSATED";
    case "MANUAL_REPAIR":
    case "COMPENSATION_FAILED":
    case "CLOSED_MANUALLY": return "MANUAL";
    default: return "PENDING";
  }
}

/**
 * Does the saga's own account of itself match the evidence?
 *
 * Returns null when the two agree, and the reason when they do not. A saga
 * closed by an operator is exempt: the whole meaning of that state is that a
 * human accepted a position the machine could not reach.
 */
export function reconcile(state: SagaState, result: AuditResult): string | null {
  if (result.violations.length > 0) {
    return `${result.violations.length} ledger violation(s): ${result.violations.map((v) => v.code).join(", ")}`;
  }
  if (state === "CLOSED_MANUALLY") return null;
  if (state === "COMPLETED" && result.verdict !== "COMPLETED") {
    return `the saga says COMPLETED, the ledgers say ${result.verdict}`;
  }
  if (state === "COMPENSATED" && result.verdict !== "COMPENSATED") {
    return `the saga says COMPENSATED, the ledgers say ${result.verdict}`;
  }
  const terminal = state === "COMPLETED" || state === "COMPENSATED";
  if (!terminal && result.verdict !== "UNRESOLVED") {
    return `the saga is ${state}, the ledgers say ${result.verdict}`;
  }
  return null;
}
