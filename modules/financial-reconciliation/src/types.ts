// The reconciliation model, as types.
//
// This module is a local, deterministic model. It is not a Google Cloud client
// and reaches no network. Every platform behaviour it models is cited in
// ../docs/MODEL.md against public documentation; where the model simplifies,
// MODEL.md says so.
//
// Three words that are not synonyms run through every type below:
//
//   delivery   -- one arrival of one message at this system
//   statement  -- one assertion of fact, however many times it was delivered
//   finality   -- the point after which an assertion no longer changes the
//                 accepted financial position without leaving an adjustment
//
// De-duplicating deliveries is transport work. De-duplicating statements is
// data work. Deciding finality is a business decision, and nothing in the
// transport can make it for you.

/** Who told us. */
export type SourceId = "checkout" | "gateway" | "processor";

export const SOURCES: readonly SourceId[] = ["checkout", "gateway", "processor"];

/** What a source is asserting happened. */
export type ClaimKind =
  | "AUTHORIZED" // funds reserved
  | "CAPTURED"   // funds taken
  | "SETTLED"    // the processor says it moved net funds, after fees
  | "REVERSED";  // the capture was undone

export const CLAIM_KINDS: readonly ClaimKind[] = [
  "AUTHORIZED", "CAPTURED", "SETTLED", "REVERSED",
];

/**
 * One delivery, exactly as it arrived, before anything has been decided.
 *
 * `sourceEventId` is the source's identity for this *delivery*. Pub/Sub calls
 * it a message ID; a payment provider calls it an event ID. It is not an
 * identity for the fact being asserted, and the distinction is the subject of
 * this module.
 */
