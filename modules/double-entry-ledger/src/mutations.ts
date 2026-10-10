// Negative controls.
//
// The invariant checker reported nine of nine on its first run. That proved
// nothing, because the same person wrote the ledger and the invariants. Each
// mutation below removes exactly one mechanism and names the invariants that
// must turn red. A mutation that reddens everything is rejected as a control:
// "it all broke" is not evidence that any particular check is doing work.

import { BalanceProjection } from "./projection.ts";
import { chain, contentHashOf } from "./hash.ts";
import { checkLedger, type ProofReport } from "./invariants.ts";
import { Ledger } from "./ledger.ts";
import { money } from "./money.ts";
import { SpannerModel, appendOnlyRole, type DatabaseRole, type Privilege } from "./spanner.ts";
import { AS_OF, BRIDGE_ACCOUNTS, CHART, JOURNALS, LEDGER_ID, buildScenario } from "./scenario.ts";
import type { Posting } from "./types.ts";

export type Mutation = {
  readonly id: string;
  readonly name: string;
  /** The mechanism this mutation removes, in one line. */
  readonly removes: string;
  /** The invariants that must report VIOLATED. Listed, not counted: a
   *  mutation that reddens a different invariant than the one it targets is a
   *  sign that the invariants are not measuring what their names claim. */
  readonly expectViolated: readonly string[];
  readonly run: () => ProofReport;
};

function freshLedger(): { db: SpannerModel; ledger: Ledger } {
  const db = new SpannerModel();
  const ledger = new Ledger(db, { ledgerId: LEDGER_ID, bridgeAccountIds: BRIDGE_ACCOUNTS });
  for (const acct of CHART) ledger.openAccount(acct);
  return { db, ledger };
}

function projectedFrom(ledger: Ledger): BalanceProjection {
  const projection = new BalanceProjection();
  projection.consumeAll(ledger.feed());
  return projection;
}

/** M1 — accept a journal without checking that it balances. */
function noBalanceCheck(): ProofReport {
  const { db, ledger } = freshLedger();
  // Post one legitimate journal so the population is not empty, then write an
  // unbalanced journal straight into the tables, which is what a missing
  // validation step amounts to.
  const first = JOURNALS[0];
  if (first === undefined) throw new Error("scenario has no journals");
  const posted = ledger.post(first.command, { tick: first.tick });
  if (posted.status !== "ACCEPTED") throw new Error("scenario journal rejected");

  const journalId = "jnl_unbalanced";
  const postings: Posting[] = [
    {
      postingId: "pst_unbalanced_0001",
      journalId,
      ledgerId: LEDGER_ID,
      lineNumber: 1,
      accountId: CHART[0]?.accountId ?? "",
      direction: "DEBIT",
      amount: money("USD", 5_000n),
      memo: "half of a journal",
    },
    {
      postingId: "pst_unbalanced_0002",
      journalId,
      ledgerId: LEDGER_ID,
      lineNumber: 2,
      accountId: CHART[1]?.accountId ?? "",
      direction: "CREDIT",
      amount: money("USD", 4_900n),
      memo: "the other, smaller half",
    },
  ];
  writeRawJournal(db, ledger, journalId, "unbalanced-0001", postings);
  return checkLedger(ledger, projectedFrom(ledger), AS_OF);
}

/**
 * Write a journal into the tables without going through validation.
 *
 * The hashes are computed correctly on purpose. A mutation that also broke
 * the hash chain would redden INV-2 as well, and then the experiment would
 * show that something is wrong without showing which check noticed.
 */
function writeRawJournal(
  db: SpannerModel,
  ledger: Ledger,
  journalId: string,
  businessRef: string,
  postings: readonly Posting[],
): void {
  const principal = { kind: "FGAC" as const, id: "mutant", role: appendOnlyRole() };
  const header = {
    journalId,
    ledgerId: LEDGER_ID,
    businessRef,
    effectiveAt: "2026-03-10",
    description: "written without validation",
    reversesJournalId: null,
    fxNote: null,
    postings,
  };
  const contentHash = contentHashOf(header);
  const chainHash = chain(ledger.chainHead(), contentHash);
  db.runReadWrite(principal, { tick: 999 }, (txn) => {
    txn.insert("Journals", `${LEDGER_ID}/${journalId}`, {
      ...header,
      recordedAt: SpannerModel.timestampOf(999),
      contentHash,
      chainHash,
    });
    for (const posting of postings) {
      txn.insert(
        "Postings",
        `${LEDGER_ID}/${posting.accountId}/${posting.postingId}`,
        posting as unknown as Record<string, unknown>,
      );
    }
    return null;
  });
}

