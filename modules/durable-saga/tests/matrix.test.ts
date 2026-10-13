// The failure matrix, as a property rather than as a table.

import { test } from "node:test";
import assert from "node:assert/strict";

import { INJECTIONS, failureMatrix, tally } from "../src/matrix.ts";
import { SAGA_V1 } from "../src/saga.ts";
import { SCENARIOS } from "../src/scenarios.ts";

const rows = failureMatrix();

test("the matrix covers every step at every injection point", () => {
  for (const s of SAGA_V1.steps) {
    for (const i of INJECTIONS) {
      assert.ok(
        rows.some((r) => r.direction === "forward" && r.step === s.name && r.injection === i),
        `${s.name}/${i}`,
      );
    }
  }
});

test("the matrix covers every compensation being refused", () => {
  for (const s of SAGA_V1.steps) {
    if (s.compensation === null) continue;
    assert.ok(rows.some((r) => r.direction === "compensate" && r.step === s.compensation), s.name);
  }
});

test("no run produces a duplicate protected effect", () => {
  for (const r of rows) assert.equal(r.duplicateEffects, 0, `${r.step}/${r.injection}`);
});

test("the saga's account and the ledgers agree on every row", () => {
  for (const r of rows) assert.equal(r.agreed, true, `${r.step}/${r.injection}: ${r.disagreement}`);
});

test("every row reaches a state the definition declares", () => {
  for (const r of rows) assert.ok(SAGA_V1.states.includes(r.finalState), r.finalState);
});

test("no row is left running", () => {
  assert.equal(tally(rows).PENDING, 0);
});

test("every outcome class except PENDING occurs", () => {
  const t = tally(rows);
  assert.ok(t.COMPLETED > 0);
  assert.ok(t.COMPENSATED > 0);
  assert.ok(t.MANUAL > 0);
});

test("a failure before the pivot never reaches a COMPLETED outcome", () => {
  const pre = rows.filter(
    (r) => r.direction === "forward"
      && SAGA_V1.steps.findIndex((s) => s.name === r.step) < SAGA_V1.steps.findIndex((s) => s.pivot)
      && (r.injection === "reject" || r.injection === "error-repeated"),
  );
  assert.ok(pre.length >= 6);
  for (const r of pre) assert.equal(r.outcome, "COMPENSATED", `${r.step}/${r.injection}`);
});

test("a final refusal after the pivot never compensates", () => {
  const post = rows.filter(
    (r) => r.direction === "forward" && r.injection === "reject"
      && SAGA_V1.steps.findIndex((s) => s.name === r.step) > SAGA_V1.steps.findIndex((s) => s.pivot),
  );
  assert.ok(post.length >= 2);
  for (const r of post) assert.equal(r.outcome, "MANUAL", r.step);
});

test("a refused compensation always stops in a state a person owns", () => {
  for (const r of rows.filter((x) => x.direction === "compensate")) {
    assert.equal(r.finalState, "COMPENSATION_FAILED", r.step);
  }
});

test("the matrix is deterministic", () => {
  const again = failureMatrix();
  assert.deepEqual(again, rows);
});

test("every scenario is deterministic", () => {
  for (const s of SCENARIOS) {
    const a = s.run();
    const b = s.run();
    assert.equal(a.record.state, b.record.state, s.id);
    assert.deepEqual(a.record.history, b.record.history, s.id);
    assert.deepEqual(a.world.allRecords(), b.world.allRecords(), s.id);
  }
});

test("every scenario agrees with the ledgers", () => {
  for (const s of SCENARIOS) {
    const r = s.run();
    assert.equal(r.disagreement, null, `${s.id}: ${r.disagreement}`);
  }
});

test("every scenario covers something the others do not", () => {
  const covers = SCENARIOS.map((s) => s.covers);
  assert.equal(new Set(covers).size, covers.length);
});

test("no scenario leaves money captured without the saga completing", () => {
  for (const s of SCENARIOS) {
    const r = s.run();
    if (r.world.holdState(s.id.toLowerCase()) !== "captured") continue;
    assert.ok(["COMPLETED", "PIVOTED", "MANUAL_REPAIR", "CLOSED_MANUALLY"].includes(r.record.state), s.id);
  }
});
