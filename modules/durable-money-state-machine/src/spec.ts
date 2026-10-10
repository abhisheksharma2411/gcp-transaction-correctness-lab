// The specification. One artifact; everything else is generated from it.
//
// The diagram, the transition documentation, the waiting-condition table and
// the invariant tests all read this file. Nothing here is prose that can drift
// away from the code, because nothing here is prose.
//
// Two kinds of thing are declared, and keeping them apart is the design:
//
//   transitions -- what may happen, and what *action* happens once when it does
//   waits       -- what the machine is waiting for while it sits in a state,
//                  who owns that wait, and what deadline ends it
//
// A transition's action fires at an instant and cannot be repaired later. A
// wait is a standing condition: it can be recomputed from the state alone,
// which is what lets a worker that inherits a half-finished process re-arm the
// deadline instead of leaving the entity to sit forever.

import type { Effect, Input, Payout, State, Trigger } from "./types.ts";

/** A named, pure predicate evaluated before a transition is accepted. */
export interface Guard {
  readonly name: string;
  /** Returns null to allow, or a short reason to refuse. */
  readonly check: (payout: Payout, input: Input, nowMs: number) => string | null;
}

/** One row of the transition table. */
export interface Transition {
  readonly from: State;
  readonly trigger: Trigger;
  readonly to: State;
  /** Machine-readable, written into the history record. */
  readonly reasonCode: string;
  /** All guards must pass. Evaluated in order; the first refusal wins. */
  readonly guards: readonly string[];
  /** One-shot actions performed at the moment of transition. */
  readonly actions: (payout: Payout, input: Input, nowMs: number) => readonly Effect[];
  /** Why this row exists. Rendered into the generated documentation. */
  readonly note: string;
}

/** What a state is waiting for, who owns the wait, and when it ends. */
export interface Wait {
  /** Not a user id. The party the process is blocked on. */
  readonly owner: string;
  readonly deadlineMs: number;
  /**
   * `timer` -- a durable timer fires a trigger and the machine moves itself.
   * `sweep` -- nothing moves automatically; a periodic sweep raises it for a human.
   *
   * Both are deadlines. Only one is a transition, and pretending otherwise is
   * how review queues acquire items nobody has looked at since March.
   */
  readonly mechanism: "timer" | "sweep";
  /** Required when the mechanism is a timer: the state the deadline leads to. */
  readonly escalatesTo?: State;
  readonly note: string;
}

export interface Spec {
  readonly version: 1 | 2;
  readonly initial: State;
  readonly states: readonly State[];
  readonly terminal: readonly State[];
  /**
   * Triggers a worker can issue on its own initiative, without anyone outside
   * the system doing anything.
   *
   * `timer_expired` is deliberately absent. A deadline is not progress; it is
   * the mechanism that notices the absence of progress.
   */
  readonly autonomous: readonly Trigger[];
  readonly transitions: readonly Transition[];
  readonly waits: Readonly<Partial<Record<State, Wait>>>;
  readonly guards: Readonly<Record<string, Guard>>;
}

// --- constants the guards and actions depend on -----------------------------

/** Above this, a payout needs a human. Synthetic; minor units. */
export const REVIEW_THRESHOLD_MINOR = 500_000;

/** How long the provider has to call back before the deadline fires. */
export const CALLBACK_DEADLINE_MS = 6 * 60 * 60 * 1000; // 6 hours

/** How long a payout may sit in a review queue before the sweep raises it. */
export const REVIEW_DEADLINE_MS = 24 * 60 * 60 * 1000; // 1 day

/** How long a worker's claim on an entity lasts before another may take it. */
export const LEASE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const CALLBACK_TIMER = "callback-deadline";

// --- guards -----------------------------------------------------------------

