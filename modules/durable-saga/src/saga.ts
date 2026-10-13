// The saga definition. One artifact; the documentation, both rendered diagrams
// and the invariant tests are generated from it, and `make verify` fails if any
// of them has drifted.
//
// Two tables, kept apart on purpose:
//
//   steps       -- the ordered participants, what each one does, what undoes
//                  it, and which one is the pivot
//   transitions -- where the saga execution itself can go, including the two
//                  states a human owns
//
// A step's compensation is a *forward* command sent to the same participant.
// It is not a rollback, it is not the step's inverse in any database sense,
// and the participant is free to refuse it.

import type { Participant, SagaState, SagaTrigger, StepName } from "./types.ts";

/** Where a node sits in the generated diagram. Column and row of a grid. */
export interface Layout {
  readonly col: number;
  readonly row: number;
}

export interface Step {
  readonly name: StepName;
  readonly participant: Participant;
  /** What the forward command does, in one line, for the generated docs. */
  readonly does: string;
  /**
   * The compensating command's name, or null when the step cannot be undone.
   *
   * Null has two different causes and the distinction matters: the pivot is
   * not compensated because the business has decided not to, and a step after
   * the pivot is not compensated because there is nothing left to go back to.
   */
  readonly compensation: StepName | null;
  readonly compensationDoes: string | null;
  /** The step that commits the saga. Exactly one step carries this. */
  readonly pivot: boolean;
  /**
   * The participant answers later, over a callback, rather than in the
   * response to the command.
   */
  readonly async: boolean;
  /** An effect the system cannot take back once it exists. */
  readonly irreversible: boolean;
  /** How many times the orchestrator will retry before giving up on this step. */
  readonly maxAttempts: number;
  readonly note: string;
}

export interface Transition {
  readonly from: SagaState;
  readonly trigger: SagaTrigger;
  readonly to: SagaState;
  readonly reasonCode: string;
  readonly note: string;
}

export interface Definition {
  readonly version: 1 | 2;
  readonly name: string;
  readonly steps: readonly Step[];
  readonly states: readonly SagaState[];
  readonly terminal: readonly SagaState[];
  /** States nothing inside the system will move. Each names who owns it. */
  readonly owned: Readonly<Partial<Record<SagaState, string>>>;
  readonly transitions: readonly Transition[];
  readonly layout: Readonly<Record<SagaState, Layout>>;
  /** How each transition's arrow is routed, so the picture cannot drift. */
  readonly routes: Readonly<Record<string, Route>>;
}

/**
 * The four ways an arrow may be drawn.
 *
 * Every vertical segment runs in a gap between columns and every lane runs
 * clear of every box, so no arrow can pass through a node. The generator
 * asserts that, rather than trusting it.
 */
export type Route = "straight" | "elbow" | "lane-above" | "lane-below" | "lane-below-2";

export const MAX_COMPENSATION_ATTEMPTS = 3;

// --- the states ------------------------------------------------------------

const STATES: readonly SagaState[] = [
  "RUNNING", "PIVOTED", "COMPLETED", "COMPENSATING", "COMPENSATED",
  "COMPENSATION_FAILED", "MANUAL_REPAIR", "CLOSED_MANUALLY",
];

const TERMINAL: readonly SagaState[] = ["COMPLETED", "COMPENSATED", "CLOSED_MANUALLY"];

const OWNED: Readonly<Partial<Record<SagaState, string>>> = {
  COMPENSATION_FAILED: "payments operations",
  MANUAL_REPAIR: "payments operations",
};

