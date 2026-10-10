import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  Ledger, LedgerError, adjustmentEntry, captureEntry, reversalEntry,
  settlementEntry, sumPostings, unallocatedSettlementEntry,
} from "../src/ledger.ts";

const T = Date.UTC(2026, 0, 5);

describe("entry shapes", () => {
  it("every generated entry sums to zero", () => {
    const entries = [
      captureEntry("t1", "e1", T, "EUR", 10_000),
      settlementEntry("t1", "e2", T, "EUR", 9_725, 275),
      reversalEntry("t1", "e3", T, "EUR", 10_000),
      adjustmentEntry("t1", "e4", T, "EUR", -7, "settled_cash"),
      unallocatedSettlementEntry("g1", "e5", T, "EUR", 14_600, 400),
    ];
    for (const e of entries) assert.equal(sumPostings(e.postings), 0, e.purpose);
  });

  it("a settlement clears exactly the receivable the capture created", () => {
    const capture = captureEntry("t1", "e1", T, "EUR", 10_000);
    const settle = settlementEntry("t1", "e2", T, "EUR", 9_725, 275);
    const receivable = [...capture.postings, ...settle.postings]
      .filter((p) => p.account === "merchant_receivable")
      .reduce((n, p) => n + p.amountMinor, 0);
    assert.equal(receivable, 0);
  });

  it("an unallocated settlement never touches a receivable", () => {
    const e = unallocatedSettlementEntry("g1", "e5", T, "EUR", 14_600, 400);
    assert.equal(e.postings.some((p) => p.account === "merchant_receivable"), false);
    assert.equal(e.postings.some((p) => p.account === "suspense"), true);
  });
});

describe("the ledger", () => {
  it("refuses an entry that does not balance", () => {
    const ledger = new Ledger();
    assert.throws(() => ledger.post({
      entryId: "x", transactionId: "t1", evidenceId: "e1", purpose: "bad",
      occurredAtMs: T, currency: "EUR",
      postings: [{ account: "clearing", amountMinor: 1 }],
    }), LedgerError);
  });

  it("refuses an entry with no postings", () => {
    const ledger = new Ledger();
    assert.throws(() => ledger.post({
      entryId: "x", transactionId: "t1", evidenceId: "e1", purpose: "empty",
      occurredAtMs: T, currency: "EUR", postings: [],
    }), LedgerError);
  });

  it("refuses a repeated entry id and counts the refusal", () => {
    const ledger = new Ledger();
    const e = captureEntry("t1", "e1", T, "EUR", 10_000);
    assert.equal(ledger.post(e), "POSTED");
    assert.equal(ledger.post(e), "ALREADY_POSTED");
    assert.equal(ledger.count, 1);
    assert.equal(ledger.duplicateEntries, 1);
  });

  it("two sources announcing one capture collide on the entry id", () => {
    // The evidence differs; the effect does not. That asymmetry is the whole
    // reason the entry id is derived from the transaction and the purpose.
    const ledger = new Ledger();
    assert.equal(ledger.post(captureEntry("t1", "from-gateway", T, "EUR", 10_000)), "POSTED");
    assert.equal(ledger.post(captureEntry("t1", "from-processor", T, "EUR", 10_000)), "ALREADY_POSTED");
    assert.equal(ledger.count, 1);
  });

  it("stays balanced across a capture, a settlement and a reversal", () => {
    const ledger = new Ledger();
    ledger.post(captureEntry("t1", "e1", T, "EUR", 10_000));
    ledger.post(settlementEntry("t1", "e2", T, "EUR", 9_725, 275));
    ledger.post(captureEntry("t2", "e3", T, "EUR", 4_000));
    ledger.post(reversalEntry("t2", "e4", T, "EUR", 4_000));
    assert.equal(ledger.isBalanced(), true);
  });

  it("keeps the audit path from an entry back to its evidence", () => {
    const ledger = new Ledger();
    ledger.post(captureEntry("t1", "e1", T, "EUR", 10_000));
    ledger.post(settlementEntry("t1", "e2", T, "EUR", 9_725, 275));
    assert.deepEqual(ledger.entriesForEvidence("e2").map((e) => e.purpose), ["settlement"]);
  });

  it("without the guard the same effect posts twice and the ledger still balances", () => {
    // The point of the negative control, in one assertion: balance is not a
    // duplicate detector and was never going to be one.
    const ledger = new Ledger();
    const e = captureEntry("t1", "e1", T, "EUR", 10_000);
    ledger.post(e, false);
    ledger.post(e, false);
    assert.equal(ledger.count, 2);
    assert.equal(ledger.isBalanced(), true);
  });
});
