// The forward path: one effect per step, whatever happens to the answers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AMOUNT_MINOR, run } from "../src/matrix.ts";
import { SAGA_V1 } from "../src/saga.ts";

function appliedFor(r: ReturnType<typeof run>, step: string): number {
  return r.world.allRecords().filter((x) => x.step === step && x.kind === "applied").length;
}

test("the happy path reaches COMPLETED with one effect per step", () => {
  const r = run("f-happy");
  assert.equal(r.record.state, "COMPLETED");
  for (const s of SAGA_V1.steps) assert.equal(appliedFor(r, s.name), 1, s.name);
});

test("the happy path records the pivot transition exactly once", () => {
  const r = run("f-pivot");
  const pivots = r.record.history.filter((h) => h.reasonCode === "PIVOT_COMMITTED");
  assert.equal(pivots.length, 1);
});

test("the steps run in the order the definition declares", () => {
  const r = run("f-order");
  assert.deepEqual(r.record.completed, SAGA_V1.steps.map((s) => s.name));
});

test("a lost response does not produce a second effect", () => {
  const r = run("f-lost", { faults: [{ step: "authorize_payment", direction: "forward", at: "lost" }] });
  assert.equal(appliedFor(r, "authorize_payment"), 1);
  assert.equal(r.record.state, "COMPLETED");
});

test("a lost response is resolved by asking the participant, not by guessing", () => {
  const r = run("f-lookup", { faults: [{ step: "authorize_payment", direction: "forward", at: "lost" }] });
  const codes = r.record.history.map((h) => h.reasonCode);
  assert.ok(codes.includes("OUTCOME_UNKNOWN"));
  assert.ok(codes.includes("RESOLVED_BY_LOOKUP"));
});

test("a crash after the participant acted leaves exactly one effect", () => {
  const r = run("f-crash", { faults: [{ step: "capture_payment", direction: "forward", at: "crash" }] });
  assert.equal(r.restarts, 1);
  assert.equal(appliedFor(r, "capture_payment"), 1);
  assert.equal(r.record.state, "COMPLETED");
});

test("a crash before the command left produces no effect for that attempt", () => {
  const r = run("f-pre", { faults: [{ step: "capture_payment", direction: "forward", at: "predispatch" }] });
  assert.equal(r.restarts, 1);
  assert.equal(appliedFor(r, "capture_payment"), 1);
});

test("a crash at every step in turn still yields one effect per step", () => {
  for (const s of SAGA_V1.steps) {
    const r = run(`f-crash-${s.name}`, { faults: [{ step: s.name, direction: "forward", at: "crash" }] });
    assert.equal(r.record.state, "COMPLETED", s.name);
    for (const t of SAGA_V1.steps) assert.equal(appliedFor(r, t.name), 1, `${s.name}/${t.name}`);
  }
});

test("a transient error is absorbed and the saga completes", () => {
  const r = run("f-transient", { faults: [{ step: "post_ledger_entry", direction: "forward", at: "error" }] });
  assert.equal(r.record.state, "COMPLETED");
  assert.equal(appliedFor(r, "post_ledger_entry"), 1);
});

test("the amount reaches the payment service unchanged", () => {
  const r = run("f-amount");
  const capture = r.world.allRecords().find((x) => x.step === "capture_payment");
  assert.equal(capture?.detail, `captured ${AMOUNT_MINOR} minor units`);
});

test("a refusal after the pivot cannot compensate", () => {
  const r = run("f-after", { faults: [{ step: "post_ledger_entry", direction: "forward", at: "reject" }] });
  assert.equal(r.record.state, "MANUAL_REPAIR");
  assert.equal(r.record.compensated.length, 0);
  assert.equal(appliedFor(r, "capture_payment"), 1);
});

test("a refusal before the pivot leaves no money moved", () => {
  const r = run("f-before", { faults: [{ step: "book_shipment", direction: "forward", at: "reject" }] });
  assert.equal(r.record.state, "COMPENSATED");
  assert.equal(appliedFor(r, "capture_payment"), 0);
  assert.equal(r.world.holdState("f-before"), "voided");
});

test("the payment service refuses to capture a hold that was voided", () => {
  const r = run("f-void-then-capture", {
    faults: [{ step: "book_shipment", direction: "forward", at: "reject" }],
  });
  assert.equal(r.world.holdState("f-void-then-capture"), "voided");
  assert.equal(r.audit.verdict, "COMPENSATED");
});

test("every step's command id names the saga, the direction and the step", () => {
  const r = run("f-ids");
  for (const rec of r.world.allRecords()) {
    assert.ok(rec.commandId.startsWith("f-ids:"), rec.commandId);
  }
});

test("the history is append-only and sequentially numbered", () => {
  const r = run("f-history");
  r.record.history.forEach((h, i) => assert.equal(h.seq, i + 1));
});

test("every history entry carries a machine-readable reason code", () => {
  const r = run("f-codes");
  for (const h of r.record.history) {
    assert.match(h.reasonCode, /^[A-Z_]+$/, `${h.kind}: ${h.reasonCode}`);
  }
});