const guardList: readonly Guard[] = [
  {
    name: "amount-within-auto-limit",
    check: (p) =>
      p.amountMinor <= REVIEW_THRESHOLD_MINOR
        ? null
        : `amount ${p.amountMinor} exceeds the auto-approval limit ${REVIEW_THRESHOLD_MINOR}`,
  },
  {
    name: "amount-above-auto-limit",
    check: (p) =>
      p.amountMinor > REVIEW_THRESHOLD_MINOR
        ? null
        : `amount ${p.amountMinor} is within the auto-approval limit`,
  },
  {
    name: "actor-is-operator",
    check: (_p, i) => (i.actor.kind === "operator" ? null : `actor kind ${i.actor.kind} is not an operator`),
  },
  {
    name: "actor-is-service",
    check: (_p, i) => (i.actor.kind === "service" ? null : `actor kind ${i.actor.kind} is not a service`),
  },
  {
    name: "actor-is-provider",
    check: (_p, i) => (i.actor.kind === "provider" ? null : `actor kind ${i.actor.kind} is not the provider`),
  },
  {
    // Separation of duty. Whoever started a payout may not approve it.
    name: "reviewer-is-not-initiator",
    check: (p, i) =>
      i.actor.id !== p.initiatorId ? null : `actor ${i.actor.id} initiated this payout`,
  },
  {
    /**
     * The financial guard that manual review must not be able to bypass.
     *
     * Review is a *route* to approval, not an exemption from the limit. A
     * reviewer whose own authority is below the amount cannot approve it, and
     * approval returns the payout to AUTHORIZED rather than jumping it to a
     * terminal state.
     */
    name: "within-reviewer-limit",
    check: (p, i) =>
      p.amountMinor <= i.actor.approvalLimitMinor
        ? null
        : `amount ${p.amountMinor} exceeds reviewer limit ${i.actor.approvalLimitMinor}`,
  },
  {
    name: "callback-token-matches",
    check: (p, i) =>
      p.callbackToken !== null && i.callbackToken === p.callbackToken
        ? null
        : `callback token ${String(i.callbackToken)} does not match the outstanding token`,
  },
];

const GUARDS: Readonly<Record<string, Guard>> = Object.freeze(
  Object.fromEntries(guardList.map((g) => [g.name, g])),
);

// --- one-shot actions -------------------------------------------------------

const callProvider = (p: Payout): readonly Effect[] => [
  { kind: "CALL_PROVIDER", payoutId: p.id, callbackToken: p.callbackToken ?? "" },
];
const lookUpProvider = (p: Payout): readonly Effect[] => [
  { kind: "LOOKUP_PROVIDER", payoutId: p.id, callbackToken: p.callbackToken ?? "" },
];
const notifyReviewer = (p: Payout): readonly Effect[] => [{ kind: "NOTIFY_REVIEWER", payoutId: p.id }];
const noAction = (): readonly Effect[] => [];

// --- specification version 2 (current) --------------------------------------

const V2_TRANSITIONS: readonly Transition[] = [
  {
    from: "DRAFT", trigger: "authorize", to: "AUTHORIZED",
    reasonCode: "AUTO_APPROVED_WITHIN_LIMIT",
    guards: ["actor-is-service", "amount-within-auto-limit"],
    actions: noAction,
    note: "Small enough to approve without a human. No external effect yet.",
  },
  {
    from: "DRAFT", trigger: "authorize", to: "MANUAL_REVIEW",
    reasonCode: "ROUTED_TO_REVIEW_OVER_LIMIT",
    guards: ["actor-is-service", "amount-above-auto-limit"],
    actions: notifyReviewer,
    note: "Over the limit. Review is a route to approval, never an exemption from it.",
  },
  {
    from: "DRAFT", trigger: "cancel", to: "CANCELLED",
    reasonCode: "CANCELLED_BEFORE_AUTHORIZATION",
    guards: [],
    actions: noAction,
    note: "Nothing has been promised to anyone, so cancellation is free.",
  },
  {
    from: "AUTHORIZED", trigger: "submit", to: "SUBMITTED",
    reasonCode: "SUBMITTED_TO_PROVIDER",
    guards: ["actor-is-service"],
    actions: callProvider,
    note: "The only transition that creates an external monetary effect.",
  },
  {
    from: "AUTHORIZED", trigger: "cancel", to: "CANCELLED",
    reasonCode: "CANCELLED_BEFORE_SUBMISSION",
    guards: [],
    actions: noAction,
    note: "Still free: authorization is an internal fact.",
  },
  {
    from: "SUBMITTED", trigger: "callback_settled", to: "SETTLED",
    reasonCode: "PROVIDER_CONFIRMED_SETTLEMENT",
    guards: ["actor-is-provider", "callback-token-matches"],
    actions: noAction,
    note: "The token is what makes this callback this payout's callback.",
  },
  {
    from: "SUBMITTED", trigger: "callback_declined", to: "DECLINED",
    reasonCode: "PROVIDER_DECLINED",
    guards: ["actor-is-provider", "callback-token-matches"],
    actions: noAction,
    note: "A decline is an answer, and an answer is a success for the state machine.",
  },
  {
    from: "SUBMITTED", trigger: "timer_expired", to: "RECONCILING",
    reasonCode: "CALLBACK_DEADLINE_PASSED",
    guards: [],
    actions: lookUpProvider,
    note: "The deadline passing is a fact about our waiting, not a fact about the money.",
  },
  {
    from: "RECONCILING", trigger: "lookup_settled", to: "SETTLED",
    reasonCode: "RESOLVED_SETTLED_BY_LOOKUP",
    guards: ["actor-is-service"],
    actions: noAction,
    note: "The provider knew all along; the callback was what went missing.",
  },
  {
    from: "RECONCILING", trigger: "lookup_declined", to: "DECLINED",
    reasonCode: "RESOLVED_DECLINED_BY_LOOKUP",
    guards: ["actor-is-service"],
    actions: noAction,
    note: "Same shape, opposite answer.",
  },
  {
    from: "RECONCILING", trigger: "lookup_indeterminate", to: "MANUAL_REVIEW",
    reasonCode: "LOOKUP_INDETERMINATE",
    guards: ["actor-is-service"],
    actions: notifyReviewer,
    note: "Nobody can answer automatically, so the process acquires a human owner rather than a guess.",
  },
  {
    from: "RECONCILING", trigger: "callback_settled", to: "SETTLED",
    reasonCode: "LATE_CALLBACK_ACCEPTED",
    guards: ["actor-is-provider", "callback-token-matches"],
    actions: noAction,
    note: "A callback that arrives after the deadline is late, not invalid.",
  },
  {
    from: "RECONCILING", trigger: "callback_declined", to: "DECLINED",
    reasonCode: "LATE_CALLBACK_ACCEPTED",
    guards: ["actor-is-provider", "callback-token-matches"],
    actions: noAction,
    note: "The same allowance for the opposite answer.",
  },
  {
    from: "MANUAL_REVIEW", trigger: "review_approve", to: "AUTHORIZED",
    reasonCode: "REVIEW_APPROVED",
    guards: ["actor-is-operator", "reviewer-is-not-initiator", "within-reviewer-limit"],
    actions: noAction,
    note: "Back to AUTHORIZED, never straight to a terminal state. Review grants permission to proceed, not an outcome.",
  },
  {
    from: "MANUAL_REVIEW", trigger: "review_reject", to: "CANCELLED",
    reasonCode: "REVIEW_REJECTED",
    guards: ["actor-is-operator", "reviewer-is-not-initiator"],
    actions: noAction,
    note: "Rejection needs the same separation of duty as approval and none of the amount authority.",
  },
  {
    from: "MANUAL_REVIEW", trigger: "cancel", to: "CANCELLED",
    reasonCode: "CANCELLED_IN_REVIEW",
    guards: ["actor-is-service"],
    actions: noAction,
    note: "The requester may still withdraw a payout that has not been submitted.",
  },
];