const TRANSITIONS: readonly Transition[] = [
  {
    from: "RUNNING", trigger: "step_failed", to: "COMPENSATING",
    reasonCode: "STEP_FAILED_BEFORE_PIVOT",
    note: "A compensable step was refused or exhausted its attempts, so every durable effect recorded so far has to be undone in reverse order.",
  },
  {
    from: "RUNNING", trigger: "cancel_requested", to: "COMPENSATING",
    reasonCode: "CANCELLED_BEFORE_PIVOT",
    note: "A cancellation that arrives while the saga is still compensable is accepted and runs the same compensation chain a failure would.",
  },
  {
    from: "RUNNING", trigger: "pivot_committed", to: "PIVOTED",
    reasonCode: "PIVOT_COMMITTED",
    note: "The pivot step has a durable effect the business has decided not to undo. From here the saga can only go forward.",
  },
  {
    from: "PIVOTED", trigger: "forward_complete", to: "COMPLETED",
    reasonCode: "ALL_STEPS_DONE",
    note: "Every step after the pivot has a recorded effect.",
  },
  {
    from: "PIVOTED", trigger: "forward_exhausted", to: "MANUAL_REPAIR",
    reasonCode: "FORWARD_EXHAUSTED",
    note: "A step after the pivot ran out of attempts. Compensating is not available, so the saga stops and names an owner.",
  },
  {
    from: "COMPENSATING", trigger: "compensations_complete", to: "COMPENSATED",
    reasonCode: "ALL_COMPENSATIONS_DONE",
    note: "Every recorded effect has a matching compensation record at the participant that produced it.",
  },
  {
    from: "COMPENSATING", trigger: "compensation_exhausted", to: "COMPENSATION_FAILED",
    reasonCode: "COMPENSATION_EXHAUSTED",
    note: "A compensation ran out of attempts. The saga does not loop on it; it stops with the chain half-run and raises it.",
  },
  {
    from: "COMPENSATION_FAILED", trigger: "operator_retried", to: "COMPENSATING",
    reasonCode: "OPERATOR_RETRY",
    note: "An operator resumes the chain where it stopped. It restarts no compensation that already has a record.",
  },
  {
    from: "COMPENSATION_FAILED", trigger: "operator_closed", to: "CLOSED_MANUALLY",
    reasonCode: "OPERATOR_CLOSED_COMPENSATION",
    note: "An operator closes a saga that cannot be compensated automatically, leaving the effects that remain visible rather than claiming they are gone.",
  },
  {
    from: "MANUAL_REPAIR", trigger: "operator_resumed", to: "PIVOTED",
    reasonCode: "OPERATOR_RESUME",
    note: "An operator returns a committed saga to the forward path. The cursor is unchanged, so the repair resumes rather than replays.",
  },
  {
    from: "MANUAL_REPAIR", trigger: "operator_closed", to: "CLOSED_MANUALLY",
    reasonCode: "OPERATOR_CLOSED_FORWARD",
    note: "An operator accepts a committed saga as finished without its remaining steps, which is a business decision and is recorded as one.",
  },
];

/** Grid position per state. Four columns, four rows. */
const LAYOUT: Readonly<Record<SagaState, Layout>> = {
  RUNNING: { col: 0, row: 0 },
  PIVOTED: { col: 1, row: 0 },
  COMPLETED: { col: 3, row: 0 },
  MANUAL_REPAIR: { col: 2, row: 1 },
  COMPENSATING: { col: 1, row: 2 },
  COMPENSATED: { col: 3, row: 2 },
  COMPENSATION_FAILED: { col: 2, row: 3 },
  CLOSED_MANUALLY: { col: 3, row: 3 },
};

/**
 * One route per transition, keyed `from|trigger`.
 *
 * A transition added without a route makes the generator throw, which makes
 * the build fail. That is deliberate: the usual way a diagram comes to
 * contradict its article is that somebody added a row and nobody redrew.
 */
const ROUTES: Readonly<Record<string, Route>> = {
  "RUNNING|pivot_committed": "straight",
  "RUNNING|step_failed": "elbow",
  "RUNNING|cancel_requested": "lane-below",
  "PIVOTED|forward_complete": "straight",
  "PIVOTED|forward_exhausted": "elbow",
  "COMPENSATING|compensations_complete": "straight",
  "COMPENSATING|compensation_exhausted": "elbow",
  "COMPENSATION_FAILED|operator_retried": "lane-below-2",
  "COMPENSATION_FAILED|operator_closed": "straight",
  "MANUAL_REPAIR|operator_resumed": "lane-above",
  "MANUAL_REPAIR|operator_closed": "elbow",
};

