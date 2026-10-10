// The ledger.
//
// Journals are accepted or refused whole. Postings are written once. A
// correction is a new journal, never an edit, and the only thing that makes
// that stick is that the writer role has no UPDATE and no DELETE privilege on
// the Postings table.

import { chain, contentHashOf, digest, genesisOf } from "./hash.ts";
import { deriveJournalId, validate } from "./journal.ts";
import { signedMinor } from "./money.ts";
import {
  appendOnlyRole,
  SpannerModel,
  type Principal,
  type RunOptions,
} from "./spanner.ts";
import type {
  Account,
  ChangeRecord,
  Journal,
  JournalCommand,
  Minor,
  PostResult,
  Posting,
} from "./types.ts";

export type PostOptions = {
  readonly tick: number;
  readonly abortsBeforeCommit?: number;
  readonly principal?: Principal;
};

export type LedgerConfig = {
  readonly ledgerId: string;
  /** Accounts through which a cross-currency journal is permitted to pass. */
  readonly bridgeAccountIds?: readonly string[];
};

export class Ledger {
  readonly ledgerId: string;
  readonly db: SpannerModel;
  readonly writer: Principal;

  private readonly accounts = new Map<string, Account>();
  private readonly bridgeAccountIds: Set<string>;
  private readonly acceptedRefs = new Set<string>();
  private readonly rejections: { command: JournalCommand; code: string; detail: string }[] = [];
  private closedThrough: string | null = null;
  private lastTick = 0;

  constructor(db: SpannerModel, config: LedgerConfig) {
    this.db = db;
    this.ledgerId = config.ledgerId;
    this.bridgeAccountIds = new Set(config.bridgeAccountIds ?? []);
    this.writer = { kind: "FGAC", id: "ledger-service", role: appendOnlyRole() };
    // The stream watches the Postings table. It therefore reports writes the
    // application layer did not make, which is the behaviour that makes a
    // change stream useful as evidence and useless as an access control.
    this.db.watchTable("Postings", (_table, key) => this.partitionFor(key));
  }

  /** Which change stream partition a posting key lands on. Derived from the
   *  account, so the postings of one journal are spread across partitions —
   *  exactly the case the Spanner documentation illustrates with a transfer
   *  between two accounts. */
  private partitionFor(key: string): string {
    const parts = key.split("/");
    const accountId = parts[1] ?? key;
    return `p${(Number.parseInt(digest(accountId).slice(0, 4), 16) % 4) + 1}`;
  }

  openAccount(account: Account): void {
    if (account.ledgerId !== this.ledgerId) {
      throw new Error(`${account.accountId} belongs to ${account.ledgerId}`);
    }
    this.accounts.set(account.accountId, account);
  }

  account(accountId: string): Account | undefined {
    return this.accounts.get(accountId);
  }

  allAccounts(): readonly Account[] {
    return [...this.accounts.values()].sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
  }

  /** Close a period. Backdated journals on or before this date are refused;
   *  the correction route is an adjustment with a current effective date. */
  closePeriodThrough(date: string): void {
    this.closedThrough = date;
  }

  closedPeriodThrough(): string | null {
    return this.closedThrough;
  }

  journal(journalId: string): Journal | null {
    const row = this.db.rowAt("Journals", `${this.ledgerId}/${journalId}`);
    return row === null ? null : (row as unknown as Journal);
  }

  /** Every journal in the database, ordered by recorded time and then by id.
   *
   * Read from storage rather than from an in-memory list on purpose: a check
   * that trusts the writer's own bookkeeping cannot detect a row that arrived
   * some other way. The tie-break on id matters because two journals that
   * touch non-overlapping accounts can share a commit timestamp.
   */
  allJournals(): readonly Journal[] {
    return this.db
      .rowsWithPrefix("Journals", `${this.ledgerId}/`)
      .map((row) => row as unknown as Journal)
      .sort((a, b) =>
        a.recordedAt === b.recordedAt
          ? a.journalId < b.journalId
            ? -1
            : 1
          : a.recordedAt < b.recordedAt
            ? -1
            : 1,
      );
  }

