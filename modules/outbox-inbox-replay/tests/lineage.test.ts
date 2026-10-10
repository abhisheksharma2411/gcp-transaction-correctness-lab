// The verifier, and the controls that stop it being decorative.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CONTROLS, runControls, standardRun } from "../src/controls.ts";
import { formatFindings, verifyLineage } from "../src/lineage.ts";
import { Trace } from "../src/trace.ts";
import { FINDING_CODES } from "../src/types.ts";

test("V01 the standard run is clean", () => {
  const run = standardRun();
  assert.deepEqual(run.detail, []);
});

test("V02 the standard run actually exercises something", () => {
  // A verifier that reports clean against an empty run is reporting nothing.
  const run = standardRun();
  const trace = run.world.trace;
  assert.ok(trace.count("commit") >= 5, "commits");
  assert.ok(trace.count("publish") >= 5, "publishes");
  assert.ok(trace.count("deliver") >= 10, "deliveries");
  assert.ok(trace.count("effect") >= 5, "effects");
  assert.ok(trace.count("dead-letter") >= 2, "dead letters");
  assert.ok(trace.count("replay-publish") >= 2, "replayed events");
  assert.equal(run.protectedEffects, run.effectApplications, "nothing was applied twice");
});

test("V03 an empty run reports nothing, which is why V02 exists", () => {
  const report = verifyLineage({ trace: new Trace(), knownEvents: [], expectedConsumers: [] });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.checked, { commits: 0, events: 0, publishes: 0, deliveries: 0, effects: 0 });
});

for (const control of CONTROLS.filter((c) => c.mustBeRejected !== true)) {
  test(`V04 control '${control.name}' produces exactly its stated findings`, () => {
    const produced = [...new Set(standardRun(control.options).codes)].sort();
    assert.deepEqual(produced, [...control.expect].sort(), formatFindings([]).join(""));
  });
}

test("V05 a control blunt enough to redden several unrelated checks is rejected", () => {
  const blunt = runControls().find((c) => c.mustBeRejected);
  assert.ok(blunt !== undefined);
  assert.equal(blunt.blunt, true, "the blunt control must be recognised as blunt");
  assert.ok(blunt.produced.length >= 3);
});

test("V06 every finding code has a control that provokes it", () => {
  const provoked = new Set(CONTROLS.flatMap((c) => c.expect));
  const uncovered = FINDING_CODES.filter((c) => !provoked.has(c));
  assert.deepEqual(uncovered, []);
});

test("V07 every control is detected by the code it claims to provoke", () => {
  const missed = runControls()
    .filter((c) => !c.mustBeRejected)
    .filter((c) => !c.detected)
    .map((c) => c.name);
  assert.deepEqual(missed, []);
});

test("V08 the verifier reads the trace, so a mechanism that leaves no record is invisible", () => {
  // Not a bug: a stated limitation, pinned so it cannot drift into a claim.
  const run = standardRun();
  const silent = verifyLineage({
    trace: new Trace(),
    knownEvents: run.world.source.eventLog(),
    expectedConsumers: ["inventory", "notifications"],
  });
  const codes = [...new Set(silent.findings.map((f) => f.code))];
  assert.deepEqual(codes, ["L02_PHANTOM_EVENT"]);
});
