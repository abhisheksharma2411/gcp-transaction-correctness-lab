// The negative controls.
//
// Each mutation in `src/policy.ts` is paired here with the shortest run that
// should notice it and with the observable that must change. The report prints
// the table; `tests/controls.test.ts` asserts every row. Neither can drift
// from the other, because both call this.
//
// The rule applied throughout: a control passes only when a *named* observable
// changes. "Something was different" is not a control, because almost any
// mutation changes something.

import { run } from "./matrix.ts";
import type { Run, RunOptions } from "./matrix.ts";
import { MUTATION_INTENT, MUTATIONS } from "./policy.ts";
import type { Mutation } from "./policy.ts";

export interface Probe {
  readonly id: string;
  readonly what: string;
  readonly opts: RunOptions;
}

/** What a run looks like from outside, as a comparable string. */
export interface Observable {
  readonly state: string;
  readonly verdict: string;
  readonly agreed: boolean;
  readonly violations: readonly string[];
  readonly refusals: readonly string[];
  readonly effects: number;
}

export function observe(r: Run): Observable {
  return {
    state: r.record.state,
    verdict: r.audit.verdict,
    agreed: r.disagreement === null,
    violations: [...new Set(r.audit.violations.map((v) => v.code))].sort(),
    refusals: [...new Set(r.refusals.map((x) => x.code))].sort(),
    effects: r.world.allRecords().filter((x) => x.kind === "applied").length,
  };
}

export function render(o: Observable): string {
  return [
    o.state, o.verdict, o.agreed ? "agree" : "DISAGREE",
    o.violations.length === 0 ? "—" : o.violations.join("+"),
    o.refusals.length === 0 ? "—" : o.refusals.join("+"),
    `${o.effects} effects`,
  ].join(" / ");
}

const PROBES: Readonly<Record<Mutation, Probe>> = {
  "no-step-dedupe": {
    id: "p-dedupe",
    what: "the orchestrator dies after the pivot and retries it",
    opts: { faults: [{ step: "capture_payment", direction: "forward", at: "crash" }] },
  },
  "compensate-only-confirmed": {
    id: "p-pending",
    what: "a cancellation while the carrier has not yet answered",
    opts: { cancelWhileWaiting: true },
  },
  "forward-compensation-order": {
    id: "p-order",
    what: "the pivot is refused after a shipment has been booked",
    opts: { faults: [{ step: "capture_payment", direction: "forward", at: "reject" }] },
  },
  "no-wait-correlation": {
    id: "p-callback",
    what: "the carrier answers after the saga stopped waiting",
    opts: { cancelWhileWaiting: true },
  },
  "no-pivot-cancel-check": {
    id: "p-cancel",
    what: "a cancellation in flight while the pivot commits",
    opts: { cancelDuring: "capture_payment" },
  },
  "compensate-with-current-spec": {
    id: "p-version",
    what: "a version 1 saga compensating a step version 2 has deleted",
    opts: { faults: [{ step: "capture_payment", direction: "forward", at: "reject" }] },
  },
  "no-attempt-cap": {
    id: "p-bound",
    what: "a compensation the participant will never accept",
    opts: {
      faults: [
        { step: "capture_payment", direction: "forward", at: "reject" },
        { step: "void_authorization", direction: "compensate", at: "reject", sticky: true },
      ],
    },
  },
  "orchestrator-forgets-compensation": {
    id: "p-audit",
    what: "the pivot is refused and the chain runs",
    opts: { faults: [{ step: "capture_payment", direction: "forward", at: "reject" }] },
  },
};

/** The specific thing that must change, per mutation. */
export const EXPECTED_SIGNAL: Readonly<Record<Mutation, string>> = {
  "no-step-dedupe": "a DUPLICATE_EFFECT appears in the participants' ledgers",
  "compensate-only-confirmed": "the carrier books a shipment the saga believes it compensated, and the auditor disagrees",
  "forward-compensation-order": "inventory refuses to release units a live shipment depends on, and the chain stops",
  "no-wait-correlation": "the NO_WAIT_OUTSTANDING refusal disappears",
  "no-pivot-cancel-check": "a committed saga starts compensating and cannot void a captured payment",
  "compensate-with-current-spec": "the compensation for a deleted step cannot be found",
  "no-attempt-cap": "the saga never leaves COMPENSATING",
  "orchestrator-forgets-compensation": "the saga claims COMPENSATED while the ledgers show the effects are live",
};

export interface ControlResult {
  readonly mutation: Mutation;
  readonly intent: string;
  readonly probe: string;
  readonly expected: string;
  readonly baseline: Observable;
  readonly mutated: Observable;
  readonly changed: boolean;
}

export function controlFor(m: Mutation): ControlResult {
  const p = PROBES[m];
  const baseline = observe(run(`${p.id}-base`, p.opts));
  const mutated = observe(run(`${p.id}-mut`, { ...p.opts, mutation: m }));
  return {
    mutation: m, intent: MUTATION_INTENT[m], probe: p.what,
    expected: EXPECTED_SIGNAL[m], baseline, mutated,
    changed: render(baseline) !== render(mutated),
  };
}

export function allControls(): readonly ControlResult[] {
  return MUTATIONS.map(controlFor);
}
