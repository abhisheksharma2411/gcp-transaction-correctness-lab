// The durable state machine, as types.
//
// This module is a local, deterministic model. It is not a Google Cloud client
// and reaches no network. Every platform behaviour it models is cited in
// ../docs/MODEL.md against public documentation; where the model simplifies,
// MODEL.md says so.
//
// One business entity -- a payout -- moving through a lifecycle that spans
// restarts, deployments, a provider callback, a timer, and a human. Several
// *independently transactional participants* and their compensations are a
// different subject and belong to the saga article; nothing here coordinates
// more than one entity.

/** A state the payout can be in. Strings, because they are persisted. */
export type State =
  | "DRAFT"           // created; nothing has been promised to anyone
  | "AUTHORIZED"      // internally approved; no external effect yet
  | "SUBMITTED"       // handed to the provider; waiting on a callback
  | "RECONCILING"     // the callback deadline passed; we are asking the provider
  | "MANUAL_REVIEW"   // waiting on a human, with an owner and a deadline
  | "SETTLED"         // terminal: money moved
  | "DECLINED"        // terminal: the provider refused
  | "CANCELLED";      // terminal: stopped before any external effect

export const TERMINAL_STATES: readonly State[] = ["SETTLED", "DECLINED", "CANCELLED"];

/**
 * Something that asks the machine to move.
 *
 * A command is an intention; an event is a fact that already happened
 * elsewhere. The transition table treats them identically because both are
 * inputs, but the distinction matters at the edges: a command may be refused,
 * and refusing an event only means you have nowhere to put it.
 */
export type Trigger =
  // commands -- someone is asking
  | "authorize"
  | "submit"
  | "cancel"
  | "review_approve"
  | "review_reject"
  // events -- something has already happened
  | "callback_settled"
  | "callback_declined"
  | "timer_expired"
  | "lookup_settled"
  | "lookup_declined"
  | "lookup_indeterminate";

export const COMMANDS: readonly Trigger[] = [
  "authorize", "submit", "cancel", "review_approve", "review_reject",
];

/** Who or what is asking, and why. Recorded on every accepted transition. */
export interface Actor {
  /** A stable identifier. Synthetic throughout this module. */
  readonly id: string;
  /** `service` for automation, `operator` for a human, `provider` for a callback. */
  readonly kind: "service" | "operator" | "provider";
  /** What an operator is permitted to approve, in minor units. 0 for non-operators. */
  readonly approvalLimitMinor: number;
}

/** The input to one attempted transition. */
export interface Input {
  readonly trigger: Trigger;
  readonly actor: Actor;
  /** Ties this attempt to the arrival that caused it. Carried into history. */
  readonly correlationId: string;
  /**
   * The entity version the caller believes it is acting on.
   *
   * This is the optimistic-concurrency check. A caller that read version 4 and
   * submits against version 4 wins; the second caller that also read 4 is
   * refused rather than silently overwriting. See ADR-002.
   */
  readonly expectedVersion: number;
  /** Required for callbacks. Correlates the arrival to one submission. */
  readonly callbackToken?: string;
  /** Free-form, small, and part of the recorded history. */
  readonly reason?: string;
}

/** One durable payout. The authoritative record of where the process is. */
export interface Payout {
  readonly id: string;
  readonly state: State;
  /** Increments on every accepted transition. Never reused. */
  readonly version: number;
  /** Which specification version this entity is being run under. */
  readonly specVersion: 1 | 2;
  readonly amountMinor: number;
  readonly currency: string;
  /** Who created it. Used by the four-eyes guard. */
  readonly initiatorId: string;
  /**
   * Minted when the payout is submitted; the only token the provider may use.
   * Null in every state where no submission is outstanding.
   */
  readonly callbackToken: string | null;
  /** Non-null exactly while a worker holds the right to advance this entity. */
  readonly lease: Lease | null;
  /** Append-only. Index 0 is the creation record. */
  readonly history: readonly TransitionRecord[];
}

/**
 * The right to advance one entity, held by one worker, until a deadline.
 *
 * Not a database lock. Spanner's documentation is explicit that a lock is tied
 * to a transaction and that the service "might release the transaction's locks
 * and abort the transaction" when a client goes quiet. A business process that
 * waits on a provider for an hour cannot hold a transaction open for an hour,
 * so the lease has to be a row, not a lock.
 */
export interface Lease {
  readonly ownerId: string;
  readonly expiresAtMs: number;
  /** The transition index at which the lease was taken. For auditing only. */
  readonly takenAtSeq: number;
}

/** One entry in the append-only transition history. */
export interface TransitionRecord {
  /**
   * Monotonic within the entity, assigned by the machine.
   *
   * Not a commit timestamp. Spanner's own documentation says commit timestamp
   * "values are not guaranteed to be unique", so an ordering that depends on
   * them alone can tie. The sequence number is the ordering; the timestamp is
   * evidence about when.
   */
  readonly seq: number;
  readonly from: State;
  readonly to: State;
  readonly trigger: Trigger;
  readonly actorId: string;
  readonly actorKind: Actor["kind"];
  /** Machine-readable. The transition table supplies it; callers cannot. */
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly atMs: number;
  /** Which specification version decided this transition. */
  readonly specVersion: 1 | 2;
}

/** What the machine says about an attempted transition. */
export type Outcome =
  | { readonly kind: "ACCEPTED"; readonly payout: Payout; readonly record: TransitionRecord; readonly effects: readonly Effect[] }
  | { readonly kind: "REFUSED"; readonly reasonCode: RefusalCode; readonly detail: string };

export type RefusalCode =
  | "NO_SUCH_TRANSITION"    // the (state, trigger) pair is not in the table
  | "GUARD_FAILED"          // the pair exists; the guard said no
  | "TERMINAL"              // the entity is finished and may not reopen
  | "VERSION_CONFLICT"      // someone else moved it first
  | "LEASE_NOT_HELD"        // this worker does not hold the right to advance it
  | "CALLBACK_UNCORRELATED"; // wrong or stale callback token

export const REFUSAL_CODES: readonly RefusalCode[] = [
  "NO_SUCH_TRANSITION", "GUARD_FAILED", "TERMINAL", "VERSION_CONFLICT",
  "LEASE_NOT_HELD", "CALLBACK_UNCORRELATED",
];

/**
 * Something the transition asks the outside world to do.
 *
 * Effects are returned, never performed, by the machine. That is what makes
 * the machine a pure function of (entity, input, clock) and what makes the
 * crash tests possible: the test decides whether the effect was applied.
 */
export type Effect =
  | { readonly kind: "CALL_PROVIDER"; readonly payoutId: string; readonly callbackToken: string }
  | { readonly kind: "SCHEDULE_TIMER"; readonly payoutId: string; readonly name: string; readonly fireAtMs: number }
  | { readonly kind: "CANCEL_TIMER"; readonly payoutId: string; readonly name: string }
  | { readonly kind: "LOOKUP_PROVIDER"; readonly payoutId: string; readonly callbackToken: string }
  | { readonly kind: "NOTIFY_REVIEWER"; readonly payoutId: string };
