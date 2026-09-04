/**
 * Domain types for the retry-safe command API.
 *
 * Vocabulary note: these names are shared across the portfolio glossary.
 * "Operation" is the logical business intent. "Effect" is the externally
 * visible monetary consequence of that intent at the provider.
 */

/** Durable states of one payment operation. */
export const OperationState = {
  /**
   * The operation is durably recorded and this worker holds the right to call
   * the provider.
   *
   * There is deliberately no separate RECEIVED state. Recording the command
   * and claiming the right to execute it happen in one transaction, so a
   * record can never exist without an owner. A RECEIVED state would create
   * exactly that window.
   */
  IN_PROGRESS: "IN_PROGRESS",
  /** The provider confirmed a money-moving effect. Terminal. */
  SUCCEEDED: "SUCCEEDED",
  /** The provider definitively refused. No effect exists. Terminal. */
  FAILED_FINAL: "FAILED_FINAL",
  /** The provider may or may not have applied an effect. Not terminal. */
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  /** A reconciliation attempt is resolving an unknown outcome. */
  RECONCILING: "RECONCILING",
  /**
   * Reconciliation exhausted its budget without the provider confirming or
   * denying an effect. Deliberately not terminal: it is an open financial
   * question that a human must close, and it must stay visible.
   */
  MANUAL_REVIEW: "MANUAL_REVIEW",
} as const;

export type OperationState = (typeof OperationState)[keyof typeof OperationState];

export const TERMINAL_STATES: readonly OperationState[] = [
  OperationState.SUCCEEDED,
  OperationState.FAILED_FINAL,
];

export function isTerminal(state: OperationState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Operation kinds that carry their own independent identity. */
export const OperationType = {
  CHARGE: "CHARGE",
  REFUND: "REFUND",
} as const;
export type OperationType = (typeof OperationType)[keyof typeof OperationType];

/**
 * A command as submitted by a caller.
 *
 * `operationId` must be stable across every retry of the same business intent.
 * A caller that mints a fresh id per retry defeats the entire design; the
 * conformance tests include that case explicitly.
 */
export interface PaymentCommand {
  operationId: string;
  operationType: OperationType;
  /** Protected business identity, e.g. an order id. Unique per operation type. */
  businessReference: string;
  amountMinor: number;
  currency: string;
  /** Free-form, not part of the protected fingerprint. */
  metadata?: Record<string, string>;
}

/** The durable operation-ledger row. This is the source of truth for the API. */
export interface OperationRecord {
  operationId: string;
  operationType: OperationType;
  businessReference: string;
  requestFingerprint: string;
  amountMinor: number;
  currency: string;
  state: OperationState;
  /** Deterministic key sent to the provider. Derived, never random. */
  providerOperationKey: string;
  providerEffectId: string | null;
  failureCode: string | null;
  /** Stored so a duplicate can be answered without re-executing anything. */
  responseSnapshot: CommandResult | null;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** Retention boundary for the operation identity. */
  expiresAtMs: number;
  /** How many reconciliation attempts have been spent on an unknown outcome. */
  reconcileAttempts: number;
}

export const ResultStatus = {
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  PENDING_UNKNOWN: "PENDING_UNKNOWN",
  IN_PROGRESS_ELSEWHERE: "IN_PROGRESS_ELSEWHERE",
  PARAMETER_MISMATCH: "PARAMETER_MISMATCH",
  BUSINESS_REFERENCE_CONFLICT: "BUSINESS_REFERENCE_CONFLICT",
  IDENTITY_EXPIRED: "IDENTITY_EXPIRED",
  NEEDS_MANUAL_REVIEW: "NEEDS_MANUAL_REVIEW",
} as const;
export type ResultStatus = (typeof ResultStatus)[keyof typeof ResultStatus];

export interface CommandResult {
  status: ResultStatus;
  operationId: string;
  state: OperationState;
  /** HTTP status an edge layer would map this to. */
  httpStatus: number;
  providerEffectId?: string | null;
  failureCode?: string | null;
  /** True when this response was served from the durable snapshot, not re-executed. */
  replayed: boolean;
}

/** A row written in the same transaction as the state change it describes. */
export interface OutboxRecord {
  outboxId: string;
  operationId: string;
  eventType: string;
  /** Identity of the business effect this event reports. Consumers dedupe on it. */
  effectId: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
  publishedAtMs: number | null;
}

/** Downstream accounting effect. One row per effectId, ever. */
export interface LedgerEntry {
  effectId: string;
  operationId: string;
  businessReference: string;
  amountMinor: number;
  currency: string;
  direction: "DEBIT" | "CREDIT";
  postedAtMs: number;
}
