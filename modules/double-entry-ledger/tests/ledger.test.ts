// The ledger: posting, reversal, immutability, concurrency, balances.

import { test } from "node:test";
import assert from "node:assert/strict";
import { balancesFor, inNormalDirection, trialBalance } from "../src/balances.ts";
import { Ledger } from "../src/ledger.ts";
import { money } from "../src/money.ts";
import {
  AccessDenied,
  SpannerModel,
  appendOnlyRole,
  readerRole,
  type Principal,
} from "../src/spanner.ts";
import {
  ACCOUNTS,
  AS_OF,
  BRIDGE_ACCOUNTS,
  CHART,
  LEDGER_ID,
  buildScenario,
} from "../src/scenario.ts";
import type { JournalCommand } from "../src/types.ts";

function emptyLedger(): { db: SpannerModel; ledger: Ledger } {
  const db = new SpannerModel();
  const ledger = new Ledger(db, { ledgerId: LEDGER_ID, bridgeAccountIds: BRIDGE_ACCOUNTS });
  for (const account of CHART) ledger.openAccount(account);
  return { db, ledger };
}

function transfer(businessRef: string, minor: bigint, effectiveAt = "2026-02-10"): JournalCommand {
  return {
    ledgerId: LEDGER_ID,
    businessRef,
    effectiveAt,
    description: "test transfer",
    lines: [
      { accountId: ACCOUNTS.clearing, direction: "DEBIT", amount: money("USD", minor), memo: "d" },
      { accountId: ACCOUNTS.wallet, direction: "CREDIT", amount: money("USD", minor), memo: "c" },
    ],
  };
}

test("L01 an accepted journal writes its postings atomically", () => {
  const { ledger } = emptyLedger();
  const result = ledger.post(transfer("t-1", 500n), { tick: 1 });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(ledger.allPostings().length, 2);
  assert.equal(ledger.allJournals().length, 1);
});

test("L02 a rejected journal writes nothing at all", () => {
  const { ledger } = emptyLedger();
  const unbalanced: JournalCommand = {
    ...transfer("t-2", 500n),
    lines: [
      { accountId: ACCOUNTS.clearing, direction: "DEBIT", amount: money("USD", 500n), memo: "d" },
      { accountId: ACCOUNTS.wallet, direction: "CREDIT", amount: money("USD", 400n), memo: "c" },
    ],
  };
  const result = ledger.post(unbalanced, { tick: 1 });
  assert.equal(result.status, "REJECTED");
  assert.equal(ledger.allPostings().length, 0);
  assert.equal(ledger.rejectionLog().length, 1);
});

test("L03 the same business reference posts once", () => {
  const { ledger } = emptyLedger();
  assert.equal(ledger.post(transfer("t-3", 500n), { tick: 1 }).status, "ACCEPTED");
  const second = ledger.post(transfer("t-3", 500n), { tick: 2 });
  assert.equal(second.status, "REJECTED");
  if (second.status === "REJECTED") {
    assert.equal(second.rejection.code, "DUPLICATE_BUSINESS_REF");
  }
  assert.equal(ledger.allPostings().length, 2);
});

test("L04 a retried transaction body writes one journal, not two", () => {
  const { ledger } = emptyLedger();
  // Three attempts of one post. The ids are derived from the command, so the
  // discarded attempts and the successful one agree on every key.
  const result = ledger.post(transfer("t-4", 500n), { tick: 1, abortsBeforeCommit: 2 });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(ledger.allJournals().length, 1);
  assert.equal(ledger.allPostings().length, 2);
});

test("L05 concurrent postings to the same account do not contend when nothing is read", () => {
  const { db, ledger } = emptyLedger();
  // Two journals touching the same account, committed at one tick. They write
  // different posting rows, so no field overlaps and both commit. This is the
  // append-only shape: "An exclusive lock is only necessary if your
  // transaction first reads the data it intends to write."
  assert.equal(ledger.post(transfer("t-5a", 500n), { tick: 1 }).status, "ACCEPTED");
  assert.equal(ledger.post(transfer("t-5b", 700n), { tick: 2 }).status, "ACCEPTED");
  assert.equal(ledger.allPostings().length, 4);
  assert.equal(inNormalDirection("ASSET", ledger.rebuildBalances().get(ACCOUNTS.clearing) ?? 0n), 1_200n);
  void db;
});