/** M2 — a projection with no inbox, meeting a redelivered partition. */
function projectionWithoutInbox(): ProofReport {
  const { ledger } = buildScenario();
  const projection = new BalanceProjection({ dedupe: false });
  const feed = ledger.feed();
  const partitions = [...new Set(feed.map((r) => r.partition))].sort();
  for (const partition of partitions) projection.consumePartition(feed, partition);
  // One consumer crashed before checkpointing and re-read its partition.
  const first = partitions[0];
  if (first !== undefined) projection.consumePartition(feed, first, { from: 0 });
  return checkLedger(ledger, projection, AS_OF);
}

/** M3 — posting ids minted inside the transaction body instead of derived
 *  from content, meeting a retried transaction. */
function nondeterministicPostingIds(): ProofReport {
  const { db, ledger } = freshLedger();
  const first = JOURNALS[0];
  if (first === undefined) throw new Error("scenario has no journals");
  const accepted = ledger.post(first.command, { tick: first.tick });
  if (accepted.status !== "ACCEPTED") throw new Error("scenario journal rejected");

  // Now the same journal again, with a body that generates fresh ids per
  // attempt. One abort, two attempts, two sets of postings — and the journal
  // row's primary key does not stop the second set, because the postings are
  // keyed on ids that changed.
  const journal = accepted.journal;
  const principal = { kind: "FGAC" as const, id: "mutant", role: appendOnlyRole() };
  let counter = 0;
  for (const attempt of [1, 2]) {
    void attempt;
    counter += 1;
    db.runReadWrite(principal, { tick: 900 + counter }, (txn) => {
      for (const posting of journal.postings) {
        const minted: Posting = { ...posting, postingId: `${posting.postingId}_a${counter}` };
        txn.insert(
          "Postings",
          `${LEDGER_ID}/${minted.accountId}/${minted.postingId}`,
          minted as unknown as Record<string, unknown>,
        );
      }
      return null;
    });
  }
  return checkLedger(ledger, projectedFrom(ledger), AS_OF);
}

/** M4 — amounts computed as IEEE doubles rather than integer minor units. */
function floatMoney(): ProofReport {
  const { db, ledger } = freshLedger();
  const first = JOURNALS[0];
  if (first === undefined) throw new Error("scenario has no journals");
  const posted = ledger.post(first.command, { tick: first.tick });
  if (posted.status !== "ACCEPTED") throw new Error("scenario journal rejected");

  // The classic: 0.1 + 0.2 is not 0.3. A journal splitting 0.30 into 0.10 and
  // 0.20 balances in minor units and does not balance in doubles.
  const debit = Math.round((0.1 + 0.2) * 100);
  const credit = Math.round(0.3 * 100);
  const drift = BigInt(debit - credit);
  const journalId = "jnl_float";
  const postings: Posting[] = [
    {
      postingId: "pst_float_0001",
      journalId,
      ledgerId: LEDGER_ID,
      lineNumber: 1,
      accountId: CHART[0]?.accountId ?? "",
      direction: "DEBIT",
      // The drift is forced to one minor unit so the mutation is visible even
      // on a platform where the rounding happens to cancel.
      amount: money("USD", 30n + (drift === 0n ? 1n : drift)),
      memo: "0.1 + 0.2",
    },
    {
      postingId: "pst_float_0002",
      journalId,
      ledgerId: LEDGER_ID,
      lineNumber: 2,
      accountId: CHART[1]?.accountId ?? "",
      direction: "CREDIT",
      amount: money("USD", 30n),
      memo: "0.3",
    },
  ];
  writeRawJournal(db, ledger, journalId, "float-0001", postings);
  return checkLedger(ledger, projectedFrom(ledger), AS_OF);
}