export const SPEC_V2: Spec = Object.freeze<Spec>({
  version: 2,
  initial: "DRAFT",
  states: ["DRAFT", "AUTHORIZED", "SUBMITTED", "RECONCILING", "MANUAL_REVIEW", "SETTLED", "DECLINED", "CANCELLED"],
  terminal: ["SETTLED", "DECLINED", "CANCELLED"],
  autonomous: ["authorize", "submit", "lookup_settled", "lookup_declined", "lookup_indeterminate"],
  transitions: V2_TRANSITIONS,
  waits: {
    SUBMITTED: {
      owner: "payment-provider",
      deadlineMs: CALLBACK_DEADLINE_MS,
      mechanism: "timer",
      escalatesTo: "RECONCILING",
      note: "The provider owns this wait. Nothing we do shortens it, so the only question is what happens when it ends.",
    },
    MANUAL_REVIEW: {
      owner: "payouts-operations",
      deadlineMs: REVIEW_DEADLINE_MS,
      mechanism: "sweep",
      note: "A human owns this wait. No timer moves it, which is precisely why it needs a deadline somebody is shown.",
    },
  },
  guards: GUARDS,
});

// --- specification version 1 (superseded, still running) --------------------

/**
 * The machine before manual review existed.
 *
 * Version 1 authorized every payout automatically and had nowhere to put an
 * indeterminate lookup, so it declined. That is the change version 2 makes,
 * and it is why an in-flight version 1 entity cannot simply be relabelled: a
 * payout version 1 auto-approved is one version 2 would have sent to a human,
 * and the history already records which machine decided.
 */
