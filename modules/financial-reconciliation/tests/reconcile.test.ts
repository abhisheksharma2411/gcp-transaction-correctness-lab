import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Pipeline } from "../src/pipeline.ts";
import { DEFAULT_CONFIG } from "../src/reconcile.ts";
import { normalize } from "../src/normalize.ts";
import type { RawRecord, SourceId } from "../src/types.ts";

const T0 = Date.UTC(2026, 0, 5);
const DAY = 86_400_000;

function pipeline(): Pipeline {
  return new Pipeline({ allowedLatenessMs: 30 * DAY, reconcile: DEFAULT_CONFIG });
}

function record(
  id: string, source: SourceId, body: Record<string, unknown>, atMs = T0,
): RawRecord {
  return { sourceEventId: id, source, receivedAtMs: atMs, body };
}

const capture = (ref: string, gross: number, at: number): Record<string, unknown> => ({
  kind: "CAPTURED", ref, currency: "EUR", occurredAtMs: T0 + at, grossMinor: gross,
});
const settle = (ref: string, gross: number, fee: number, at: number): Record<string, unknown> => ({
  kind: "SETTLED", ref, currency: "EUR", occurredAtMs: T0 + at, grossMinor: gross, feeMinor: fee,
});

describe("normalisation", () => {
  it("refuses a record whose net contradicts its gross and fee", () => {
    const r = normalize(record("e", "gateway", {
      kind: "SETTLED", ref: "t", currency: "EUR", occurredAtMs: T0,
      grossMinor: 10_000, feeMinor: 275, netMinor: 9_000,
    }));
    assert.equal(r.ok, false);
  });

  it("refuses a fee on a record that is not a settlement", () => {
    const r = normalize(record("e", "gateway", {
      kind: "CAPTURED", ref: "t", currency: "EUR", occurredAtMs: T0,
      grossMinor: 10_000, feeMinor: 10,
    }));
    assert.equal(r.ok, false);
  });

  it("refuses a non-integer amount rather than rounding it", () => {
    const r = normalize(record("e", "gateway", {
      kind: "CAPTURED", ref: "t", currency: "EUR", occurredAtMs: T0, grossMinor: 10.5,
    }));
    assert.equal(r.ok, false);
  });

  it("derives net from gross and fee for a settlement", () => {
    const r = normalize(record("e", "gateway", settle("t", 10_000, 275, 0)));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.observation.netMinor, 9_725);
  });
});

describe("contradiction and fees", () => {
  it("does not choose between two sources that disagree", () => {
    const p = pipeline();
    p.ingest([
      record("a", "gateway", capture("txn", 10_000, 0)),
      record("b", "processor", {
        ...capture("pi", 10_500, 60_000),
        alsoKnownAs: [{ source: "gateway", ref: "txn" }],
      }),
    ]);
    const c = [...p.reconciler.cases.values()][0]!;
    assert.equal(p.reconciler.cases.size, 1);
    assert.equal(c.capturedMinor, 10_000);
    assert.deepEqual(c.exceptions.map((x) => x.reason), ["CONTRADICTORY_SOURCES"]);
    assert.equal(p.ledger.count, 1);
  });

  it("posts the cash and flags the fee when the processor kept more", () => {
    const p = pipeline();
    p.ingest([
      record("a", "gateway", capture("txn", 10_000, 0)),
      record("b", "gateway", settle("txn", 10_000, 900, DAY)),
    ]);
    const c = [...p.reconciler.cases.values()][0]!;
    assert.deepEqual(c.exceptions.map((x) => x.reason), ["FEE_UNEXPLAINED"]);
    assert.equal(p.ledger.count, 2);
    assert.equal(p.ledger.isBalanced(), true);
  });

  it("accepts a fee inside the stated tolerance without an exception", () => {
    const p = pipeline();
    p.ingest([
      record("a", "gateway", capture("txn", 10_000, 0)),
      record("b", "gateway", settle("txn", 10_000, 276, DAY)),
    ]);
    const c = [...p.reconciler.cases.values()][0]!;
    assert.deepEqual(c.exceptions, []);
  });
});

describe("corrections", () => {
  function corrected(finalFirst: boolean): Pipeline {
    const p = pipeline();
    p.ingest([
      record("a", "gateway", capture("txn", 10_000, 0)),
      record("b", "gateway", settle("txn", 10_000, 275, DAY)),
    ]);
    if (finalFirst) p.close(T0 + 10 * DAY);
    p.ingest([
      record("c", "gateway", { ...settle("txn", 10_000, 282, DAY), corrects: "b" }),
    ]);
    return p;
  }

  it("absorbs a correction that arrives before finality", () => {
    const p = corrected(false);
    const c = [...p.reconciler.cases.values()][0]!;
    assert.deepEqual(c.exceptions, []);
    assert.equal(c.settledFeeMinor, 282);
    assert.equal(p.ledger.count, 3);
  });

  it("refuses to rewrite a position that already went final", () => {
    const p = corrected(true);
    const c = [...p.reconciler.cases.values()][0]!;
    assert.deepEqual(c.exceptions.map((x) => x.reason), ["CORRECTION_AFTER_FINALITY"]);
    // The settlement entry is untouched; the delta is a new, traceable effect.
    const settlement = p.ledger.all().find((e) => e.purpose === "settlement")!;
    assert.equal(settlement.postings.find((x) => x.account === "fee_expense")!.amountMinor, 275);
    const adjustment = p.ledger.all().find((e) => e.purpose === "adjustment")!;
    assert.equal(adjustment.postings[0]!.amountMinor, -7);
    assert.equal(p.ledger.isBalanced(), true);
  });

  it("refuses a correction whose key fields do not match the original", () => {
    const p = pipeline();
    p.ingest([
      record("a", "gateway", capture("txn", 10_000, 0)),
      record("b", "gateway", { ...settle("txn", 10_000, 275, DAY), corrects: "a" }),
    ]);
    const c = [...p.reconciler.cases.values()][0]!;
    assert.deepEqual(c.exceptions.map((x) => x.reason), ["INVALID_CORRECTION"]);
    assert.equal(p.ledger.count, 1);
  });

  it("refuses a correction that points at nothing", () => {
    const p = pipeline();
    p.ingest([
      record("a", "gateway", capture("txn", 10_000, 0)),
      record("b", "gateway", { ...settle("txn", 10_000, 275, DAY), corrects: "never-seen" }),
    ]);
    const c = [...p.reconciler.cases.values()][0]!;
    assert.deepEqual(c.exceptions.map((x) => x.reason), ["INVALID_CORRECTION"]);
  });
});