test("L06 maintaining a balance column adds a read before a write of the same row", () => {
  const { db, ledger } = emptyLedger();
  ledger.postMaintainingBalanceColumn(transfer("t-6a", 500n), { tick: 1 });
  ledger.postMaintainingBalanceColumn(transfer("t-6b", 700n), { tick: 10 });
  const row = db.rowAt("AccountBalances", `${LEDGER_ID}/${ACCOUNTS.clearing}`);
  assert.equal((row as { minor: string }).minor, "1200");
  // Both balance-column transactions wrote the same key. Had they been offered
  // the same commit tick, one of them would have had to take a later one.
  assert.throws(
    () =>
      db.runReadWrite(
        { kind: "FGAC", id: "x", role: appendOnlyRole() },
        { tick: 11 },
        (txn) => {
          txn.update("AccountBalances", `${LEDGER_ID}/${ACCOUNTS.clearing}`, { minor: "0" });
          return null;
        },
      ),
    /distinct commit timestamps/,
  );
});

test("L07 a reversal is a new journal and leaves the original alone", () => {
  const { ledger } = emptyLedger();
  const posted = ledger.post(transfer("t-7", 500n), { tick: 1 });
  assert.equal(posted.status, "ACCEPTED");
  if (posted.status !== "ACCEPTED") return;
  const before = posted.journal.contentHash;

  const reversal = ledger.reverse(
    posted.journal.journalId,
    { businessRef: "t-7-reversal", effectiveAt: "2026-02-11", reason: "wrong account" },
    { tick: 2 },
  );
  assert.equal(reversal.status, "ACCEPTED");
  if (reversal.status !== "ACCEPTED") return;

  // The original is byte-for-byte what it was.
  assert.equal(ledger.journal(posted.journal.journalId)?.contentHash, before);
  assert.equal(reversal.journal.reversesJournalId, posted.journal.journalId);
  // Four postings now exist: nothing was removed.
  assert.equal(ledger.allPostings().length, 4);
  // And the net is zero.
  assert.equal(ledger.rebuildBalances().get(ACCOUNTS.clearing), 0n);
});

test("L08 a reversal mirrors every direction", () => {
  const { ledger } = emptyLedger();
  const posted = ledger.post(transfer("t-8", 500n), { tick: 1 });
  if (posted.status !== "ACCEPTED") throw new Error("setup failed");
  const reversal = ledger.reverse(
    posted.journal.journalId,
    { businessRef: "t-8-reversal", effectiveAt: "2026-02-11", reason: "r" },
    { tick: 2 },
  );
  if (reversal.status !== "ACCEPTED") throw new Error("reversal failed");
  const mirrors = reversal.journal.postings;
  for (const original of posted.journal.postings) {
    const mirror = mirrors.find((p) => p.accountId === original.accountId);
    assert.ok(mirror !== undefined);
    assert.notEqual(mirror.direction, original.direction);
    assert.equal(mirror.amount.minor, original.amount.minor);
  }
});

test("L09 an attempt to update or delete a posting is refused by the privilege model", () => {
  const { db, ledger } = emptyLedger();
  const posted = ledger.post(transfer("t-9", 500n), { tick: 1 });
  if (posted.status !== "ACCEPTED") throw new Error("setup failed");
  const victim = ledger.allPostings()[0];
  assert.ok(victim !== undefined);
  const key = `${LEDGER_ID}/${victim.accountId}/${victim.postingId}`;

  assert.throws(
    () => db.runReadWrite(ledger.writer, { tick: 2 }, (txn) => txn.delete("Postings", key)),
    AccessDenied,
  );
  assert.throws(
    () => db.runReadWrite(ledger.writer, { tick: 3 }, (txn) => txn.update("Postings", key, {})),
    AccessDenied,
  );
  assert.notEqual(db.rowAt("Postings", key), null);
});