const V1_TRANSITIONS: readonly Transition[] = [
  {
    from: "DRAFT", trigger: "authorize", to: "AUTHORIZED",
    reasonCode: "AUTO_APPROVED",
    guards: ["actor-is-service"],
    actions: noAction,
    note: "Version 1 approved every amount. This is the defect version 2 fixes.",
  },
  {
    from: "DRAFT", trigger: "cancel", to: "CANCELLED",
    reasonCode: "CANCELLED_BEFORE_AUTHORIZATION",
    guards: [],
    actions: noAction,
    note: "Unchanged in version 2.",
  },
  {
    from: "AUTHORIZED", trigger: "submit", to: "SUBMITTED",
    reasonCode: "SUBMITTED_TO_PROVIDER",
    guards: ["actor-is-service"],
    actions: callProvider,
    note: "Unchanged in version 2.",
  },
  {
    from: "AUTHORIZED", trigger: "cancel", to: "CANCELLED",
    reasonCode: "CANCELLED_BEFORE_SUBMISSION",
    guards: [],
    actions: noAction,
    note: "Unchanged in version 2.",
  },
  {
    from: "SUBMITTED", trigger: "callback_settled", to: "SETTLED",
    reasonCode: "PROVIDER_CONFIRMED_SETTLEMENT",
    guards: ["actor-is-provider", "callback-token-matches"],
    actions: noAction,
    note: "Unchanged in version 2.",
  },
  {
    from: "SUBMITTED", trigger: "callback_declined", to: "DECLINED",
    reasonCode: "PROVIDER_DECLINED",
    guards: ["actor-is-provider", "callback-token-matches"],
    actions: noAction,
    note: "Unchanged in version 2.",
  },
  {
    from: "SUBMITTED", trigger: "timer_expired", to: "RECONCILING",
    reasonCode: "CALLBACK_DEADLINE_PASSED",
    guards: [],
    actions: lookUpProvider,
    note: "Unchanged in version 2.",
  },
  {
    from: "RECONCILING", trigger: "lookup_settled", to: "SETTLED",
    reasonCode: "RESOLVED_SETTLED_BY_LOOKUP",
    guards: ["actor-is-service"],
    actions: noAction,
    note: "Unchanged in version 2.",
  },
  {
    from: "RECONCILING", trigger: "lookup_declined", to: "DECLINED",
    reasonCode: "RESOLVED_DECLINED_BY_LOOKUP",
    guards: ["actor-is-service"],
    actions: noAction,
    note: "Unchanged in version 2.",
  },
  {
    from: "RECONCILING", trigger: "lookup_indeterminate", to: "DECLINED",
    reasonCode: "LOOKUP_INDETERMINATE_TREATED_AS_DECLINE",
    guards: ["actor-is-service"],
    actions: noAction,
    note: "Version 1 guessed. Recording a guess as a terminal fact is what version 2 stops doing.",
  },
];

export const SPEC_V1: Spec = Object.freeze<Spec>({
  version: 1,
  initial: "DRAFT",
  states: ["DRAFT", "AUTHORIZED", "SUBMITTED", "RECONCILING", "SETTLED", "DECLINED", "CANCELLED"],
  terminal: ["SETTLED", "DECLINED", "CANCELLED"],
  autonomous: ["authorize", "submit", "lookup_settled", "lookup_declined", "lookup_indeterminate"],
  transitions: V1_TRANSITIONS,
  waits: {
    SUBMITTED: {
      owner: "payment-provider",
      deadlineMs: CALLBACK_DEADLINE_MS,
      mechanism: "timer",
      escalatesTo: "RECONCILING",
      note: "Unchanged in version 2.",
    },
  },
  guards: GUARDS,
});

export const SPECS: Readonly<Record<1 | 2, Spec>> = Object.freeze({ 1: SPEC_V1, 2: SPEC_V2 });

/**
 * The standing effects of a state: what must be true the whole time the entity
 * sits there, derived from the state alone.
 *
 * This is the part that makes recovery possible. A worker that inherits a
 * half-finished process does not need to know which transition got the entity
 * here; it asks what this state requires and makes it so. Re-arming is safe
 * because the timer is named and the deadline is computed from the recorded
 * entry time, not from the recovering worker's clock.
 */
export function standingEffects(spec: Spec, payout: Payout): readonly Effect[] {
  const wait = spec.waits[payout.state];
  if (wait === undefined || wait.mechanism !== "timer") return [];
  const enteredAtMs = payout.history[payout.history.length - 1]!.atMs;
  return [{
    kind: "SCHEDULE_TIMER",
    payoutId: payout.id,
    name: CALLBACK_TIMER,
    fireAtMs: enteredAtMs + wait.deadlineMs,
  }];
}

/** Every (from, trigger) pair the spec does not contain. */
export function forbiddenPairs(spec: Spec): readonly { from: State; trigger: Trigger }[] {
  const present = new Set(spec.transitions.map((t) => `${t.from}/${t.trigger}`));
  const triggers: readonly Trigger[] = [
    "authorize", "submit", "cancel", "review_approve", "review_reject",
    "callback_settled", "callback_declined", "timer_expired",
    "lookup_settled", "lookup_declined", "lookup_indeterminate",
  ];
  const out: { from: State; trigger: Trigger }[] = [];
  for (const from of spec.states) {
    for (const trigger of triggers) {
      if (!present.has(`${from}/${trigger}`)) out.push({ from, trigger });
    }
  }
  return out;
}