describe("finality", () => {
  it("does not go final before the correction window elapses", () => {
    const p = pipeline();
    p.ingest([
      record("a", "gateway", capture("txn", 10_000, 0)),
      record("b", "gateway", settle("txn", 10_000, 275, DAY)),
    ]);
    p.close(T0 + DAY + 1);
    assert.equal([...p.reconciler.cases.values()][0]!.finality, "PROVISIONAL");
    p.close(T0 + 10 * DAY);
    assert.equal([...p.reconciler.cases.values()][0]!.finality, "FINAL");
  });

  it("does not go final merely because the window elapsed", () => {
    const p = pipeline();
    p.ingest([record("a", "gateway", capture("txn", 10_000, 0))]);
    p.close(T0 + 30 * DAY);
    const c = [...p.reconciler.cases.values()][0]!;
    assert.equal(c.finality, "PROVISIONAL");
    assert.equal(c.state, "UNMATCHED");
    assert.deepEqual(c.exceptions.map((x) => x.reason), ["MISSING_SETTLEMENT"]);
  });

  it("raises the missing-settlement exception once however often the sweep runs", () => {
    const p = pipeline();
    p.ingest([record("a", "gateway", capture("txn", 10_000, 0))]);
    for (let i = 0; i < 5; i += 1) p.close(T0 + 30 * DAY + i);
    assert.equal([...p.reconciler.cases.values()][0]!.exceptions.length, 1);
  });
});

describe("manual resolution", () => {
  function unmatched(): Pipeline {
    const p = pipeline();
    p.ingest([record("a", "gateway", capture("txn", 10_000, 0))]);
    p.close(T0 + 30 * DAY);
    return p;
  }

  it("is versioned, and both versions survive", () => {
    const p = unmatched();
    const tx = p.correlator.transactionId("gateway", "txn");
    const first = p.resolve({
      transactionId: tx, actor: "ops-1", action: "AWAIT_EVIDENCE", note: "file delayed",
    }, T0 + 31 * DAY);
    const second = p.resolve({
      transactionId: tx, actor: "ops-1", action: "WRITE_OFF", note: "still nothing",
    }, T0 + 45 * DAY);
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    const c = p.reconciler.cases.get(tx)!;
    assert.equal(c.resolutions.length, 2);
    assert.equal(c.resolutions[0]!.action, "AWAIT_EVIDENCE");
    assert.equal(c.state, "RESOLVED");
    assert.equal(c.finality, "FINAL");
  });

  it("records the evidence the operator was looking at", () => {
    const p = unmatched();
    const tx = p.correlator.transactionId("gateway", "txn");
    const r = p.resolve({
      transactionId: tx, actor: "ops-1", action: "ACCEPT_AS_IS", note: "agreed with the processor",
    }, T0 + 31 * DAY);
    assert.equal(r.evidenceSeen.length, 1);
  });

  it("refuses a decision with no actor and one with no note", () => {
    const p = unmatched();
    const tx = p.correlator.transactionId("gateway", "txn");
    assert.throws(() => p.resolve(
      { transactionId: tx, actor: "  ", action: "ACCEPT_AS_IS", note: "x" }, T0,
    ));
    assert.throws(() => p.resolve(
      { transactionId: tx, actor: "ops-1", action: "ACCEPT_AS_IS", note: "" }, T0,
    ));
    assert.equal(p.reconciler.cases.get(tx)!.resolutions.length, 0);
  });

  it("a write-off posts a balanced, traceable entry", () => {
    const p = unmatched();
    const tx = p.correlator.transactionId("gateway", "txn");
    p.resolve({
      transactionId: tx, actor: "ops-1", action: "WRITE_OFF", note: "no settlement in 30 days",
    }, T0 + 31 * DAY);
    const writeOff = p.ledger.all().find((e) => e.purpose === "write-off")!;
    assert.equal(writeOff.evidenceId, "resolution:1");
    assert.equal(p.ledger.isBalanced(), true);
  });
});

describe("grouping", () => {
  it("puts a settlement it cannot allocate into suspense and raises an exception", () => {
    const p = pipeline();
    p.ingest([
      record("a", "gateway", capture("txn-a", 10_000, 0)),
      record("b", "gateway", capture("txn-b", 5_000, 60_000)),
      record("c", "processor", {
        ...settle("payout", 15_000, 400, DAY), coversRefs: ["txn-a", "txn-b"],
      }),
    ]);
    const grouped = p.ledger.all().find((e) => e.purpose === "grouped-settlement")!;
    assert.equal(grouped.postings.find((x) => x.account === "suspense")!.amountMinor, -15_000);
    assert.equal(p.ledger.isBalanced(), true);
    const reasons = [...p.reconciler.cases.values()].flatMap((c) => c.exceptions.map((x) => x.reason));
    assert.deepEqual(reasons, ["UNALLOCATED_GROUPING"]);
  });
});
