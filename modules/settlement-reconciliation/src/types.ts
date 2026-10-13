/**
 * Vocabulary for settlement and reconciliation.
 *
 * Every term the article defines has a type here, and every type carries the
 * provenance of the thing it describes. Nothing in this module holds a money
 * amount as a floating-point number: amounts are integers in the currency's
 * minor unit, which is how both providers cited in the article express them.
 *
 * No wall clock. Every function that needs a time takes it as a parameter.
 */

export type Currency = 'USD' | 'EUR';

/** What kind of monetary expectation an internal record describes. */
export type Kind = 'CAPTURE' | 'REFUND' | 'CHARGEBACK';

/**
 * One internal expectation: an amount the payment system believes will become
 * provider settlement and, eventually, a bank deposit.
 *
 * `grossMinor` is signed from the merchant's point of view: a capture is
 * positive, a refund and a chargeback are negative. `expectedFeeMinor` is a
 * model parameter, not a published fee schedule — see docs/MODEL.md.
 */
export interface Expectation {
  expectationId: string;
  merchantRef: string;
  /** The provider we expect to settle this. */
  source: string;
  /** What we believe the provider calls this. Empty when we never learned it. */
  providerTxnId: string;
  kind: Kind;
  grossMinor: number;
  expectedFeeMinor: number;
  currency: Currency;
  capturedAt: number;
}

/** A file exactly as it arrived, before anything has been parsed. */
export interface RawFile {
  source: string;
  /** The name the provider gave it. Not an identity: see ADR-001. */
  declaredName: string;
  /** The bytes, as a string. This module never mutates them. */
  bytes: string;
  format: string;
  formatVersion: string;
  receivedAt: number;
  /** Set when the provider says this file replaces an earlier one. */
  corrects?: string;
}

export type IntakeDisposition =
  | 'ACCEPTED'
  | 'DUPLICATE_IGNORED'
  | 'CONTENT_CONFLICT'
  | 'SUPERSEDED'
  | 'REJECTED_UNPARSEABLE';

/** The immutable record of one arrival. Written once; never edited. */
export interface FileRecord {
  fileId: string;
  source: string;
  declaredName: string;
  /** Content identity: SHA-256 over the bytes. */
  digest: string;
  /** Integrity checksum, mirroring the one Cloud Storage recommends. */
  crc32c: string;
  format: string;
  formatVersion: string;
  receivedAt: number;
  byteLength: number;
  disposition: IntakeDisposition;
  /** fileId this one replaces, when the provider declared a correction. */
  supersedes: string | null;
  supersededBy: string | null;
  note: string;
}

/** A provider or bank row after parsing, in canonical form. */
export interface NormalizedRecord {
  recordId: string;
  source: string;
  fileId: string;
  parserVersion: string;
  /** 1-based line within the raw file. With fileId this locates the evidence. */
  line: number;
  providerTxnId: string;
  merchantRef: string;
  kind: Kind;
  grossMinor: number;
  feeMinor: number;
  /** Net as the provider states it, not as we would compute it. */
  netMinor: number;
  currency: Currency;
  eventTime: number;
  batchId: string;
}

/** One line of a bank statement. */
export interface BankEntry {
  entryRef: string;
  fileId: string;
  line: number;
  amountMinor: number;
  currency: Currency;
  valueDate: number;
  /** Free text. The only link between a deposit and a settlement batch. */
  remittance: string;
}

/** A provider's own summary of a settlement batch, before the detail arrives. */
export interface BatchSummary {
  batchId: string;
  source: string;
  fileId: string;
  /** The business day the batch covers, as the provider states it. */
  businessDate: number;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: Currency;
  fundingDate: number;
  payoutRef: string;
}

export type MatchRuleId =
  | 'M1_PROVIDER_TXN_ID'
  | 'M2_REF_AMOUNT_CURRENCY'
  | 'M3_REFUND_ACROSS_DAYS'
  | 'M4_SPLIT_TO_ONE'
  | 'M5_PARTIAL_SETTLEMENT';

export type Outcome =
  | 'MATCHED'
  | 'MATCHED_WITH_ADJUSTMENT'
  | 'PENDING'
  | 'EXCEPTION';

export type ExceptionReason =
  | 'MISSING_PROVIDER_RECORD'
  | 'UNKNOWN_TO_LEDGER'
  | 'PARTIAL_SETTLEMENT'
  | 'FEE_VARIANCE_BEYOND_TOLERANCE'
  | 'CURRENCY_MISMATCH'
  | 'PROVIDER_ARITHMETIC_INCONSISTENT'
  | 'DUPLICATE_PROVIDER_RECORD'
  | 'DEPOSIT_UNEXPLAINED'
  | 'BATCH_NOT_DEPOSITED';

/**
 * One row of the explanation report: why this amount matched, stayed pending,
 * or became an exception. The playbook's stated contribution target.
 */
export interface Explanation {
  /** `exp-...` for an internal expectation, `rec-...` for a provider row. */
  subjectId: string;
  side: 'INTERNAL' | 'PROVIDER' | 'BANK';
  outcome: Outcome;
  rule: MatchRuleId | null;
  reason: ExceptionReason | null;
  /** The amount this row puts into play, in minor units, signed. */
  amountMinor: number;
  currency: Currency;
  /**
   * The amount the rule could not account for, never silently dropped.
   * On an internal row: expected net less settled net. On a provider row: the
   * whole unattributed net. On a bank row: deposit less summarised net.
   */
  residualMinor: number;
  counterpartIds: string[];
  /** Evidence locators: `fileId#line` for every record the decision used. */
  evidence: string[];
  text: string;
}

export type Disposition =
  | 'POST_SETTLEMENT'
  | 'POST_ADJUSTMENT'
  | 'DEFER'
  | 'HOLD';

/**
 * An instruction to the ledger, not a posting. Article 14 owns postings; this
 * module decides whether one is warranted and says why.
 */
export interface PostingInstruction {
  instructionId: string;
  disposition: Disposition;
  subjectId: string;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: Currency;
  /** The gate that permitted (or withheld) the instruction. */
  basis: string;
  evidence: string[];
}

export type CaseState =
  | 'OPEN'
  | 'ASSIGNED'
  | 'PENDING_EVIDENCE'
  | 'RESOLVED'
  | 'WRITTEN_OFF';

export interface ExceptionCase {
  caseId: string;
  reason: ExceptionReason;
  subjectId: string;
  amountMinor: number;
  currency: Currency;
  state: CaseState;
  openedAt: number;
  evidence: string[];
  /** Append-only. A disposition never replaces an earlier one. */
  history: DispositionEntry[];
}

export interface DispositionEntry {
  at: number;
  actor: string;
  action: string;
  note: string;
  /** Digest of the evidence the actor was looking at when they decided. */
  evidenceDigest: string;
}

export interface ToleranceConfig {
  /** Fee variance absorbed without an exception, in minor units. */
  feeToleranceMinor: number;
}

export interface RunConfig {
  tolerance: ToleranceConfig;
  /** Business cutoff. Evidence after this instant is not part of the period. */
  cutoff: number;
  /** Aggregate-only mode: one number for the period. The article's foil. */
  aggregateOnly: boolean;
}
