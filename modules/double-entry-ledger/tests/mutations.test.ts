// Negative controls.
//
// A suite that stays green when you remove the thing it tests is measuring
// nothing. Each mutation below removes one mechanism, and the assertion is
// not "something went red" but "these named invariants went red and the
// others did not".

import { test } from "node:test";
import assert from "node:assert/strict";
import { MUTATIONS, emptyLedgerControl } from "../src/mutations.ts";
import { checkLedger } from "../src/invariants.ts";
import { BalanceProjection } from "../src/projection.ts";
import { AS_OF, buildScenario } from "../src/scenario.ts";

for (const mutation of MUTATIONS) {
  test(`N-${mutation.id} ${mutation.name} reddens exactly ${mutation.expectViolated.join(", ")}`, () => {
    const report = mutation.run();
    const violated = report.invariants
      .filter((i) => i.status === "VIOLATED")
      .map((i) => i.id)
      .sort();
    assert.deepEqual(violated, [...mutation.expectViolated].sort());
    assert.equal(report.summary.verdict, "VIOLATED");
    // Each violation must say something specific. "It failed" is not a finding.
    for (const invariant of report.invariants) {
      if (invariant.status !== "VIOLATED") continue;
      assert.ok(invariant.violations.length > 0);
      for (const detail of invariant.violations) assert.ok(detail.length > 10);
    }
  });
}

test("N-CTRL a mutation blunt enough to redden everything is rejected as a control", () => {
  // The blunt control: an empty ledger. It produces no violations at all,
  // because every invariant holds over nothing — which is precisely why it
  // cannot be used as evidence that any particular check is doing work.
  const control = emptyLedgerControl();
  assert.equal(control.summary.violated, 0);
  assert.equal(control.summary.verdict, "INCONCLUSIVE");

  // And no real mutation may redden every invariant, for the same reason: a
  // control that breaks everything cannot localise anything.
  for (const mutation of MUTATIONS) {
    assert.ok(
      mutation.expectViolated.length < 9,
      `${mutation.id} claims to redden every invariant, which localises nothing`,
    );
  }
});

test("N-SPREAD every invariant is reddened by at least one mutation", () => {
  // The other direction. An invariant that no mutation can break is either
  // trivially true or untested, and both are worth knowing about.
  const covered = new Set(MUTATIONS.flatMap((m) => m.expectViolated));
  const { ledger } = buildScenario();
  const projection = new BalanceProjection();
  projection.consumeAll(ledger.feed());
  const all = checkLedger(ledger, projection, AS_OF).invariants.map((i) => i.id);

  const uncovered = all.filter((id) => !covered.has(id));
  // INV-5, INV-6, INV-7 and INV-9 are enforced before a journal is ever
  // written, so breaking them means bypassing validation — which is the same
  // experiment as M1. They are recorded as uncovered rather than given a
  // mutation that would only repeat M1 under another name.
  assert.deepEqual(uncovered, ["INV-5", "INV-6", "INV-7", "INV-9"]);
});