// --- the steps -------------------------------------------------------------

const V1_STEPS: readonly Step[] = [
  {
    name: "reserve_stock", participant: "inventory",
    does: "holds the ordered units against the order id",
    compensation: "release_stock", compensationDoes: "returns the units to stock",
    pivot: false, async: false, irreversible: false, maxAttempts: 3,
    note: "First because it is the cheapest refusal: an order that cannot be filled should not reach a payment provider.",
  },
  {
    name: "authorize_payment", participant: "payments",
    does: "places a hold on the cardholder's funds",
    compensation: "void_authorization", compensationDoes: "releases the hold",
    pivot: false, async: false, irreversible: false, maxAttempts: 3,
    note: "A hold is the cleanest compensable money step: voiding it leaves no settled movement to reconcile.",
  },
  {
    name: "book_shipment", participant: "fulfilment",
    does: "asks the carrier for a shipment and waits for the booking reference",
    compensation: "cancel_shipment", compensationDoes: "cancels the booking",
    pivot: false, async: true, irreversible: false, maxAttempts: 3,
    note: "The only step whose answer arrives later. Its callback is the one that can turn up after the saga has started compensating.",
  },
  {
    name: "capture_payment", participant: "payments",
    does: "settles the held funds",
    compensation: null, compensationDoes: null,
    pivot: true, async: false, irreversible: false, maxAttempts: 4,
    note: "The pivot. A capture is technically refundable, and this saga still does not treat a refund as its compensation: a refund is a new business process with its own evidence, which Article 14 and Article 21 own.",
  },
  {
    name: "post_ledger_entry", participant: "ledger",
    does: "writes the order's accounting entry",
    compensation: null, compensationDoes: null,
    pivot: false, async: false, irreversible: false, maxAttempts: 4,
    note: "After the pivot, so it is retried rather than compensated. Article 14 owns what the entry contains.",
  },
  {
    name: "send_confirmation", participant: "notifications",
    does: "emails the customer their confirmation",
    compensation: null, compensationDoes: null,
    pivot: false, async: false, irreversible: true, maxAttempts: 4,
    note: "Irreversible, and therefore deliberately last. An email sent before the pivot would be a lie the saga could not retract.",
  },
];

/**
 * Version 2 replaces the carrier integration.
 *
 * `book_shipment` is gone and `schedule_delivery` takes its place. The point
 * of keeping it in the module is not the migration — Article 13 owns
 * specification versions and the pinning of in-flight entities — but the
 * consequence that is specific to sagas: a saga pinned to version 1 may still
 * need `cancel_shipment`, which version 2 does not define. The compensation
 * for a step that no longer exists has to stay deployed until the last pinned
 * saga has finished.
 */
const V2_STEPS: readonly Step[] = [
  V1_STEPS[0]!,
  V1_STEPS[1]!,
  {
    name: "schedule_delivery", participant: "fulfilment",
    does: "books a delivery slot with the replacement carrier",
    compensation: "release_slot", compensationDoes: "gives the slot back",
    pivot: false, async: true, irreversible: false, maxAttempts: 3,
    note: "The replacement for book_shipment. Same participant, different command, and a compensation under a different name.",
  },
  V1_STEPS[3]!,
  V1_STEPS[4]!,
  V1_STEPS[5]!,
];

export const SAGA_V1: Definition = {
  version: 1, name: "order-fulfilment",
  steps: V1_STEPS, states: STATES, terminal: TERMINAL, owned: OWNED,
  transitions: TRANSITIONS, layout: LAYOUT, routes: ROUTES,
};

export const SAGA_V2: Definition = {
  version: 2, name: "order-fulfilment",
  steps: V2_STEPS, states: STATES, terminal: TERMINAL, owned: OWNED,
  transitions: TRANSITIONS, layout: LAYOUT, routes: ROUTES,
};

export const DEFINITIONS: Readonly<Record<1 | 2, Definition>> = { 1: SAGA_V1, 2: SAGA_V2 };

