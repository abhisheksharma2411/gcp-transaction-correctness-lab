// The idempotency contract, as types.
//
// This module is a local, deterministic model. It is not a Google Cloud client
// and reaches no network. Every platform behaviour it models is cited in
// ../docs/MODEL.md against public documentation; where the model simplifies,
// MODEL.md says so.

/**
 * Where a copy of an operation arrived from.
 *
 * The list is the article's subject: six boundaries that can each repeat work,
 * independently, for different reasons. A system that handles one of them is
 * not idempotent; it is lucky.
 */
export type Origin =
  | "api"        // an HTTP client retried
  | "inbox"      // a message was redelivered after a failed acknowledgement
  | "task"       // a queued task retried after a worker timeout
  | "workflow"   // an orchestrator retried a step
  | "provider"   // an external webhook fired twice
  | "replay";    // an operator or a disaster-recovery run replayed it

export const ORIGINS: readonly Origin[] = [
  "api", "inbox", "task", "workflow", "provider", "replay",
];

/**
 * Everything that identifies one logical operation, carried across a boundary.
 *
 * `operationId` must be chosen by whoever first intends the operation and must
 * survive every hop. An ID generated inside a retry loop identifies the
 * attempt, not the operation, and is worth nothing.
 */
export interface OperationContext {
  /** Stable across every representation of this operation. */
  readonly operationId: string;
  /**
   * The business thing being protected — an order, an account, an invoice.
   * Two different operation IDs may still be the same business intent, and
   * that case needs its own answer.
   */
  readonly businessRef: string;
  /** Canonical hash of the request parameters. See fingerprint.ts. */
  readonly fingerprint: string;
  /** Which boundary this copy came through. */
  readonly origin: Origin;
  /** Attempt counter, for reporting only. Never part of identity. */
  readonly attempt: number;
}

/** The five answers a correct implementation can give. */
export type Decision =
  | "FIRST"        // never seen; proceed and record
  | "IN_PROGRESS"  // seen, still running; do not start a second effect
  | "REPLAY"       // seen and finished; return the recorded outcome
  | "CONFLICT"     // same key, different request; refuse
  | "EXPIRED";     // seen, but the record has aged out; see ADR-002

export const DECISIONS: readonly Decision[] = [
  "FIRST", "IN_PROGRESS", "REPLAY", "CONFLICT", "EXPIRED",
];

/** How an operation finished. */
export type Outcome = "SUCCEEDED" | "FAILED_FINAL" | "UNKNOWN";

/** What the store holds for one operation. */
export interface OperationRecord {
  readonly operationId: string;
  readonly businessRef: string;
  readonly fingerprint: string;
  readonly startedAtMs: number;
  /** null while in progress. */
  completedAtMs: number | null;
  outcome: Outcome | null;
  /** The response to replay. Absent while in progress. */
  response: unknown;
  /**
   * Identities of side effects already applied for this operation.
   * An effect is deduplicated on its own identity, not on the operation's,
   * because one operation may cause several distinct effects.
   */
  readonly effectIds: string[];
  /** Every arrival, for the report. */
  readonly arrivals: { origin: Origin; atMs: number; decision: Decision }[];
}

/** A side effect that is externally visible and must not duplicate. */
export interface Effect {
  /** Deterministic: same operation + same effect kind = same id. */
  readonly effectId: string;
  readonly operationId: string;
  readonly kind: string;
  readonly appliedAtMs: number;
}

/**
 * The four numbers the article insists on separating.
 *
 * Counting arrivals and calling it load, or counting attempts and calling it
 * effects, is how a system looks idempotent in a dashboard while charging
 * someone twice.
 */
export interface Tally {
  /** Copies of an operation that arrived, through any boundary. */
  arrivals: number;
  /** Arrivals that got past de-duplication and ran business logic. */
  admitted: number;
  /** Calls made to the external provider, including retries of unknowns. */
  providerAttempts: number;
  /** Externally visible side effects actually applied. The only one that matters. */
  effects: number;
}