  /** The head of the hash chain, recomputed from stored journals. */
  chainHead(): string {
    let link = genesisOf(this.ledgerId);
    for (const journal of this.allJournals()) link = chain(link, journal.contentHash);
    return link;
  }

  allPostings(): readonly Posting[] {
    return this.db
      .rowsWithPrefix("Postings", `${this.ledgerId}/`)
      .map((row) => row as unknown as Posting);
  }

  postingsForAccount(accountId: string): readonly Posting[] {
    return this.allPostings().filter((p) => p.accountId === accountId);
  }

  /** The change stream, as a ledger consumer sees it. */
  feed(): readonly ChangeRecord[] {
    return this.db
      .changeStream()
      .filter((r) => r.table === "Postings" && r.modType === "INSERT" && r.row !== null)
      .map((r) => ({
        commitTimestamp: r.commitTimestamp,
        serverTransactionId: r.serverTransactionId,
        recordSequence: r.recordSequence,
        numberOfRecordsInTransaction: r.numberOfRecordsInTransaction,
        partition: r.partition,
        table: "Postings" as const,
        modType: "INSERT" as const,
        posting: r.row as unknown as Posting,
      }));
  }

  rejectionLog(): readonly { command: JournalCommand; code: string; detail: string }[] {
    return this.rejections;
  }

  /**
   * Post a journal.
   *
   * Everything that decides whether the journal is acceptable happens inside
   * the transaction body, and the body is a pure function of its inputs. That
   * matters because the body can run more than once: the id it derives, the
   * postings it builds and the hash it computes must be identical on every
   * attempt, or a retry silently writes a second journal.
   */
  post(command: JournalCommand, options: PostOptions): PostResult {
    const validation = validate({
      command,
      accounts: this.accounts,
      usedBusinessRefs: this.acceptedRefs,
      closedThrough: this.closedThrough,
      bridgeAccountIds: this.bridgeAccountIds,
    });

    if (!validation.ok) {
      this.rejections.push({
        command,
        code: validation.rejection.code,
        detail: validation.rejection.detail,
      });
      return { status: "REJECTED", rejection: validation.rejection };
    }

    return this.commitJournal(command, validation.postings, validation.journalId, null, options);
  }

  /**
   * Reverse an accepted journal with a linked journal that mirrors every
   * posting. The original is untouched, which is the whole point: the history
   * says that something was posted and then reversed, not that it never
   * happened.
   */
  reverse(
    journalId: string,
    reversal: { businessRef: string; effectiveAt: string; reason: string },
    options: PostOptions,
  ): PostResult {
    const original = this.journal(journalId);
    if (original === null) {
      return {
        status: "REJECTED",
        rejection: { code: "UNKNOWN_ACCOUNT", detail: `no journal ${journalId}` },
      };
    }

    const command: JournalCommand = {
      ledgerId: this.ledgerId,
      businessRef: reversal.businessRef,
      effectiveAt: reversal.effectiveAt,
      description: `Reversal of ${journalId}: ${reversal.reason}`,
      lines: original.postings.map((p) => ({
        accountId: p.accountId,
        direction: p.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
        amount: p.amount,
        memo: `reverses ${p.postingId}`,
      })),
      fxNote: original.fxNote,
    };

    const validation = validate({
      command,
      accounts: this.accounts,
      usedBusinessRefs: this.acceptedRefs,
      closedThrough: this.closedThrough,
      bridgeAccountIds: this.bridgeAccountIds,
    });

    if (!validation.ok) {
      this.rejections.push({
        command,
        code: validation.rejection.code,
        detail: validation.rejection.detail,
      });
      return { status: "REJECTED", rejection: validation.rejection };
    }

    return this.commitJournal(
      command,
      validation.postings,
      validation.journalId,
      journalId,
      options,
    );
  }

