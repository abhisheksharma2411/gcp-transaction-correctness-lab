// The auditor, and whether it is actually independent.
//
// The question asked of every oracle in this programme: if the thing it checks
// were wrong, would this check still pass? These tests answer it by making the
// orchestrator wrong on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";

import { audit, outcomeOf, reconcile } from "../src/audit.ts";
import { SAGA_V1 } from "../src/saga.ts";
import { run } from "../src/matrix.ts";
import type { EffectRecord } from "../src/types.ts";

function rec(step: string, kind: "applied" | "compensated", participant: EffectRecord["participant"]): EffectRecord {
  return { participant, sagaId: "a", step, kind, commandId: `a:${kind}:${step}`, atMs: 0, detail: "" };
}

test("a saga that claims a compensation it never sent is caught", () => {
  const r = run("a-forged", {
    mutation: "orchestrator-forgets-compensation",
    faults: [{ step: "capture_payment", direction: "forward", at: "reject" }],
  });
  assert.equal(r.record.state, "COMPENSATED");
  assert.equal(r.audit.verdict, "UNRESOLVED");
  assert.notEqual(r.disagreement, null);
});

test("the auditor reads no saga record", () => {
  const r = run("a-blind", {});
  // Recomputed from the ledgers alone, with the saga record never consulted.
  const again = audit(SAGA_V1, r.world.allRecords(), "a-blind");
  assert.deepEqual(again, r.audit);
});

test("the auditor ignores other sagas' records", () => {
  const a = run("a-one");
  const mixed = [...a.world.allRecords(), rec("capture_payment", "applied", "payments")];
  const result = audit(SAGA_V1, mixed, "a-one");
  assert.equal(result.verdict, "COMPLETED");
});

test("two applied effects for one step is a violation", () => {
  const rows = [rec("capture_payment", "applied", "payments"), rec("capture_payment", "applied", "payments")];
  const result = audit(SAGA_V1, rows, "a");
  assert.ok(result.violations.some((v) => v.code === "DUPLICATE_EFFECT"));
});

test("a compensation with no effect behind it is a violation", () => {
  const rows = [rec("release_stock", "compensated", "inventory")];
  const result = audit(SAGA_V1, rows, "a");
  assert.ok(result.violations.some((v) => v.code === "COMPENSATION_WITHOUT_EFFECT"));
});

test("undoing anything after the pivot applied is a violation", () => {
  const rows = [
    rec("reserve_stock", "applied", "inventory"),
    rec("capture_payment", "applied", "payments"),
    rec("release_stock", "compensated", "inventory"),
  ];
  const result = audit(SAGA_V1, rows, "a");
  assert.ok(result.violations.some((v) => v.code === "COMPENSATED_AFTER_PIVOT"));
});

test("a capture with no authorization behind it is a violation", () => {
  const rows = SAGA_V1.steps.slice(3).map((s) => rec(s.name, "applied", "payments"));
  const result = audit(SAGA_V1, rows, "a");
  assert.equal(result.verdict, "COMPLETED");
  assert.ok(result.violations.some((v) => v.code === "CAPTURE_WITHOUT_AUTHORIZATION"));
});

test("a compensation record naming nothing in the definition is a violation", () => {
  const rows = [rec("unrefund_everything", "compensated", "payments")];
  const result = audit(SAGA_V1, rows, "a");
  assert.ok(result.violations.some((v) => v.code === "UNKNOWN_COMPENSATION_RECORD"));
});

test("an uncompensated effect is evidence, not a violation", () => {
  const rows = [rec("reserve_stock", "applied", "inventory")];
  const result = audit(SAGA_V1, rows, "a");
  assert.equal(result.verdict, "UNRESOLVED");
  assert.deepEqual(result.live, ["reserve_stock"]);
  assert.deepEqual(result.violations, []);
});

test("reconcile accepts a saga stopped in a state a person owns", () => {
  const rows = [rec("reserve_stock", "applied", "inventory")];
  assert.equal(reconcile("MANUAL_REPAIR", audit(SAGA_V1, rows, "a")), null);
});

test("reconcile accepts a closed saga with live effects", () => {
  const rows = [rec("reserve_stock", "applied", "inventory")];
  assert.equal(reconcile("CLOSED_MANUALLY", audit(SAGA_V1, rows, "a")), null);
});

test("reconcile refuses a COMPLETED claim with no pivot effect", () => {
  const rows = [rec("reserve_stock", "applied", "inventory")];
  assert.notEqual(reconcile("COMPLETED", audit(SAGA_V1, rows, "a")), null);
});

test("reconcile refuses a COMPENSATED claim with a live effect", () => {
  const rows = [rec("reserve_stock", "applied", "inventory")];
  assert.notEqual(reconcile("COMPENSATED", audit(SAGA_V1, rows, "a")), null);
});

test("outcome classes cover every state", () => {
  const seen = new Set(SAGA_V1.states.map(outcomeOf));
  assert.deepEqual([...seen].sort(), ["COMPENSATED", "COMPLETED", "MANUAL", "PENDING"]);
});
