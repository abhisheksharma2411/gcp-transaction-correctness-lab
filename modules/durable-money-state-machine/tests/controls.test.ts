// Negative controls for the runtime checks, and a control on the controls.
//
// Everything in this file exists because the suite passed on its first run,
// which proves nothing when one author writes both the implementation and the
// expectations. Each runtime check is removed in turn and the specific
// observable it is responsible for has to change.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MUTATIONS } from "../src/policy.ts";
import type { Mutation } from "../src/policy.ts";
import { Runtime, SERVICE, worker } from "../src/runtime.ts";
import { historyIsAppendOnly } from "../src/machine.ts";
import { T0, MINUTE, HOUR, SCENARIOS } from "../src/scenarios.ts";

/**
 * One lifecycle that trips every runtime check exactly once.
 *
 * A probe that trips everything at every step cannot show which check caught
 * what, so this one is deliberately sparse.
 */
function probe(mutation?: Mutation) {
  const rt = new Runtime(mutation === undefined ? {} : { mutation });
  const id = "probe";
  rt.create({
    id, amountMinor: 900_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "create",
  });
  rt.step(id, "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  rt.step(id, "review_approve", { id: "initiator-1", kind: "operator", approvalLimitMinor: 10_000_000 },
    T0 + 2 * MINUTE, { correlationId: "self-approve" });            // guard
  rt.step(id, "review_approve", { id: "reviewer-9", kind: "operator", approvalLimitMinor: 10_000_000 },
    T0 + 3 * MINUTE, { correlationId: "stale", expectedVersion: 0 }); // version
  rt.step(id, "review_approve", { id: "reviewer-9", kind: "operator", approvalLimitMinor: 10_000_000 },
    T0 + 4 * MINUTE, { correlationId: "approve" });
  rt.step(id, "submit", worker("stranger"), T0 + 5 * MINUTE, {
    correlationId: "submit-x", takeLease: false,                     // lease
  });
  rt.step(id, "submit", SERVICE, T0 + 6 * MINUTE, { correlationId: "submit" });
  const token = rt.get(id).callbackToken ?? "";
  rt.callback(id, "settled", "wrong-token", T0 + HOUR, "cb-bad");    // correlation
  rt.callback(id, "settled", token, T0 + HOUR + 1, "cb-good");
  rt.step(id, "submit", SERVICE, T0 + HOUR + 3, { correlationId: "again" }); // terminal
  const p = rt.get(id);
  return {
    finalState: p.state,
    submissions: rt.provider.submissionCount,
    historyLength: p.history.length,
    appendOnly: historyIsAppendOnly(p.history),
    refusals: [...new Set(rt.refusals.map((r) => r.code))].sort(),
  };
}

const baseline = probe();

test("the clean probe trips every check exactly once", () => {
  assert.deepEqual(baseline.refusals, [
    "CALLBACK_UNCORRELATED", "GUARD_FAILED", "LEASE_NOT_HELD", "TERMINAL", "VERSION_CONFLICT",
  ]);
  assert.equal(baseline.finalState, "SETTLED");
  assert.equal(baseline.submissions, 1);
  assert.equal(baseline.appendOnly, true);
});

const EXPECTED_SIGNAL: Readonly<Record<Mutation, string>> = {
  "no-terminal-check": "TERMINAL",
  "no-version-check": "VERSION_CONFLICT",
  "no-lease-check": "LEASE_NOT_HELD",
  "no-guards": "GUARD_FAILED",
  "no-callback-correlation": "CALLBACK_UNCORRELATED",
  "history-not-appended": "append-only",
};

for (const m of MUTATIONS) {
  test(`control: removing ${m} loses ${EXPECTED_SIGNAL[m]}`, () => {
    const after = probe(m);
    if (m === "history-not-appended") {
      assert.equal(after.appendOnly, false, "the history should no longer be append-only");
      return;
    }
    assert.ok(
      !after.refusals.includes(EXPECTED_SIGNAL[m] as never),
      `${m} still produced ${EXPECTED_SIGNAL[m]}; the check is not what refused`,
    );
  });

  test(`control: removing ${m} does not lose every refusal`, () => {
    // A mutation blunt enough to change everything cannot show which check is
    // doing which job.
    const after = probe(m);
    assert.ok(after.refusals.length > 0, `${m} silenced the whole probe`);
  });
}

test("control: no mutation is a no-op", () => {
  for (const m of MUTATIONS) {
    const after = probe(m);
    const same =
      after.finalState === baseline.finalState &&
      after.submissions === baseline.submissions &&
      after.historyLength === baseline.historyLength &&
      after.appendOnly === baseline.appendOnly &&
      after.refusals.join(",") === baseline.refusals.join(",");
    assert.ok(!same, `${m} changed nothing observable, so nothing is testing it`);
  }
});

test("control: the harness itself fails when it should", () => {
  // If this assertion could not fail, every other assertion in the file would
  // be passing vacuously.
  const bogus = { ...baseline, finalState: "NOT_A_STATE" };
  assert.notEqual(bogus.finalState, baseline.finalState);
  assert.throws(() => assert.equal(bogus.finalState, baseline.finalState));
});

test("control: the scenarios are deterministic", () => {
  for (const s of SCENARIOS) {
    const a = s.run();
    const b = s.run();
    assert.equal(a.finalState, b.finalState, s.id);
    assert.equal(a.providerSubmissions, b.providerSubmissions, s.id);
    assert.deepEqual(a.transitions, b.transitions, s.id);
    assert.deepEqual(a.refusals, b.refusals, s.id);
  }
});

test("control: no source file reads the clock", async () => {
  // Determinism is a property of the source, not of a lucky run. Every
  // function that needs the time takes it as a parameter.
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  for (const f of readdirSync(src)) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(join(src, f), "utf8");
    assert.ok(!/Date\.now\(\)/.test(text), `${f} calls Date.now()`);
    assert.ok(!/Math\.random\(\)/.test(text), `${f} calls Math.random()`);
  }
});