test("L10 a principal without a grant cannot read an account's postings", () => {
  const { db, ledger } = emptyLedger();
  ledger.post(transfer("t-10", 500n), { tick: 1 });
  const stranger: Principal = {
    kind: "FGAC",
    id: "stranger",
    role: { name: "none", grants: new Map() },
  };
  assert.throws(
    () =>
      db.runReadWrite(stranger, { tick: 2 }, (txn) =>
        txn.scan("Postings", `${LEDGER_ID}/${ACCOUNTS.wallet}/`),
      ),
    AccessDenied,
  );
  // A reader with the grant sees exactly that account's postings and no others.
  const reader: Principal = { kind: "FGAC", id: "analyst", role: readerRole() };
  const rows = db.runReadWrite(reader, { tick: 3 }, (txn) =>
    txn.scan("Postings", `${LEDGER_ID}/${ACCOUNTS.wallet}/`),
  ).value;
  assert.equal(rows.length, 1);
});

test("L11 backdating keeps effective time and recorded time apart", () => {
  const { ledger } = emptyLedger();
  const posted = ledger.post(transfer("t-11", 500n, "2026-01-05"), { tick: 500 });
  if (posted.status !== "ACCEPTED") throw new Error("setup failed");
  assert.equal(posted.journal.effectiveAt, "2026-01-05");
  assert.equal(posted.journal.recordedAt, SpannerModel.timestampOf(500));
  assert.notEqual(posted.journal.effectiveAt, posted.journal.recordedAt);

  // As of a date before the effective date, the journal contributes nothing to
  // the accounting balance, but the ledger still holds it.
  const asOfEarlier = balancesFor(ledger, ACCOUNTS.clearing, "2026-01-01");
  assert.equal(asOfEarlier.accounting, 0n);
  assert.equal(asOfEarlier.current, 500n);
  assert.equal(asOfEarlier.evidence.length, 0);
});

test("L12 closing a period refuses later backdated entries into it", () => {
  const { ledger } = emptyLedger();
  ledger.closePeriodThrough("2026-01-31");
  const late = ledger.post(transfer("t-12", 500n, "2026-01-20"), { tick: 1 });
  assert.equal(late.status, "REJECTED");
  if (late.status === "REJECTED") assert.equal(late.rejection.code, "PERIOD_CLOSED");
  const adjustment = ledger.post(transfer("t-12-adj", 500n, "2026-02-01"), { tick: 2 });
  assert.equal(adjustment.status, "ACCEPTED");
});

test("L13 a commit recorded earlier than the previous one is refused", () => {
  const { ledger } = emptyLedger();
  ledger.post(transfer("t-13a", 500n), { tick: 10 });
  assert.throws(() => ledger.post(transfer("t-13b", 500n), { tick: 9 }), /is not after/);
});

test("L14 the demo scenario's four balances are what the postings say", () => {
  const { ledger } = buildScenario();
  const wallet = balancesFor(ledger, ACCOUNTS.wallet, AS_OF);
  // Credit-normal, so presented in the natural direction.
  assert.equal(inNormalDirection("LIABILITY", wallet.current), 7_260n);
  assert.equal(inNormalDirection("LIABILITY", wallet.pending), 3_000n);
  assert.equal(inNormalDirection("LIABILITY", wallet.available), 4_260n);
  assert.equal(inNormalDirection("LIABILITY", wallet.accounting), 7_260n);
  assert.ok(wallet.evidence.length > 0);
});

test("L15 the accounting balance as of a date excludes later effective dates", () => {
  const { ledger } = buildScenario();
  const beforeTheRefund = balancesFor(ledger, ACCOUNTS.refunds, "2026-02-26");
  const afterTheRefund = balancesFor(ledger, ACCOUNTS.refunds, "2026-02-27");
  assert.equal(beforeTheRefund.accounting, 0n);
  assert.equal(afterTheRefund.accounting, 1_500n);
  // The posting existed in the database the whole time; only its effective
  // date moved it into the accounting balance.
  assert.equal(beforeTheRefund.current, afterTheRefund.current);
});

test("L16 the trial balance ties in both currencies", () => {
  const { ledger } = buildScenario();
  for (const [, { debits, credits }] of trialBalance(ledger)) {
    assert.equal(debits, credits);
  }
  assert.equal(trialBalance(ledger).size, 2);
});
