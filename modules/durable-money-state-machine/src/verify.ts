// Verification of the specification itself.
//
// These checks read the spec and nothing else. They do not run the machine,
// they do not need a store, and they are fast enough to run on every build.
// What they catch is a class of defect that no amount of scenario testing
// finds reliably: a state nothing can reach, a state nothing can leave, a
// terminal state with a way out, a wait with no deadline.
//
// What they do not catch is a specification that is well formed and wrong.
// Version 1 of this machine passes every check below and still turns "I cannot
// find out" into "declined", which is a judgement error, not a shape error.
// Verification tells you the diagram is connected. It does not tell you the
// business is right.

import { SPECS } from "./spec.ts";
import type { Spec } from "./spec.ts";
import type { State, Trigger } from "./types.ts";

export interface Finding {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export const CHECKS = [
  "every-state-reachable",
  "every-state-can-terminate",
  "terminal-states-are-sinks",
  "no-duplicate-rows",
  "guards-exist",
  "every-waiting-state-has-an-owner-and-deadline",
  "declared-waits-match-the-table",
  "reason-codes-unique-per-destination",
] as const;

export type Check = (typeof CHECKS)[number];

export function verify(spec: Spec): readonly Finding[] {
  return [
    everyStateReachable(spec),
    everyStateCanTerminate(spec),
    terminalStatesAreSinks(spec),
    noDuplicateRows(spec),
    guardsExist(spec),
    everyWaitingStateHasAnOwnerAndDeadline(spec),
    declaredWaitsMatchTheTable(spec),
    reasonCodesUniquePerDestination(spec),
  ];
}

export function verifyAll(): Readonly<Record<string, readonly Finding[]>> {
  return { "v1": verify(SPECS[1]), "v2": verify(SPECS[2]) };
}

// --- the checks -------------------------------------------------------------

/** A state nothing can reach is dead code with a name. */
function everyStateReachable(spec: Spec): Finding {
  const seen = new Set<State>([spec.initial]);
  const queue: State[] = [spec.initial];
  while (queue.length > 0) {
    const s = queue.shift()!;
    for (const t of spec.transitions) {
      if (t.from === s && !seen.has(t.to)) {
        seen.add(t.to);
        queue.push(t.to);
      }
    }
  }
  const unreachable = spec.states.filter((s) => !seen.has(s));
  return finding("every-state-reachable", unreachable.length === 0,
    unreachable.length === 0 ? `${spec.states.length} states reachable from ${spec.initial}`
      : `unreachable: ${unreachable.join(", ")}`);
}

/**
 * A non-terminal state with no path to any terminal state is a trap.
 *
 * In a money-movement machine a trap is worse than a crash, because the
 * payout is neither done nor visibly broken. It is simply never finished.
 */
function everyStateCanTerminate(spec: Spec): Finding {
  const terminal = new Set<State>(spec.terminal);
  const canReach = new Set<State>(terminal);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of spec.transitions) {
      if (canReach.has(t.to) && !canReach.has(t.from)) {
        canReach.add(t.from);
        grew = true;
      }
    }
  }
  const trapped = spec.states.filter((s) => !canReach.has(s));
  return finding("every-state-can-terminate", trapped.length === 0,
    trapped.length === 0 ? "every state has a path to a terminal state"
      : `no path to any terminal state: ${trapped.join(", ")}`);
}

/** Terminal means terminal. A way out of SETTLED is a way to unsettle money. */
function terminalStatesAreSinks(spec: Spec): Finding {
  const bad = spec.transitions.filter((t) => spec.terminal.includes(t.from));
  return finding("terminal-states-are-sinks", bad.length === 0,
    bad.length === 0 ? `${spec.terminal.length} terminal states have no outgoing transitions`
      : bad.map((t) => `${t.from} --${t.trigger}--> ${t.to}`).join(", "));
}

/**
 * Two rows for one (from, trigger) pair are allowed -- that is a conditional
 * transition -- but two rows with *identical* guard lists are not, because the
 * second can never be taken and the reader cannot tell which one applies.
 */