export interface RawRecord {
  readonly sourceEventId: string;
  readonly source: SourceId;
  /** Processing time: when this system saw it. */
  readonly receivedAtMs: number;
  /** The body, verbatim. Never edited, never normalised in place. */
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * A reference as one source spells it.
 *
 * The gateway says `txn-88`; the processor says `pi_88`. Both describe one
 * business transaction and neither knows the other's spelling.
 */
export interface SourceRef {
  readonly source: SourceId;
  readonly ref: string;
}

/**
 * A normalised assertion of fact.
 *
 * `evidenceId` is derived from the content of the assertion and nothing else --
 * not from the delivery, not from the arrival time. Two deliveries carrying
 * different `sourceEventId`s and the same assertion produce one `evidenceId`.
 */
export interface Observation {
  readonly evidenceId: string;
  readonly sourceEventId: string;
  readonly source: SourceId;
  readonly ref: string;
  /** Other references this record carries, which correlate sources. */
  readonly alsoKnownAs: readonly SourceRef[];
  readonly kind: ClaimKind;
  /** Minor units. Gross is what the customer was charged. */
  readonly grossMinor: number;
  /** Minor units. The processor's deduction. Zero unless the kind is SETTLED. */
  readonly feeMinor: number;
  /** Minor units. What actually moves. Gross minus fee for a settlement. */
  readonly netMinor: number;
  readonly currency: string;
  /** Event time: when the source says it happened. */
  readonly occurredAtMs: number;
  readonly receivedAtMs: number;
  /**
   * The evidence this record corrects, if any.
   *
   * Nacha's reversal rules require a correcting entry to carry the same
   * company id, SEC code and amount as the entry it corrects. The same shape
   * applies here: a correction is a new, additional record that points at what
   * it corrects, never an edit of the original.
   */
  readonly corrects: string | null;
  /**
   * Settlement records sometimes cover several transactions at once. When they
   * do, this is the allocation the source published.
   */
  readonly coversRefs: readonly string[];
}

/** The accounts this model posts to. Article 14 owns real chart design. */
export type Account =
  | "clearing"
  | "merchant_receivable"
  | "fee_expense"
  | "settled_cash"
  | "suspense";

export const ACCOUNTS: readonly Account[] = [
  "clearing", "merchant_receivable", "fee_expense", "settled_cash", "suspense",
];

/** A signed movement. Debits positive, credits negative, by convention here. */
export interface Posting {
  readonly account: Account;
  readonly amountMinor: number;
}

/**
 * An accepted financial effect.
 *
 * `entryId` is deterministic in the evidence and the purpose, which is what
 * makes replay safe: re-deriving an entry from the same evidence produces the
 * same id, and the ledger refuses the second one.
 */
export interface JournalEntry {
  readonly entryId: string;
  readonly transactionId: string;
  /** Every entry names the evidence it came from. This is the audit path. */
  readonly evidenceId: string;
  readonly purpose: string;
  readonly occurredAtMs: number;
  readonly currency: string;
  readonly postings: readonly Posting[];
}

/** Where a reconciliation case has got to. */
export type CaseState =
  | "OPEN"       // evidence is arriving
  | "MATCHED"    // every source agrees and the money is accounted for
  | "UNMATCHED"  // something expected has not arrived
  | "EXCEPTION"  // the sources disagree, or an operator must decide
  | "RESOLVED";  // an operator decided, and the decision is recorded

export const CASE_STATES: readonly CaseState[] = [
  "OPEN", "MATCHED", "UNMATCHED", "EXCEPTION", "RESOLVED",
];

/**
 * Whether the accepted position is still open to revision.
 *
 * This is the distinction the module exists to make. A stream can tell you a
 * message was delivered once. It cannot tell you that nobody will contradict
 * it tomorrow.
 */
export type Finality = "PROVISIONAL" | "FINAL";

/** Why a case needs a human, or needs waiting on. */
export type ExceptionReason =
  | "CONTRADICTORY_SOURCES"      // two sources, one transaction, different money
  | "FEE_UNEXPLAINED"            // net and gross do not differ by the stated fee
  | "MISSING_SETTLEMENT"         // captured, never settled
  | "LATE_BEYOND_WINDOW"         // evidence arrived after the pipeline's window
  | "CORRECTION_AFTER_FINALITY"  // the position was final; this still changed it
  | "INVALID_CORRECTION"         // a correction whose key fields do not match
  | "UNALLOCATED_GROUPING"       // a grouped settlement that does not add up
  | "RAW_IMMUTABLE_CONFLICT"     // the same delivery id arrived with a new body
  | "MALFORMED_RECORD";          // it did not normalise

export const EXCEPTION_REASONS: readonly ExceptionReason[] = [
  "CONTRADICTORY_SOURCES", "FEE_UNEXPLAINED", "MISSING_SETTLEMENT",
  "LATE_BEYOND_WINDOW", "CORRECTION_AFTER_FINALITY", "INVALID_CORRECTION",
  "UNALLOCATED_GROUPING", "RAW_IMMUTABLE_CONFLICT", "MALFORMED_RECORD",
];

export interface ExceptionItem {
  readonly reason: ExceptionReason;
  readonly transactionId: string;
  readonly evidenceId: string | null;
  readonly detail: string;
  readonly raisedAtMs: number;
}

/**
 * One operator decision, kept forever.
 *
 * Resolutions are versioned rather than overwritten, because "who decided this
 * and on what evidence" is the question an auditor asks, and the answer is
 * destroyed by an UPDATE.
 */
export interface Resolution {
  readonly version: number;
  readonly transactionId: string;
  readonly actor: string;
  readonly action: "ACCEPT_AS_IS" | "WRITE_OFF" | "AWAIT_EVIDENCE" | "REOPEN";
  readonly note: string;
  readonly decidedAtMs: number;
  /** The evidence set the operator was looking at. */
  readonly evidenceSeen: readonly string[];
}

export interface ReconCase {
  readonly transactionId: string;
  state: CaseState;
  finality: Finality;
  /** Accepted evidence, in arrival order. */
  readonly evidence: string[];
  readonly refs: SourceRef[];
  currency: string;
  /** What the capture side says was charged. */
  capturedMinor: number | null;
  /** What the settlement side says moved, and what it kept. */
  settledNetMinor: number | null;
  settledFeeMinor: number | null;
  reversedMinor: number | null;
  /** Latest event time accepted, which is what the finality clock runs from. */
  lastEventAtMs: number;
  readonly exceptions: ExceptionItem[];
  readonly resolutions: Resolution[];
  /**
   * Transaction ids this case absorbed when a later record correlated two
   * references that had until then looked like two transactions.
   *
   * Entries posted before the correlation still carry the old id. That is a
   * real limitation, documented in docs/MODEL.md, and this field is how the
   * audit path stays navigable in spite of it.
   */
  readonly mergedFrom: string[];
}

/**
 * The numbers this module refuses to conflate.
 *
 * `deliveries` is transport volume. `statements` is how much was actually
 * asserted. `entries` is how much the business accepted. A dashboard that
 * reports only the first is compatible with every failure in this module.
 */
export interface Tally {
  deliveries: number;
  duplicateDeliveries: number;
  statements: number;
  duplicateStatements: number;
  droppedLate: number;
  entries: number;
  /** How many times the pipeline did the derivation work. Replay raises this. */
  computations: number;
}

export function emptyTally(): Tally {
  return {
    deliveries: 0,
    duplicateDeliveries: 0,
    statements: 0,
    duplicateStatements: 0,
    droppedLate: 0,
    entries: 0,
    computations: 0,
  };
}