// --- derived views, all computed from the tables above ----------------------

export function pivotIndex(def: Definition): number {
  return def.steps.findIndex((s) => s.pivot);
}

export function stepByName(def: Definition, name: StepName): Step | undefined {
  return def.steps.find((s) => s.name === name);
}

/** Steps before the pivot, which are the ones a compensation chain can reach. */
export function compensableSteps(def: Definition): readonly Step[] {
  return def.steps.slice(0, pivotIndex(def)).filter((s) => s.compensation !== null);
}

/** Steps from the pivot onward, which are retried instead of undone. */
export function forwardOnlySteps(def: Definition): readonly Step[] {
  return def.steps.slice(pivotIndex(def));
}

export function transitionFor(
  def: Definition, from: SagaState, trigger: SagaTrigger,
): Transition | undefined {
  return def.transitions.find((t) => t.from === from && t.trigger === trigger);
}

export function isTerminal(def: Definition, state: SagaState): boolean {
  return def.terminal.includes(state);
}

// --- static checks on the definition itself ---------------------------------

export interface Finding {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Seven checks that run on every build, before anything executes.
 *
 * Each one is also run against a definition deliberately broken in the way it
 * claims to detect; see `src/policy.ts` and `tests/controls.test.ts`.
 */
export function verifyDefinition(def: Definition): readonly Finding[] {
  const out: Finding[] = [];
  const names = def.steps.map((s) => s.name);

  const pivots = def.steps.filter((s) => s.pivot);
  out.push({
    check: "exactly-one-pivot", ok: pivots.length === 1,
    detail: pivots.length === 1
      ? `pivot is ${pivots[0]!.name}`
      : `${pivots.length} steps are marked as the pivot`,
  });

  const afterPivotCompensated = def.steps.slice(pivotIndex(def) + 1).filter((s) => s.compensation !== null);
  out.push({
    check: "nothing-after-the-pivot-is-compensated", ok: afterPivotCompensated.length === 0,
    detail: afterPivotCompensated.length === 0
      ? "every step after the pivot is retried, not undone"
      : `compensations declared after the pivot: ${afterPivotCompensated.map((s) => s.name).join(", ")}`,
  });

  const earlyIrreversible = def.steps.slice(0, pivotIndex(def)).filter((s) => s.irreversible);
  out.push({
    check: "irreversible-steps-sit-after-the-pivot", ok: earlyIrreversible.length === 0,
    detail: earlyIrreversible.length === 0
      ? "no irreversible effect is produced while the saga can still be undone"
      : `irreversible before the pivot: ${earlyIrreversible.map((s) => s.name).join(", ")}`,
  });

  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  out.push({
    check: "step-names-unique", ok: dupes.length === 0,
    detail: dupes.length === 0 ? `${names.length} distinct steps` : `repeated: ${dupes.join(", ")}`,
  });

  const unreachable = def.states.filter(
    (s) => s !== "RUNNING" && !def.transitions.some((t) => t.to === s),
  );
  out.push({
    check: "every-state-reachable", ok: unreachable.length === 0,
    detail: unreachable.length === 0 ? "all states have an inbound transition"
      : `no way into: ${unreachable.join(", ")}`,
  });

  const leaks = def.terminal.filter((s) => def.transitions.some((t) => t.from === s));
  out.push({
    check: "terminal-states-are-sinks", ok: leaks.length === 0,
    detail: leaks.length === 0 ? "nothing leaves a terminal state"
      : `transitions out of terminal states: ${leaks.join(", ")}`,
  });

  const unowned = def.states.filter(
    (s) => !def.terminal.includes(s)
      && !def.transitions.some((t) => t.from === s && !t.trigger.startsWith("operator_"))
      && def.owned[s] === undefined,
  );
  out.push({
    check: "stopped-states-name-an-owner", ok: unowned.length === 0,
    detail: unowned.length === 0
      ? "every state only an operator can leave names the operator"
      : `no owner declared for: ${unowned.join(", ")}`,
  });

  return out;
}