  private commitJournal(
    command: JournalCommand,
    postings: readonly Posting[],
    journalId: string,
    reversesJournalId: string | null,
    options: PostOptions,
  ): PostResult {
    const principal = options.principal ?? this.writer;

    if (options.tick <= this.lastTick) {
      // The chain is ordered by recorded time, so a journal recorded earlier
      // than the previous one would renumber the links. Spanner's commit
      // timestamps are externally consistent, which is what makes this
      // assumption safe there and worth asserting here.
      throw new Error(
        `tick ${options.tick} is not after the previous commit at ${this.lastTick}`,
      );
    }

    // The content hash deliberately excludes the recorded time. The body that
    // computes it runs before the commit timestamp exists, so a hash that
    // covered it could not be written in the same transaction. ADR-003.
    const contentHash = contentHashOf({
      journalId,
      ledgerId: command.ledgerId,
      businessRef: command.businessRef,
      effectiveAt: command.effectiveAt,
      description: command.description,
      reversesJournalId,
      fxNote: command.fxNote ?? null,
      postings,
    });
    const chainHash = chain(this.chainHead(), contentHash);

    const runOptions: RunOptions = {
      tick: options.tick,
      abortsBeforeCommit: options.abortsBeforeCommit ?? 0,
    };

    const { stats } = this.db.runReadWrite(principal, runOptions, (txn) => {
      // A read inside the body, so the body is not a blind write. The primary
      // key already refuses a duplicate; this turns it into a decision.
      const existing = txn.read("Journals", `${command.ledgerId}/${journalId}`);
      if (existing !== null) return "ALREADY_POSTED";

      const journalRow = {
        journalId,
        ledgerId: command.ledgerId,
        businessRef: command.businessRef,
        effectiveAt: command.effectiveAt,
        recordedAt: SpannerModel.timestampOf(options.tick),
        description: command.description,
        reversesJournalId,
        fxNote: command.fxNote ?? null,
        postings,
        contentHash,
        chainHash,
      };
      txn.insert("Journals", `${command.ledgerId}/${journalId}`, journalRow);

      for (const posting of postings) {
        txn.insert(
          "Postings",
          `${command.ledgerId}/${posting.accountId}/${posting.postingId}`,
          posting as unknown as Record<string, unknown>,
        );
      }
      return "POSTED";
    });

    void stats;
    this.lastTick = options.tick;
    this.acceptedRefs.add(command.businessRef);

    const stored = this.journal(journalId);
    if (stored === null) throw new Error(`journal ${journalId} did not commit`);
    return { status: "ACCEPTED", journal: stored };
  }

  /**
   * The alternative design, implemented so the cost can be measured rather
   * than asserted: maintain a mutable balance column in the same transaction.
   *
   * This adds a read of the balance row and an update of it, which is exactly
   * the shape the Spanner documentation says needs an exclusive lock — "An
   * exclusive lock is only necessary if your transaction first reads the data
   * it intends to write." Two journals touching one account now contend.
   */
  postMaintainingBalanceColumn(command: JournalCommand, options: PostOptions): PostResult {
    const result = this.post(command, options);
    if (result.status !== "ACCEPTED") return result;

    const principal = options.principal ?? this.writer;
    this.db.runReadWrite(principal, { tick: options.tick + 1 }, (txn) => {
      for (const posting of result.journal.postings) {
        const key = `${this.ledgerId}/${posting.accountId}`;
        const row = txn.read("AccountBalances", key) as { minor?: string } | null;
        const prior = row?.minor === undefined ? 0n : BigInt(row.minor);
        const next = prior + signedMinor(posting.direction, posting.amount);
        txn.update("AccountBalances", key, {
          accountId: posting.accountId,
          ledgerId: this.ledgerId,
          currency: posting.amount.currency,
          minor: next.toString(),
        });
      }
      return null;
    });
    return result;
  }

  /** Every account that has at least one posting, with its signed total. Used
   *  by the invariant checker as the authoritative rebuild. */
  rebuildBalances(): ReadonlyMap<string, Minor> {
    const totals = new Map<string, Minor>();
    for (const posting of this.allPostings()) {
      const prior = totals.get(posting.accountId) ?? 0n;
      totals.set(posting.accountId, prior + signedMinor(posting.direction, posting.amount));
    }
    return totals;
  }
}

export { deriveJournalId };