/** M5 — the writer role keeps DELETE, and something uses it. */
function deletePermitted(): ProofReport {
  const { db, ledger } = buildScenario();
  const role: DatabaseRole = {
    name: "ledger_writer_with_delete",
    grants: new Map<string, ReadonlySet<Privilege>>([
      ["Journals", new Set<Privilege>(["SELECT", "INSERT", "DELETE"])],
      ["Postings", new Set<Privilege>(["SELECT", "INSERT", "DELETE"])],
    ]),
  };
  const principal = { kind: "FGAC" as const, id: "cleanup-job", role };
  const victim = ledger.allPostings()[0];
  if (victim === undefined) throw new Error("no postings to delete");
  const projection = projectedFrom(ledger);
  db.runReadWrite(principal, { tick: 950 }, (txn) => {
    txn.delete("Postings", `${LEDGER_ID}/${victim.accountId}/${victim.postingId}`);
    return null;
  });
  return checkLedger(ledger, projection, AS_OF);
}

/**
 * M6 — a careful, balanced edit of an already-written journal.
 *
 * Both sides are raised by the same amount, so the journal still balances and
 * the trial balance still ties. The projection is rebuilt afterwards, so it
 * agrees with the edited postings too. Every balance check in the report is
 * satisfied by a ledger that now says something different from what was
 * posted. The hash chain is the only check left.
 */
function balancedTamper(): ProofReport {
  const { db, ledger } = buildScenario();
  const target = ledger.allJournals().find((j) => j.postings.length === 2);
  if (target === undefined) throw new Error("no two-line journal to edit");

  const edited: Posting[] = target.postings.map((p) => ({
    ...p,
    amount: { currency: p.amount.currency, minor: p.amount.minor + 100n },
  }));

  for (const posting of edited) {
    const key = `${LEDGER_ID}/${posting.accountId}/${posting.postingId}`;
    db.table("Postings").set(key, posting as unknown as Record<string, unknown>);
  }
  const journalKey = `${LEDGER_ID}/${target.journalId}`;
  const stored = db.rowAt("Journals", journalKey);
  if (stored === null) throw new Error("journal vanished");
  db.table("Journals").set(journalKey, { ...stored, postings: edited });

  // Rebuild the projection from the edited postings, so INV-3 cannot help.
  const projection = new BalanceProjection();
  for (const posting of ledger.allPostings()) {
    projection.apply({
      commitTimestamp: SpannerModel.timestampOf(1),
      serverTransactionId: `txn_${posting.journalId.slice(4, 16)}`,
      recordSequence: posting.lineNumber,
      numberOfRecordsInTransaction: 1,
      partition: "p1",
      table: "Postings",
      modType: "INSERT",
      posting,
    });
  }
  return checkLedger(ledger, projection, AS_OF);
}

/** The blunt control: an empty ledger. Every invariant holds over nothing. */
export function emptyLedgerControl(): ProofReport {
  const db = new SpannerModel();
  const ledger = new Ledger(db, { ledgerId: LEDGER_ID, bridgeAccountIds: BRIDGE_ACCOUNTS });
  for (const acct of CHART) ledger.openAccount(acct);
  return checkLedger(ledger, new BalanceProjection(), AS_OF);
}

export const MUTATIONS: readonly Mutation[] = [
  {
    id: "M1",
    name: "no balance check",
    removes: "journal validation's debits-equal-credits rule",
    expectViolated: ["INV-1", "INV-8"],
    run: noBalanceCheck,
  },
  {
    id: "M2",
    name: "projection without an inbox",
    removes: "the projection's record of which postings it already applied",
    expectViolated: ["INV-3"],
    run: projectionWithoutInbox,
  },
  {
    id: "M3",
    name: "posting ids minted in the transaction body",
    removes: "deterministic identity across a retried read-write transaction",
    // Only INV-4. The projection consumes the change stream, so it reproduces
    // the duplicate postings faithfully and agrees with the rebuild. Comparing
    // a projection with the postings cannot detect a duplicated posting; only
    // the journal's own account of how many lines it has can.
    expectViolated: ["INV-4"],
    run: nondeterministicPostingIds,
  },
  {
    id: "M4",
    name: "money as a double",
    removes: "exact integer minor units",
    expectViolated: ["INV-1", "INV-8"],
    run: floatMoney,
  },
  {
    id: "M5",
    name: "DELETE left on the writer role",
    removes: "the privilege boundary that makes a posting immutable",
    expectViolated: ["INV-3", "INV-4", "INV-8"],
    run: deletePermitted,
  },
  {
    id: "M6",
    name: "a balanced edit of an accepted journal",
    removes: "nothing a balance check can see — this is what the chain is for",
    expectViolated: ["INV-2"],
    run: balancedTamper,
  },
];
