// Shared vocabulary. Nothing here executes; it exists so that the orchestrator,
// the participants and the auditor can disagree in a type-checked way.
//
// Two rules hold throughout this module:
//
//   1. No wall clock. Every function that needs the time takes it as a
//      parameter, so a run is reproducible to the millisecond.
//   2. Nothing shares an identity helper across a boundary that is supposed to
//      be checked. The orchestrator mints a command id; the participant stores
//      the string it received; the auditor counts records. None of the three
//      recomputes what the other produced.

/** One independently transactional service. Each owns its own store. */
export type Participant =
  | "inventory"
  | "payments"
  | "fulfilment"
  | "ledger"
  | "notifications";

export const PARTICIPANTS: readonly Participant[] = [
  "inventory", "payments", "fulfilment", "ledger", "notifications",
];

/** The name of one step in a saga definition. */
export type StepName = string;

/** Where one saga execution is. */
export type SagaState =
  | "RUNNING"
  | "PIVOTED"
  | "COMPLETED"
  | "COMPENSATING"
  | "COMPENSATED"
  | "COMPENSATION_FAILED"
  | "MANUAL_REPAIR"
  | "CLOSED_MANUALLY";

/** What a trigger is called in the transition table. */
export type SagaTrigger =
  | "cancel_requested"
  | "step_failed"
  | "pivot_committed"
  | "forward_complete"
  | "forward_exhausted"
  | "compensations_complete"
  | "compensation_exhausted"
  | "operator_retried"
  | "operator_resumed"
  | "operator_closed";

/**
 * What a participant says when asked to do something.
 *
 * `unknown` is not an answer a participant gives. It is what the orchestrator
 * records when the answer did not arrive, which is a different statement and
 * the one that makes sagas hard. Article 1 owns that argument; this module
 * only has to survive it.
 */
export type Outcome =
  | { readonly kind: "accepted"; readonly effectId: string; readonly duplicate: boolean }
  | { readonly kind: "pending"; readonly callbackToken: string }
  | { readonly kind: "rejected"; readonly code: string; readonly reason: string }
  | { readonly kind: "error"; readonly code: string; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** The command the orchestrator puts on the wire. */
export interface Command {
  readonly sagaId: string;
  readonly step: StepName;
  /**
   * The de-duplication key, as a string. The participant stores exactly this
   * and never reconstructs it. Article 12 owns the contract; here it is one
   * field.
   */
  readonly commandId: string;
  readonly direction: "forward" | "compensate";
  readonly amountMinor: number;
  readonly units: number;
  /** The attempt number, which a participant is allowed to ignore. */
  readonly attempt: number;
}

/**
 * One row in a participant's own effect ledger.
 *
 * This is the evidence the auditor reads. The orchestrator never writes to it
 * and cannot edit it, which is the whole point: a saga that believes it
 * compensated something is checked against the service that would have had to
 * do the compensating.
 */
export interface EffectRecord {
  readonly participant: Participant;
  readonly sagaId: string;
  readonly step: StepName;
  readonly kind: "applied" | "compensated";
  readonly commandId: string;
  readonly atMs: number;
  readonly detail: string;
}

/** One line of a saga's own history. */
export interface SagaEvent {
  readonly seq: number;
  readonly atMs: number;
  readonly kind:
    | "step_dispatched" | "step_accepted" | "step_pending" | "step_rejected"
    | "step_error" | "step_unknown" | "step_resolved"
    | "callback_accepted" | "callback_refused"
    | "compensation_dispatched" | "compensation_accepted" | "compensation_failed"
    | "transition" | "refused" | "operator";
  readonly step: StepName;
  readonly detail: string;
  /** Machine-readable, supplied by the table rather than by the caller. */
  readonly reasonCode: string;
}

/** What the orchestrator persists. Everything else is reconstructible from it. */
export interface SagaRecord {
  readonly id: string;
  /** The definition version this execution is pinned to. */
  readonly specVersion: 1 | 2;
  state: SagaState;
  /** Index into the pinned definition's step list. */
  cursor: number;
  /**
   * Every step whose command left the orchestrator, in dispatch order.
   *
   * This, and not `completed`, is what the compensation chain walks. A step
   * that was sent and never answered may well have happened.
   */
  readonly dispatched: StepName[];
  /** Steps recorded as having produced a durable effect, in completion order. */
  readonly completed: StepName[];
  /** Steps recorded as compensated. */
  readonly compensated: StepName[];
  /** Per-step attempt counts, forward and compensating. */
  readonly attempts: Record<string, number>;
  /** The outstanding callback token for an asynchronous step, if any. */
  callbackToken: string | null;
  callbackStep: StepName | null;
  cancelRequested: boolean;
  readonly amountMinor: number;
  readonly units: number;
  readonly history: SagaEvent[];
}
