// Crashes, restarts and redeliveries.
//
// The claim these tests exist to support is narrow and checkable: whatever
// instant the process dies at, the recorded state afterwards is a state the
// specification contains, and the provider is asked to move money at most
// once.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Runtime, SERVICE, CRASH_POINTS } from "../src/runtime.ts";
import type { CrashPoint } from "../src/runtime.ts";
import { SPEC_V2, CALLBACK_DEADLINE_MS, LEASE_TTL_MS } from "../src/spec.ts";
import { replayState } from "../src/machine.ts";
import { SCENARIOS, T0, MINUTE, HOUR } from "../src/scenarios.ts";

function crashAtSubmit(point: CrashPoint): Runtime {
  const rt = new Runtime();
  rt.create({
    id: "c", amountMinor: 25_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "create",
  });
  rt.step("c", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  rt.step("c", "submit", SERVICE, T0 + 2 * MINUTE, { correlationId: "submit-1", crashAt: point });
  return rt;
}

for (const point of CRASH_POINTS) {
  test(`crash at ${point}: the recorded state is a state the specification contains`, () => {
    const rt = crashAtSubmit(point);
    assert.ok(SPEC_V2.states.includes(rt.get("c").state));
    assert.equal(replayState(rt.get("c").history), rt.get("c").state);
  });

  test(`crash at ${point}: the redelivered task does not submit a second time`, () => {
    const rt = crashAtSubmit(point);
    // The task was never acknowledged, so Cloud Tasks delivers it again.
    rt.step("c", "submit", SERVICE, T0 + 4 * MINUTE, { correlationId: "submit-1" });
    assert.ok(rt.provider.submissionCount <= 1,
      `${point} produced ${rt.provider.submissionCount} submissions`);
  });
}

test("crash before commit: nothing happened, and the retry is a first attempt", () => {
  const rt = crashAtSubmit("before-commit");
  assert.equal(rt.stateOf("c"), "AUTHORIZED");
  assert.equal(rt.provider.submissionCount, 0);
  rt.step("c", "submit", SERVICE, T0 + 4 * MINUTE, { correlationId: "submit-1" });
  assert.equal(rt.stateOf("c"), "SUBMITTED");
  assert.equal(rt.provider.submissionCount, 1);
});

test("crash after commit, before the action: the record claims a submission that never happened", () => {
  const rt = crashAtSubmit("after-commit-before-actions");
  assert.equal(rt.stateOf("c"), "SUBMITTED");
  assert.equal(rt.provider.submissionCount, 0, "this is the uncomfortable row");
  assert.equal(rt.timers.pendingCount, 0, "and no deadline was armed either");
});

test("the deadline is what discovers the claim that never happened", () => {
  const rt = crashAtSubmit("after-commit-before-actions");
  rt.recover("c", "worker-b", T0 + 2 * MINUTE + LEASE_TTL_MS + 1);
  assert.equal(rt.timers.pendingCount, 1);
  rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + HOUR);
  assert.equal(rt.stateOf("c"), "RECONCILING");
  rt.resolve("c", T0 + CALLBACK_DEADLINE_MS + HOUR + MINUTE, "resolve");
  assert.equal(rt.stateOf("c"), "MANUAL_REVIEW",
    "an indeterminate lookup acquires a human owner rather than a guess");
  assert.equal(rt.provider.submissionCount, 0);
});

test("crash after the action, before the acknowledgement: the redelivery finds a payout that moved", () => {
  const rt = crashAtSubmit("after-actions-before-ack");
  assert.equal(rt.stateOf("c"), "SUBMITTED");
  assert.equal(rt.provider.submissionCount, 1);
  const again = rt.step("c", "submit", SERVICE, T0 + 4 * MINUTE, { correlationId: "submit-1" });
  assert.equal(again.outcome.kind, "REFUSED");
  if (again.outcome.kind !== "REFUSED") return;
  assert.equal(again.outcome.reasonCode, "NO_SUCH_TRANSITION",
    "the recorded state, not a deduplication table, is what refuses the repeat");
  assert.equal(rt.provider.submissionCount, 1);
});

test("committing before acting is the lesser of the two orderings", () => {
  // Acting first and committing second would mean a crash between them leaves
  // the payout in AUTHORIZED with money already moving, and the next worker
  // submits again. The module does not implement that ordering; this test
  // records what it would cost, by constructing it by hand.
  const rt = new Runtime();
  rt.create({
    id: "d", amountMinor: 25_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "create",
  });
  rt.step("d", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  // "act first": perform the provider call without committing anything.
  rt.provider.submit("d", "cbt-d-hand-rolled", "settled");
  // Then the crash, then the retry, which sees an AUTHORIZED payout.
  rt.step("d", "submit", SERVICE, T0 + 4 * MINUTE, { correlationId: "submit-1" });
  assert.equal(rt.provider.submissionCount, 2, "two payments, which is the ordering we rejected");
});

test("no crash point leaves the entity in a state with no way out", () => {
  for (const point of CRASH_POINTS) {
    const rt = crashAtSubmit(point);
    const state = rt.get("c").state;
    if (SPEC_V2.terminal.includes(state)) continue;
    const hasExit = SPEC_V2.transitions.some((t) => t.from === state);
    assert.ok(hasExit, `${point} left the entity in ${state}, which has no outgoing transition`);
  }
});

test("S15 and S16 are the two crash windows end to end", () => {
  const s15 = SCENARIOS.find((s) => s.id === "S15")!.run();
  assert.equal(s15.extra["afterCrash"], "AUTHORIZED");
  assert.equal(s15.providerSubmissions, 1);
  const s16 = SCENARIOS.find((s) => s.id === "S16")!.run();
  assert.equal(s16.extra["afterCrash"], "SUBMITTED");
  assert.equal(s16.providerSubmissions, 1);
});
