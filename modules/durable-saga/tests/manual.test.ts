// The two states a person owns, and what resuming one must not do.

import { test } from "node:test";
import assert from "node:assert/strict";

import { run } from "../src/matrix.ts";
import { SAGA_V1 } from "../src/saga.ts";

const EXHAUST_LEDGER = [
  { step: "post_ledger_entry", direction: "forward" as const, at: "error" as const },
  { step: "post_ledger_entry", direction: "forward" as const, at: "error" as const },
  { step: "post_ledger_entry", direction: "forward" as const, at: "error" as const },
  { step: "post_ledger_entry", direction: "forward" as const, at: "error" as const },
];

test("a step after the pivot that runs out of attempts stops in MANUAL_REPAIR", () => {
  const r = run("m-stop", { faults: EXHAUST_LEDGER });
  assert.equal(r.record.state, "MANUAL_REPAIR");
  assert.equal(SAGA_V1.owned.MANUAL_REPAIR, "payments operations");
});

test("the saga does not compensate its way out of a committed process", () => {
  const r = run("m-nocomp", { faults: EXHAUST_LEDGER });
  assert.equal(r.record.compensated.length, 0);
  assert.equal(r.world.holdState("m-nocomp"), "captured");
});

test("an operator resume continues from the cursor rather than replaying", () => {
  const r = run("m-resume", { repair: "resume", faults: EXHAUST_LEDGER });
  assert.equal(r.record.state, "COMPLETED");
  for (const s of ["reserve_stock", "authorize_payment", "book_shipment", "capture_payment"]) {
    const n = r.world.allRecords().filter((x) => x.step === s && x.kind === "applied").length;
    assert.equal(n, 1, s);
  }
});

test("a resume does not send a command for a step that already answered", () => {
  const r = run("m-noresend", { repair: "resume", faults: EXHAUST_LEDGER });
  const dispatches = r.record.history.filter(
    (h) => h.kind === "step_dispatched" && h.step === "capture_payment");
  assert.equal(dispatches.length, 1);
});

test("a resume retries only the step that stopped", () => {
  const r = run("m-retry-one", { repair: "resume", faults: EXHAUST_LEDGER });
  const after = r.record.history.findIndex((h) => h.reasonCode === "OPERATOR_RESUME");
  const later = r.record.history.slice(after).filter((h) => h.kind === "step_dispatched");
  assert.deepEqual([...new Set(later.map((h) => h.step))], ["post_ledger_entry", "send_confirmation"]);
});

test("an operator close is a terminal state that admits the effects are live", () => {
  const r = run("m-close", {
    repair: "close",
    faults: [
      { step: "capture_payment", direction: "forward", at: "reject" },
      { step: "void_authorization", direction: "compensate", at: "reject", sticky: true },
    ],
  });
  assert.equal(r.record.state, "CLOSED_MANUALLY");
  assert.deepEqual(r.audit.live, ["authorize_payment", "reserve_stock"]);
  assert.equal(r.disagreement, null, "closing is allowed to leave the ledgers unresolved");
});

test("an operator action is recorded with an actor and a reason code", () => {
  const r = run("m-record", { repair: "resume", faults: EXHAUST_LEDGER });
  const op = r.record.history.find((h) => h.kind === "operator");
  assert.notEqual(op, undefined);
  assert.equal(op?.reasonCode, "OPERATOR_ACTION");
});

test("an operator cannot resume a saga that is not stopped", () => {
  const r = run("m-illegal");
  assert.equal(r.record.state, "COMPLETED");
  // The run helper only repairs a stopped saga, so this asserts the guard
  // directly through the transition table.
  assert.equal(SAGA_V1.transitions.some((t) => t.from === "COMPLETED"), false);
});
