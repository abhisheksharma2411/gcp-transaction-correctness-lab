// Verification of the specification, and verification of the verification.
//
// The second half is the part that matters. A checker that passes everything
// is indistinguishable from no checker at all, so every check here is shown to
// fail against a specification deliberately broken in the way it claims to
// detect.

import { test } from "node:test";
import assert from "node:assert/strict";

import { verify, mutateSpec, SPEC_MUTATIONS, CHECKS } from "../src/verify.ts";
import { SPEC_V1, SPEC_V2 } from "../src/spec.ts";

test("the current specification passes every check", () => {
  for (const f of verify(SPEC_V2)) assert.ok(f.ok, `${f.check}: ${f.detail}`);
});

test("the superseded specification also passes every check", () => {
  // Version 1 is well formed and wrong. Verification is about shape.
  for (const f of verify(SPEC_V1)) assert.ok(f.ok, `${f.check}: ${f.detail}`);
});

test("verification does not catch the defect version 2 was written to fix", () => {
  // Version 1 turns "I cannot find out" into "declined". Every structural
  // check passes. This is the limit of the technique, stated as a test so that
  // nobody reads a green verification run as a correct business process.
  const v1 = SPEC_V1.transitions.find((t) => t.trigger === "lookup_indeterminate");
  assert.equal(v1?.to, "DECLINED");
  assert.ok(verify(SPEC_V1).every((f) => f.ok));
});

test("every declared check runs", () => {
  const ran = verify(SPEC_V2).map((f) => f.check);
  assert.deepEqual([...ran].sort(), [...CHECKS].sort());
});

// --- the negative controls --------------------------------------------------

const EXPECTED: Readonly<Record<string, string>> = {
  "add-unreachable-state": "every-state-reachable",
  "add-exit-from-terminal": "terminal-states-are-sinks",
  "drop-the-review-deadline": "every-waiting-state-has-an-owner-and-deadline",
  "escalate-to-nowhere": "declared-waits-match-the-table",
};

for (const m of SPEC_MUTATIONS) {
  test(`control: ${m} turns ${EXPECTED[m]} red`, () => {
    const findings = verify(mutateSpec(SPEC_V2, m));
    const failed = findings.filter((f) => !f.ok).map((f) => f.check);
    assert.ok(failed.includes(EXPECTED[m]!), `expected ${EXPECTED[m]}, got ${failed.join(", ") || "nothing"}`);
  });

  test(`control: ${m} does not turn every check red`, () => {
    // A mutation blunt enough to redden everything proves nothing about any
    // individual check.
    const failed = verify(mutateSpec(SPEC_V2, m)).filter((f) => !f.ok);
    assert.ok(failed.length < CHECKS.length, `${m} reddened the whole suite`);
  });
}

test("three of the four spec defects are caught by exactly one check", () => {
  const counts = SPEC_MUTATIONS.map(
    (m) => verify(mutateSpec(SPEC_V2, m)).filter((f) => !f.ok).length,
  );
  const targeted = counts.filter((n) => n === 1).length;
  assert.equal(targeted, 3,
    "adding an unreachable state trips three checks at once, which is recorded rather than hidden");
});

test("the terminal-sink check would catch a reopening transition", () => {
  const broken = mutateSpec(SPEC_V2, "add-exit-from-terminal");
  const f = verify(broken).find((x) => x.check === "terminal-states-are-sinks");
  assert.equal(f?.ok, false);
  assert.match(f?.detail ?? "", /SETTLED/);
});

test("a trap state would be caught", () => {
  // A non-terminal state with no path to a terminal state: the payout is
  // neither finished nor visibly broken.
  const trapped = {
    ...SPEC_V2,
    states: [...SPEC_V2.states, "LIMBO" as never],
    transitions: [
      ...SPEC_V2.transitions,
      {
        from: "AUTHORIZED" as never, trigger: "cancel" as never, to: "LIMBO" as never,
        reasonCode: "LOST", guards: [], actions: () => [], note: "deliberate defect",
      },
    ],
  };
  const f = verify(trapped).find((x) => x.check === "every-state-can-terminate");
  assert.equal(f?.ok, false);
  assert.match(f?.detail ?? "", /LIMBO/);
});
