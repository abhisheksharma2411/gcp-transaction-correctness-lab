// The vocabulary, as types.
//
// Every noun in this file maps to a row in docs/SCHEMA.sql. Nothing here
// carries a clock: every function that needs an instant takes it as an
// argument, so `make report` produces byte-identical output on re-run.

/** Which side of an account a posting lands on. Not an enum: Node's type
 *  stripping does not support them. */
export type Direction = "DEBIT" | "CREDIT";

/** What an account is for. Determines its normal balance and whether it is
 *  closed at period end. */
export type AccountKind = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

/** A currency code with its minor-unit exponent. JPY has 0, USD has 2. */
export type CurrencyCode = string;

/** An exact amount, held as a signed integer count of minor units.
 *  Never a float. See money.ts and ADR-001. */
export type Minor = bigint;

export type Money = {
  readonly currency: CurrencyCode;
  readonly minor: Minor;
};

export type Account = {
  readonly accountId: string;
  readonly ledgerId: string;
  readonly kind: AccountKind;
  /** An account holds exactly one currency. A multi-currency "account" is
   *  several accounts. */
  readonly currency: CurrencyCode;
  /** Chart-of-accounts path, e.g. "assets/cash/clearing". Hierarchy is a
   *  reporting convenience; postings only ever name a leaf. */
  readonly path: string;
  readonly openedEffectiveAt: string;
  readonly closedEffectiveAt: string | null;
  /** True for accounts that hold authorized-but-not-captured obligations.
   *  Used to derive a pending balance; it is not a different kind of truth. */
  readonly isPending: boolean;
};

/** A posting is one line of a journal. It is written once and never updated.
 *  `postingId` is derived from the journal and the line number, so a
 *  transaction body that runs twice produces the same identity. */
export type Posting = {
  readonly postingId: string;
  readonly journalId: string;
  readonly ledgerId: string;
  readonly lineNumber: number;
  readonly accountId: string;
  readonly direction: Direction;
  readonly amount: Money;
  readonly memo: string;
};

export type JournalStatus = "ACCEPTED" | "REJECTED";

/** A journal is the atomic accounting unit: a set of postings that balance.
 *  Nothing partial is ever accepted. */
export type Journal = {
  readonly journalId: string;
  readonly ledgerId: string;
  /** The caller's idea of what this journal is about. Unique within a ledger.
   *  This is the business reference, and it outlives any de-duplication
   *  window — see Article 12. */
  readonly businessRef: string;
  /** When the economic event happened, as the business sees it. */
  readonly effectiveAt: string;
  /** When the ledger learned of it. Supplied by the caller here; in Spanner
   *  this is the commit timestamp. */
  readonly recordedAt: string;
  readonly description: string;
  /** Set when this journal reverses another. The original is never touched. */
  readonly reversesJournalId: string | null;
  /** Rate actually used, when the journal crosses currencies through the
   *  modelled bridge. Recorded as evidence, not recomputed. */
  readonly fxNote: FxNote | null;
  readonly postings: readonly Posting[];
  /** Content hash of the journal and all its postings. */
  readonly contentHash: string;
  /** Hash of (previous journal's chainHash + this journal's contentHash).
   *  Makes a silent edit detectable without trusting the storage layer. */
  readonly chainHash: string;
};

export type FxNote = {
  readonly fromCurrency: CurrencyCode;
  readonly toCurrency: CurrencyCode;
  /** Rate as an exact ratio, never a float: toMinor = fromMinor * num / den. */
  readonly rateNumerator: bigint;
  readonly rateDenominator: bigint;
  readonly rateSource: string;
};

/** A journal that was offered to the ledger and refused. Rejections are
 *  evidence too, so they are kept — but they produce no postings. */
export type Rejection = {
  readonly code: RejectionCode;
  readonly detail: string;
};

export type RejectionCode =
  | "UNBALANCED"
  | "DUPLICATE_BUSINESS_REF"
  | "UNKNOWN_ACCOUNT"
  | "ACCOUNT_CLOSED"
  | "CURRENCY_MISMATCH"
  | "CROSS_CURRENCY_WITHOUT_BRIDGE"
  | "PERIOD_CLOSED"
  | "EMPTY_JOURNAL"
  | "ZERO_AMOUNT"
  | "FOREIGN_LEDGER"
  | "NOT_AUTHORIZED";

export type PostResult =
  | { readonly status: "ACCEPTED"; readonly journal: Journal }
  | { readonly status: "REJECTED"; readonly rejection: Rejection };

/** What a caller hands the ledger. Note there is no journalId and no
 *  postingId: the ledger derives both, deterministically, from content the
 *  caller already chose. */
export type JournalCommand = {
  readonly ledgerId: string;
  readonly businessRef: string;
  readonly effectiveAt: string;
  readonly description: string;
  readonly lines: readonly LineCommand[];
  readonly fxNote?: FxNote | null;
};

export type LineCommand = {
  readonly accountId: string;
  readonly direction: Direction;
  readonly amount: Money;
  readonly memo: string;
};

/** The four numbers people mean by "balance", kept apart on purpose.
 *  Only `accounting` is derived from the postings that the ledger considers
 *  effective as of `asOf`; the rest are conveniences built from it. */
export type BalanceSet = {
  readonly accountId: string;
  readonly currency: CurrencyCode;
  /** Signed, in the account's natural direction. Sum of effective postings. */
  readonly accounting: Minor;
  /** Every accepted posting the ledger holds, including ones whose effective
   *  date is in the future. */
  readonly current: Minor;
  /** The part of `current` sitting in pending (hold) accounts for this owner. */
  readonly pending: Minor;
  /** current minus pending. A spending decision, not an accounting figure. */
  readonly available: Minor;
  /** Every posting id that contributed to `accounting`. This is what makes a
   *  balance explainable rather than merely correct. */
  readonly evidence: readonly string[];
};

/** One row of a change feed. Models a Spanner change stream data change
 *  record closely enough to make the ordering problem visible: records from
 *  one transaction can be split across partitions. */
export type ChangeRecord = {
  readonly commitTimestamp: string;
  readonly serverTransactionId: string;
  readonly recordSequence: number;
  readonly numberOfRecordsInTransaction: number;
  readonly partition: string;
  readonly table: "Postings";
  readonly modType: "INSERT";
  readonly posting: Posting;
};
