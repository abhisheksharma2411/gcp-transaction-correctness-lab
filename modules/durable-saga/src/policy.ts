// The mutations. Each one removes a mechanism this module claims to need.
//
// A suite that stays green when a mechanism is removed is measuring nothing,
// so every mechanism below is deleted in turn and a specific, named observable
// has to change. The expectations live in `tests/controls.test.ts`; the list
// lives here so that the report and the tests cannot disagree about what was
// tried.

export type Mutation =
  /** Participants stop de-duplicating on the command id. */
  | "no-step-dedupe"
  /** The compensation chain covers only steps that answered, not steps that were sent. */
  | "compensate-only-confirmed"
  /** Compensations run in the order the steps ran, rather than in reverse. */
  | "forward-compensation-order"
  /** A callback is accepted whether or not the saga is still waiting for one. */
  | "no-wait-correlation"
  /** A cancellation is accepted after the pivot has committed. */
  | "no-pivot-cancel-check"
  /** Compensations are resolved against the current definition, not the pinned one. */
  | "compensate-with-current-spec"
  /** Nothing bounds how many times a step or a compensation is retried. */
  | "no-attempt-cap"
  /** The saga records a compensation it never sent. */
  | "orchestrator-forgets-compensation";

export const MUTATIONS: readonly Mutation[] = [
  "no-step-dedupe",
  "compensate-only-confirmed",
  "forward-compensation-order",
  "no-wait-correlation",
  "no-pivot-cancel-check",
  "compensate-with-current-spec",
  "no-attempt-cap",
  "orchestrator-forgets-compensation",
];

/** One line per mutation, for the generated report. */
export const MUTATION_INTENT: Readonly<Record<Mutation, string>> = {
  "no-step-dedupe": "participants stop de-duplicating on the command id",
  "compensate-only-confirmed": "the chain skips a step that was dispatched but never answered",
  "forward-compensation-order": "compensations run in the order the steps ran",
  "no-wait-correlation": "callbacks are accepted with no outstanding wait to satisfy",
  "no-pivot-cancel-check": "a cancellation is accepted after the pivot committed",
  "compensate-with-current-spec": "compensations are looked up in the current definition rather than the pinned one",
  "no-attempt-cap": "nothing bounds how many times a compensation is retried",
  "orchestrator-forgets-compensation": "the saga record claims a compensation that was never sent",
};

/** Ways to break the definition itself, checked before anything runs. */
export type SpecMutation =
  | "two-pivots"
  | "compensation-after-pivot"
  | "irreversible-before-pivot"
  | "terminal-state-with-an-exit";

export const SPEC_MUTATIONS: readonly SpecMutation[] = [
  "two-pivots",
  "compensation-after-pivot",
  "irreversible-before-pivot",
  "terminal-state-with-an-exit",
];