function noDuplicateRows(spec: Spec): Finding {
  const seen = new Map<string, number>();
  for (const t of spec.transitions) {
    const key = `${t.from}/${t.trigger}/${[...t.guards].sort().join("+")}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  return finding("no-duplicate-rows", dupes.length === 0,
    dupes.length === 0 ? `${spec.transitions.length} rows, all distinct`
      : `duplicate rows: ${dupes.join(", ")}`);
}

/** A row naming a guard the spec does not define would throw at runtime. */
function guardsExist(spec: Spec): Finding {
  const missing = new Set<string>();
  for (const t of spec.transitions) {
    for (const g of t.guards) if (spec.guards[g] === undefined) missing.add(g);
  }
  return finding("guards-exist", missing.size === 0,
    missing.size === 0 ? `${Object.keys(spec.guards).length} guards defined`
      : `undefined guards: ${[...missing].join(", ")}`);
}

/**
 * The core invariant, as a check.
 *
 * A non-terminal state that nothing inside the system can move on its own is a
 * state the process is *waiting* in. Every such state must declare who it is
 * waiting for and how long that wait is allowed to last. This is the one check
 * that would have caught the review queue nobody looks at.
 */
function everyWaitingStateHasAnOwnerAndDeadline(spec: Spec): Finding {
  const autonomous = new Set<Trigger>(spec.autonomous);
  const bad: string[] = [];
  for (const s of spec.states) {
    if (spec.terminal.includes(s)) continue;
    const selfDriven = spec.transitions.some((t) => t.from === s && autonomous.has(t.trigger));
    if (selfDriven) continue;
    const wait = spec.waits[s];
    if (wait === undefined) { bad.push(`${s}: no declared wait`); continue; }
    if (!(wait.deadlineMs > 0)) bad.push(`${s}: wait has no positive deadline`);
    if (wait.owner.trim() === "") bad.push(`${s}: wait has no owner`);
  }
  return finding("every-waiting-state-has-an-owner-and-deadline", bad.length === 0,
    bad.length === 0 ? "every waiting state names an owner and a deadline" : bad.join("; "));
}

/**
 * A declared timer deadline must correspond to a real row in the table.
 *
 * This is the drift check between the two halves of the specification: it is
 * easy to write a wait that escalates to a state the table cannot reach from
 * there, and the result is a deadline that fires into nothing.
 */
function declaredWaitsMatchTheTable(spec: Spec): Finding {
  const bad: string[] = [];
  for (const [state, wait] of Object.entries(spec.waits)) {
    if (wait === undefined) continue;
    if (!spec.states.includes(state as State)) { bad.push(`${state}: not a state`); continue; }
    if (wait.mechanism !== "timer") continue;
    if (wait.escalatesTo === undefined) { bad.push(`${state}: timer wait with no escalation target`); continue; }
    const row = spec.transitions.find(
      (t) => t.from === state && t.trigger === "timer_expired" && t.to === wait.escalatesTo,
    );
    if (row === undefined) bad.push(`${state}: no timer_expired row to ${wait.escalatesTo}`);
  }
  for (const t of spec.transitions) {
    if (t.trigger !== "timer_expired") continue;
    const wait = spec.waits[t.from];
    if (wait === undefined || wait.mechanism !== "timer") {
      bad.push(`${t.from}: timer_expired row with no declared timer wait`);
    }
  }
  return finding("declared-waits-match-the-table", bad.length === 0,
    bad.length === 0 ? "every timer deadline has a row and every row has a deadline" : bad.join("; "));
}

/**
 * Two rows reaching the same destination for different reasons must say so
 * with different reason codes, or the history cannot explain itself.
 *
 * The exception is deliberate and declared: both late-callback rows reach
 * their destinations for the same reason, from the same state.
 */
function reasonCodesUniquePerDestination(spec: Spec): Finding {
  const byCode = new Map<string, Set<string>>();
  for (const t of spec.transitions) {
    const set = byCode.get(t.reasonCode) ?? new Set<string>();
    set.add(`${t.from}->${t.to}`);
    byCode.set(t.reasonCode, set);
  }
  const bad: string[] = [];
  for (const [code, pairs] of byCode) {
    const froms = new Set([...pairs].map((p) => p.split("->")[0]));
    if (froms.size > 1) bad.push(`${code} used from ${[...froms].join(" and ")}`);
  }
  return finding("reason-codes-unique-per-destination", bad.length === 0,
    bad.length === 0 ? `${byCode.size} reason codes, none spanning two source states` : bad.join("; "));
}

function finding(check: Check, ok: boolean, detail: string): Finding {
  return { check, ok, detail };
}

// --- spec mutations, for the negative controls ------------------------------

export type SpecMutation =
  | "add-unreachable-state"
  | "add-exit-from-terminal"
  | "drop-the-review-deadline"
  | "escalate-to-nowhere";

export const SPEC_MUTATIONS: readonly SpecMutation[] = [
  "add-unreachable-state", "add-exit-from-terminal", "drop-the-review-deadline", "escalate-to-nowhere",
];

/** Break the spec on purpose and return it, so the checks can be shown to fire. */
export function mutateSpec(spec: Spec, m: SpecMutation): Spec {
  switch (m) {
    case "add-unreachable-state":
      return { ...spec, states: [...spec.states, "DRAFT_ORPHAN" as State] };
    case "add-exit-from-terminal":
      return {
        ...spec,
        transitions: [...spec.transitions, {
          from: "SETTLED" as State, trigger: "cancel" as Trigger, to: "CANCELLED" as State,
          reasonCode: "UNSETTLE", guards: [], actions: () => [], note: "deliberate defect",
        }],
      };
    case "drop-the-review-deadline": {
      const waits = { ...spec.waits };
      delete waits["MANUAL_REVIEW"];
      return { ...spec, waits };
    }
    case "escalate-to-nowhere": {
      const waits = { ...spec.waits };
      const submitted = waits["SUBMITTED"];
      if (submitted !== undefined) waits["SUBMITTED"] = { ...submitted, escalatesTo: "CANCELLED" as State };
      return { ...spec, waits };
    }
  }
}
