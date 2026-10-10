// Shared vocabulary for the dispute deadline and evidence module.
//
// Determinism rule for this module: nothing in src/ reads a clock, a random
// source, an environment variable or the host time-zone database. Every
// function that needs the time takes it as an argument, and every function
// that needs calendar rules takes them as data. `make report` is therefore
// byte-identical on re-run and on another machine.
//
// Node's type stripping does not support parameter properties or enums, so
// every type here is a plain interface or a string-literal union.

/** Milliseconds since the Unix epoch. Always UTC, never a local wall time. */
export type Instant = number;

/** An IANA-style zone identifier, resolved against a pinned table, not the host. */
export type ZoneId = string;

/** Minor units of a single currency. No floats anywhere near money. */
export type Minor = number;

// ---------------------------------------------------------------------------
// Case identity and state
// ---------------------------------------------------------------------------

/**
 * The states a dispute case can occupy. Article 13 owns the general design of
 * durable state machines; this module applies it to one process whose
 * transitions are driven by a clock somebody else controls.
 */
export type CaseState =
  | 'OPENED'
  | 'COLLECTING_EVIDENCE'
  | 'AWAITING_APPROVAL'
  | 'SUBMITTED'
  | 'SUBMISSION_UNKNOWN'
  | 'ACKNOWLEDGED'
  | 'DECIDED_IN_OUR_FAVOUR'
  | 'DECIDED_AGAINST_US'
  | 'CONCEDED'
  | 'RESPONSE_NOT_PERMITTED'
  | 'EXPIRED_UNANSWERED';

export const TERMINAL_STATES: readonly CaseState[] = [
  'DECIDED_IN_OUR_FAVOUR',
  'DECIDED_AGAINST_US',
  'CONCEDED',
  'RESPONSE_NOT_PERMITTED',
  'EXPIRED_UNANSWERED',
];

/** A notification as it arrives from a provider, before we have interpreted it. */
export interface ProviderNotification {
  /** Provider's own identifier for the dispute. Stable across redeliveries. */
  providerCaseId: string;
  /** Provider's identifier for the notification delivery, which is not stable. */
  deliveryId: string;
  /** The payment this dispute attaches to, in our namespace. */
  paymentRef: string;
  amountMinor: Minor;
  currency: string;
  /** The provider's reason label, carried as an opaque string. */
  reasonCode: string;
  /** When the provider says the dispute was raised. */
  raisedAt: Instant;
  /**
   * The provider's own deadline, in seconds since the epoch, exactly as the
   * field arrives. `0` and `null` are distinct and neither is a date.
   */
  dueBySeconds: number | null;
  /** When this copy of the notification reached us. */
  receivedAt: Instant;
}

// ---------------------------------------------------------------------------
// Deadline rules
// ---------------------------------------------------------------------------

/**
 * A versioned rule set. Every deadline records the version that produced it,
 * so a rule change after case creation never silently rewrites a live case.
 */
export interface RuleSet {
  version: string;
  /** Human-readable note recorded in the audit trail. */
  description: string;
  /**
   * Fallback window used only when the provider supplies no deadline. Expressed
   * in business days against a named calendar, because that is how contractual
   * windows are usually written.
   */
  fallbackBusinessDays: number;
  /** The exact calendar version, which carries the zone and the holidays. */
  calendarVersion: string;
  /** End-of-day cutoff in the calendar's zone, as minutes past local midnight. */
  cutoffLocalMinutes: number;
  /**
   * How far before the deadline the system treats the case as due. This is the
   * number the operations team actually works to.
   */
  safetyMarginMinutes: number;
}

/** Why a case has the deadline it has. Recorded, not recomputed. */
export type DeadlineBasis =
  | 'PROVIDER_SUPPLIED'
  | 'DERIVED_FROM_RULES'
  | 'NO_RESPONSE_PERMITTED';

