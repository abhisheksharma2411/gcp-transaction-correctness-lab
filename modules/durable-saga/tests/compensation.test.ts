// Compensation: what it walks, in what order, and what it does when refused.

import { test } from "node:test";
import assert from "node:assert/strict";

import { run } from "../src/matrix.ts";

function compensatedSteps(r: ReturnType<typeof run>): readonly string[] {
  return r.world.allRecords().filter((x) => x.kind === "compensated").map((x) => x.step);
}

test("the chain runs in reverse dispatch order", () => {
  const r = run("c-order", { faults: [{ step: "capture_payment", direction: "forward", at: "reject" }] });
  assert.deepEqual(compensatedSteps(r), ["cancel_shipment", "void_authorization", "release_stock"]);
});

test("a saga whose first step is refused has nothing to compensate", () => {
  const r = run("c-none", { faults: [{ step: "reserve_stock", direction: "forward", at: "reject" }] });
  assert.equal(r.record.state, "COMPENSATED");
  assert.equal(r.world.allRecords().length, 0);
});

test("a compensation for a step the participant never applied is complete, not failed", () => {
  const r = run("c-nothing", { faults: [{ step: "authorize_payment", direction: "forward", at: "reject" }] });
  assert.equal(r.record.state, "COMPENSATED");
  const codes = r.record.history.map((h) => h.reasonCode);
  assert.ok(codes.includes("NOTHING_TO_UNDO"));
});

test("the chain covers a step that was dispatched but never answered", () => {
  const r = run("c-pending", { cancelWhileWaiting: true });
  assert.ok(r.record.compensated.includes("book_shipment"));
  assert.equal(r.record.completed.includes("book_shipment"), false);
});

test("the carrier cannot book a shipment the saga already cancelled", () => {
  const r = run("c-tombstone", { cancelWhileWaiting: true });
  assert.equal(r.world.bookingState("c-tombstone"), "cancelled");
  assert.equal(r.world.allRecords().some((x) => x.step === "book_shipment" && x.kind === "applied"), false);
});

test("a compensation that keeps failing stops rather than looping", () => {
  const r = run("c-stop", {
    faults: [
      { step: "capture_payment", direction: "forward", at: "reject" },
      { step: "void_authorization", direction: "compensate", at: "reject", sticky: true },
    ],
  });
  assert.equal(r.record.state, "COMPENSATION_FAILED");
  const attempts = r.record.history.filter((h) => h.kind === "compensation_dispatched" && h.step === "authorize_payment");
  assert.equal(attempts.length, 3);
});

test("a stopped chain leaves the compensations it had already run alone", () => {
  const r = run("c-partial", {
    faults: [
      { step: "capture_payment", direction: "forward", at: "reject" },
      { step: "void_authorization", direction: "compensate", at: "reject", sticky: true },
    ],
  });
  assert.deepEqual(compensatedSteps(r), ["cancel_shipment"]);
  assert.deepEqual(r.audit.live, ["authorize_payment", "reserve_stock"]);
});

test("an operator retry resumes the chain where it stopped", () => {
  const r = run("c-resume", {
    repair: "retry",
    faults: [
      { step: "capture_payment", direction: "forward", at: "reject" },
      { step: "void_authorization", direction: "compensate", at: "error" },
      { step: "void_authorization", direction: "compensate", at: "error" },
      { step: "void_authorization", direction: "compensate", at: "error" },
    ],
  });
  assert.equal(r.record.state, "COMPENSATED");
  // cancel_shipment ran before the stop and must not run twice.
  assert.equal(compensatedSteps(r).filter((s) => s === "cancel_shipment").length, 1);
});

test("an operator can close a saga that cannot be compensated", () => {
  const r = run("c-close", {
    repair: "close",
    faults: [
      { step: "capture_payment", direction: "forward", at: "reject" },
      { step: "void_authorization", direction: "compensate", at: "reject", sticky: true },
    ],
  });
  assert.equal(r.record.state, "CLOSED_MANUALLY");
  assert.ok(r.audit.live.length > 0, "closing does not pretend the effects are gone");
});

test("inventory refuses to release units a live shipment depends on", () => {
  const r = run("c-dep", { mutation: "forward-compensation-order", faults: [{ step: "capture_payment", direction: "forward", at: "reject" }] });
  const refusal = r.record.history.find((h) => h.reasonCode === "SHIPMENT_STILL_BOOKED");
  assert.notEqual(refusal, undefined);
});

test("the payment service refuses to void a capture", () => {
  const r = run("c-captured", { mutation: "no-pivot-cancel-check", cancelDuring: "capture_payment" });
  const refusal = r.record.history.find((h) => h.reasonCode === "CANNOT_VOID_CAPTURED");
  assert.notEqual(refusal, undefined);
  assert.equal(r.record.state, "COMPENSATION_FAILED");
});

test("compensating is never attempted for a step after the pivot", () => {
  const r = run("c-nopost", { faults: [{ step: "send_confirmation", direction: "forward", at: "reject" }] });
  assert.equal(compensatedSteps(r).length, 0);
  assert.equal(r.record.state, "MANUAL_REPAIR");
});

test("a compensation command is a forward command to the same participant", () => {
  const r = run("c-wire", { faults: [{ step: "capture_payment", direction: "forward", at: "reject" }] });
  const voided = r.world.allRecords().find((x) => x.step === "void_authorization");
  assert.equal(voided?.participant, "payments");
  assert.equal(voided?.kind, "compensated");
});
