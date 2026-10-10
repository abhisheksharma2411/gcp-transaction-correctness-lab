// The invariant checker, and the harness that guards it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLedger } from "../src/invariants.ts";
import { BalanceProjection } from "../src/projection.ts";
import { AS_OF, buildScenario } from "../src/scenario.ts";
import { emptyLedgerControl } from "../src/mutations.ts";

function reportForScenario() {
  const { ledger } = buildScenario();
  const projection = new BalanceProjection();
  projection.consumeAll(ledger.feed());
  return checkLedger(ledger, projection, AS_OF);
}

test("I01 the demo ledger satisfies every invariant", () => {
  const report = reportForScenario();
  assert.equal(report.summary.violated, 0);
  assert.equal(report.summary.verdict, "PROVEN");
});

test("I02 every invariant examined something", () => {
  // The check that stops the report being reassuring by default. An invariant
  // that holds over an empty population has proven nothing, and it looks
  // exactly like one that did real work.
  const report = reportForScenario();
  for (const invariant of report.invariants) {
    assert.ok(
      invariant.population > 0,
      `${invariant.id} examined ${invariant.population} items; a vacuous pass is not a pass`,
    );
    assert.equal(invariant.status, "HOLDS");
  }
});

test("I03 an empty ledger is INCONCLUSIVE, not PROVEN", () => {
  const control = emptyLedgerControl();
  assert.equal(control.summary.violated, 0);
  assert.equal(control.summary.vacuous, control.summary.checked);
  assert.equal(control.summary.verdict, "INCONCLUSIVE");
});

test("I04 the report is deterministic across runs", () => {
  const first = reportForScenario();
  const second = reportForScenario();
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.invariants, second.invariants);
});

test("I05 every invariant says what it uniquely covers", () => {
  const report = reportForScenario();
  const covers = report.invariants.map((i) => i.covers);
  assert.equal(new Set(covers).size, covers.length);
  for (const invariant of report.invariants) {
    assert.ok(invariant.covers.length > 20, `${invariant.id} has no description worth reading`);
  }
});

test("I06 the nine invariants are the nine the report claims", () => {
  const report = reportForScenario();
  assert.deepEqual(
    report.invariants.map((i) => i.id),
    ["INV-1", "INV-2", "INV-3", "INV-4", "INV-5", "INV-6", "INV-7", "INV-8", "INV-9"],
  );
  assert.equal(report.summary.checked, 9);
});

test("I07 the reversal invariant examined a real reversal", () => {
  const report = reportForScenario();
  const inv5 = report.invariants.find((i) => i.id === "INV-5");
  assert.ok(inv5 !== undefined);
  assert.equal(inv5.population, 1);
});

test("I08 the trial balance invariant examined both currencies", () => {
  const report = reportForScenario();
  const inv8 = report.invariants.find((i) => i.id === "INV-8");
  assert.ok(inv8 !== undefined);
  assert.equal(inv8.population, 2);
});