export interface DeadlineDecision {
  basis: DeadlineBasis;
  ruleVersion: string;
  calendarVersion: string;
  zoneTableVersion: string;
  /** Absent when no response is permitted. */
  deadline: Instant | null;
  /** Deadline minus the safety margin. Absent for the same reason. */
  internalTarget: Instant | null;
  /** Every step taken, in order, for the audit trail and for the diagram. */
  trace: string[];
}

// ---------------------------------------------------------------------------
// Calendars and zones
// ---------------------------------------------------------------------------

/** A pinned UTC-offset transition. See docs/MODEL.md for why these are data. */
export interface ZoneTransition {
  /** The instant at which the new offset takes effect. */
  from: Instant;
  /** Offset in minutes to add to UTC to get local time. */
  offsetMinutes: number;
  abbreviation: string;
}

export interface ZoneTable {
  version: string;
  zones: Record<ZoneId, ZoneTransition[]>;
}

export interface BusinessCalendar {
  version: string;
  calendarId: string;
  zone: ZoneId;
  /** 0 = Sunday through 6 = Saturday. Days on which no work happens. */
  weekend: number[];
  /** Local dates, `YYYY-MM-DD`, on which no work happens. */
  holidays: string[];
}

// ---------------------------------------------------------------------------
// Evidence and packets
// ---------------------------------------------------------------------------

export type Classification = 'PUBLIC' | 'INTERNAL' | 'CUSTOMER_PII' | 'CARDHOLDER';

export interface EvidenceItem {
  itemId: string;
  caseId: string;
  kind: string;
  /** Digest of the stored bytes. The bytes themselves never enter this module. */
  contentHash: string;
  capturedAt: Instant;
  sourceSystem: string;
  classification: Classification;
  /** Which redaction profile was applied before storage, or `NONE`. */
  redactionProfile: string;
  /** How the item was produced. Assistance is never authority. */
  origin: 'HUMAN_UPLOAD' | 'SYSTEM_EXPORT' | 'MODEL_SUGGESTED';
}

export interface PacketEntry {
  itemId: string;
  contentHash: string;
}

/**
 * An approved, immutable submission packet. Replacing any item produces a new
 * packet version; the previous version is never edited.
 */
export interface Packet {
  packetId: string;
  caseId: string;
  version: number;
  entries: PacketEntry[];
  manifestHash: string;
  ruleVersion: string;
  deadlineBasis: DeadlineBasis;
  deadline: Instant | null;
  approvedBy: string;
  approvedAt: Instant;
  approvalReason: string;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export type SubmissionOutcome =
  | 'ACCEPTED'
  | 'ACCEPTED_LATE_DELIVERY_NOT_GUARANTEED'
  | 'REJECTED_VALIDATION'
  | 'REJECTED_NOT_PERMITTED'
  | 'REJECTED_ALREADY_SUBMITTED'
  | 'UNKNOWN_TIMEOUT';

export interface SubmissionAttempt {
  attemptId: string;
  caseId: string;
  packetId: string;
  manifestHash: string;
  sentAt: Instant;
  outcome: SubmissionOutcome;
  /** Provider's acknowledgement identifier, when one came back. */
  providerAckId: string | null;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  seq: number;
  caseId: string;
  at: Instant;
  actor: string;
  actorKind: 'SYSTEM' | 'HUMAN' | 'PROVIDER';
  event: string;
  reason: string;
  ruleVersion: string;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type AdjustmentKind =
  | 'PROVISIONAL_DEBIT'
  | 'PROVISIONAL_DEBIT_REVERSED'
  | 'DISPUTE_FEE'
  | 'LOSS_CONFIRMED';

/**
 * An adjustment *event*, not a ledger posting. Article 14 owns postings and
 * balances; Article 19 owns settlement. This module states what happened and
 * leaves the accounting decision to the system that owns it.
 */
export interface AdjustmentEvent {
  eventId: string;
  caseId: string;
  kind: AdjustmentKind;
  amountMinor: Minor;
  currency: string;
  occurredAt: Instant;
  basis: string;
}
