import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  Correlator, IdentityError, canonical, evidenceId, entryId, naiveEvidenceId, stateDigest,
} from "../src/identity.ts";

const claim = {
  source: "gateway", ref: "txn-1", kind: "CAPTURED",
  grossMinor: 10_000, feeMinor: 0, netMinor: 10_000, currency: "EUR",
  occurredAtMs: 1_767_571_200_000, corrects: null, coversRefs: [] as string[],
};

describe("canonical form", () => {
  it("is insensitive to object key order", () => {
    assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  });

  it("is sensitive to array order, because order is meaning in a list", () => {
    assert.notEqual(canonical({ refs: ["a", "b"] }), canonical({ refs: ["b", "a"] }));
  });

  it("drops undefined members and keeps null", () => {
    assert.equal(canonical({ a: 1, b: undefined }), canonical({ a: 1 }));
    assert.notEqual(canonical({ a: 1, b: null }), canonical({ a: 1 }));
  });

  it("refuses a non-finite number rather than hashing it", () => {
    assert.throws(() => canonical({ amount: Number.NaN }), IdentityError);
  });
});

describe("evidence identity", () => {
  it("is the same for one assertion delivered under two ids", () => {
    assert.equal(evidenceId(claim), evidenceId({ ...claim }));
  });

  it("changes when any part of the assertion changes", () => {
    assert.notEqual(evidenceId(claim), evidenceId({ ...claim, grossMinor: 10_001 }));
    assert.notEqual(evidenceId(claim), evidenceId({ ...claim, occurredAtMs: claim.occurredAtMs + 1 }));
    assert.notEqual(evidenceId(claim), evidenceId({ ...claim, corrects: "x" }));
  });

  it("distinguishes two sources asserting the same facts", () => {
    // Deliberate. Which source said it is part of the assertion, and
    // correlation -- not hashing -- is what decides they are one transaction.
    assert.notEqual(evidenceId(claim), evidenceId({ ...claim, source: "processor" }));
  });

  it("the naive control collapses when the key order changes, and the real one does not", () => {
    const a = { kind: "CAPTURED", ref: "txn-1", grossMinor: 10_000 };
    const b = { grossMinor: 10_000, ref: "txn-1", kind: "CAPTURED" };
    assert.notEqual(naiveEvidenceId(a), naiveEvidenceId(b));
    assert.equal(canonical(a), canonical(b));
  });
});

describe("entry identity", () => {
  it("is deterministic in the transaction, the scope and the purpose", () => {
    assert.equal(entryId("t1", "", "capture"), entryId("t1", "", "capture"));
    assert.notEqual(entryId("t1", "", "capture"), entryId("t1", "", "settlement"));
    assert.notEqual(entryId("t1", "", "capture"), entryId("t2", "", "capture"));
    assert.notEqual(entryId("t1", "e1", "adjustment"), entryId("t1", "e2", "adjustment"));
  });
});

describe("correlation", () => {
  it("keeps two unlinked references apart", () => {
    const c = new Correlator();
    c.add("gateway", "txn-1");
    c.add("processor", "pi-1");
    assert.notEqual(c.transactionId("gateway", "txn-1"), c.transactionId("processor", "pi-1"));
  });

  it("joins them once a record carries both", () => {
    const c = new Correlator();
    c.link({ source: "gateway", ref: "txn-1" }, { source: "processor", ref: "pi-1" });
    assert.equal(c.transactionId("gateway", "txn-1"), c.transactionId("processor", "pi-1"));
  });

  it("produces the same canonical id whichever order the links arrive in", () => {
    const a = new Correlator();
    a.link({ source: "gateway", ref: "t" }, { source: "processor", ref: "p" });
    a.link({ source: "processor", ref: "p" }, { source: "checkout", ref: "c" });

    const b = new Correlator();
    b.link({ source: "processor", ref: "p" }, { source: "checkout", ref: "c" });
    b.link({ source: "gateway", ref: "t" }, { source: "processor", ref: "p" });

    assert.equal(a.transactionId("checkout", "c"), b.transactionId("checkout", "c"));
    assert.deepEqual(a.members("gateway", "t"), b.members("gateway", "t"));
  });
});

describe("state digest", () => {
  it("ignores the order the parts were collected in", () => {
    assert.equal(stateDigest([{ a: 1 }, { b: 2 }]), stateDigest([{ b: 2 }, { a: 1 }]));
  });

  it("changes when any part changes", () => {
    assert.notEqual(stateDigest([{ a: 1 }]), stateDigest([{ a: 2 }]));
  });
});
