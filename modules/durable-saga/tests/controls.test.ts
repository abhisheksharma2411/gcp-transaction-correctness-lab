// Negative controls, and a control on the controls.
//
// Everything in this file exists because the suite passed on its first run,
// which proves very little when one author writes both the implementation and
// the expectations. Each mechanism is removed in turn and a named observable
// has to change.

import { test } from "node:test";
import assert from "node:assert/strict";

import { EXPECTED_SIGNAL, allControls, controlFor, observe, render } from "../src/controls.ts";
import { MUTATIONS, SPEC_MUTATIONS } from "../src/policy.ts";
import { mutateDefinition } from "../src/mutate.ts";
import { SAGA_V1, verifyDefinition } from "../src/saga.ts";
import { run } from "../src/matrix.ts";

const controls = allControls();

test("the unmutated definition passes every static check", () => {
  for (const f of verifyDefinition(SAGA_V1)) assert.equal(f.ok, true, f.check);
});

for (const m of SPEC_MUTATIONS) {
  test(`spec control: ${m} turns a check red`, () => {
    const failed = verifyDefinition(mutateDefinition(m)).filter((f) => !f.ok).map((f) => f.check);
    assert.ok(failed.length > 0, `${m} changed nothing`);
  });
}

test("spec control: two-pivots is caught by the pivot check specifically", () => {
  const failed = verifyDefinition(mutateDefinition("two-pivots")).filter((f) => !f.ok).map((f) => f.check);
  assert.ok(failed.includes("exactly-one-pivot"));
});

test("spec control: a compensation after the pivot is caught specifically", () => {
  const failed = verifyDefinition(mutateDefinition("compensation-after-pivot")).filter((f) => !f.ok).map((f) => f.check);
  assert.ok(failed.includes("nothing-after-the-pivot-is-compensated"));
});

test("spec control: an irreversible step before the pivot is caught specifically", () => {
  const failed = verifyDefinition(mutateDefinition("irreversible-before-pivot")).filter((f) => !f.ok).map((f) => f.check);
  assert.ok(failed.includes("irreversible-steps-sit-after-the-pivot"));
});

test("spec control: a way out of a terminal state is caught specifically", () => {
  const failed = verifyDefinition(mutateDefinition("terminal-state-with-an-exit")).filter((f) => !f.ok).map((f) => f.check);
  assert.ok(failed.includes("terminal-states-are-sinks"));
});

for (const c of controls) {
  test(`control: removing ${c.mutation} changes what the probe observes`, () => {
    assert.equal(c.changed, true,
      `${c.mutation} changed nothing: ${render(c.baseline)}`);
  });
}

test("control: without participant de-duplication a duplicate effect appears", () => {
  const c = controlFor("no-step-dedupe");
  assert.deepEqual(c.baseline.violations, []);
  assert.ok(c.mutated.violations.includes("DUPLICATE_EFFECT"));
  assert.equal(c.mutated.effects, c.baseline.effects + 1);
});

test("control: compensating only confirmed steps leaks a booking", () => {
  const c = controlFor("compensate-only-confirmed");
  assert.equal(c.baseline.agreed, true);
  assert.equal(c.mutated.agreed, false);
  assert.equal(c.mutated.effects, c.baseline.effects + 1);
});

test("control: compensating in forward order stops the chain", () => {
  const c = controlFor("forward-compensation-order");
  assert.equal(c.baseline.state, "COMPENSATED");
  assert.equal(c.mutated.state, "COMPENSATION_FAILED");
});

test("control: without the wait check a stale answer is not refused", () => {
  const c = controlFor("no-wait-correlation");
  assert.ok(c.baseline.refusals.includes("NO_WAIT_OUTSTANDING"));
  assert.equal(c.mutated.refusals.includes("NO_WAIT_OUTSTANDING"), false);
});

test("control: without the pivot guard a committed saga starts undoing itself", () => {
  const c = controlFor("no-pivot-cancel-check");
  assert.equal(c.baseline.state, "COMPLETED");
  assert.equal(c.mutated.state, "COMPENSATION_FAILED");
  assert.ok(c.mutated.violations.includes("COMPENSATED_AFTER_PIVOT"));
});

test("control: resolving compensations against the current version loses one", () => {
  const c = controlFor("compensate-with-current-spec");
  assert.equal(c.baseline.state, "COMPENSATED");
  assert.equal(c.mutated.state, "COMPENSATION_FAILED");
});

test("control: without an attempt cap the saga never stops compensating", () => {
  const c = controlFor("no-attempt-cap");
  assert.equal(c.baseline.state, "COMPENSATION_FAILED");
  assert.equal(c.mutated.state, "COMPENSATING");
});

test("control: a forged compensation record is caught by the ledgers", () => {
  const c = controlFor("orchestrator-forgets-compensation");
  assert.equal(c.baseline.verdict, "COMPENSATED");
  assert.equal(c.mutated.verdict, "UNRESOLVED");
  assert.equal(c.mutated.state, "COMPENSATED");
});

test("every mutation has an expected signal written down", () => {
  for (const m of MUTATIONS) assert.ok(EXPECTED_SIGNAL[m].length > 20, m);
});

// --- the control on the controls -------------------------------------------

test("harness guard: an unmutated probe is stable across runs", () => {
  const a = observe(run("h-stable-1"));
  const b = observe(run("h-stable-2"));
  assert.equal(render(a).replace(/-1/g, ""), render(b).replace(/-2/g, ""));
});

test("harness guard: the observable notices a changed final state", () => {
  const clean = observe(run("h-clean"));
  const broken = observe(run("h-broken", { faults: [{ step: "reserve_stock", direction: "forward", at: "reject" }] }));
  assert.notEqual(render(clean), render(broken));
});

test("harness guard: the observable notices a changed effect count", () => {
  const clean = observe(run("h-six"));
  const fewer = observe(run("h-two", { cancelWhileWaiting: true }));
  assert.notEqual(clean.effects, fewer.effects);
});

test("harness guard: no mutation is silently unused", () => {
  assert.equal(controls.length, MUTATIONS.length);
  assert.equal(new Set(controls.map((c) => c.mutation)).size, MUTATIONS.length);
});
