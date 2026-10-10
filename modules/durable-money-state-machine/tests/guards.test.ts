// Guards, and the one guard that matters most: manual review may not bypass a
// financial limit.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Runtime, SERVICE, operator } from "../src/runtime.ts";
import { SPEC_V2, REVIEW_THRESHOLD_MINOR } from "../src/spec.ts";
import { SCENARIOS, T0, MINUTE, HOUR } from "../src/scenarios.ts";

function reviewing(amountMinor: number): Runtime {
  const rt = new Runtime();
  rt.create({
    id: "g", amountMinor, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "c",
  });
  rt.step("g", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  return rt;
}

test("an amount over the limit is routed to review, not approved", () => {
  const rt = reviewing(REVIEW_THRESHOLD_MINOR + 1);
  assert.equal(rt.stateOf("g"), "MANUAL_REVIEW");
  assert.equal(rt.notificationCount, 1);
});

test("an amount exactly at the limit is approved automatically", () => {
  const rt = reviewing(REVIEW_THRESHOLD_MINOR);
  assert.equal(rt.stateOf("g"), "AUTHORIZED");
});

test("a reviewer cannot approve an amount above their own authority", () => {
  const rt = reviewing(900_000);
  const r = rt.step("g", "review_approve", operator("reviewer-small", 100_000), T0 + HOUR, {
    correlationId: "r",
  });
  assert.equal(r.outcome.kind, "REFUSED");
  if (r.outcome.kind !== "REFUSED") return;
  assert.equal(r.outcome.reasonCode, "GUARD_FAILED");
  assert.match(r.outcome.detail, /exceeds reviewer limit/);
  assert.equal(rt.stateOf("g"), "MANUAL_REVIEW");
});

test("the initiator cannot approve their own payout, whatever their authority", () => {
  const rt = reviewing(900_000);
  const r = rt.step("g", "review_approve", operator("initiator-1", 1_000_000_000), T0 + HOUR, {
    correlationId: "r",
  });
  assert.equal(r.outcome.kind, "REFUSED");
  if (r.outcome.kind !== "REFUSED") return;
  assert.match(r.outcome.detail, /initiated this payout/);
});

test("approval returns the payout to AUTHORIZED, never to a terminal state", () => {
  const rt = reviewing(900_000);
  rt.step("g", "review_approve", operator("reviewer-9", 1_000_000), T0 + HOUR, { correlationId: "r" });
  assert.equal(rt.stateOf("g"), "AUTHORIZED");
  assert.equal(rt.provider.submissionCount, 0, "approval is not submission");
  assert.ok(!rt.isTerminal("g"));
});

test("no row in the table lets review reach a terminal state that moves money", () => {
  // The structural version of the test above: a reviewer can cancel, and that
  // is the only terminal state review can reach.
  const fromReview = SPEC_V2.transitions.filter((t) => t.from === "MANUAL_REVIEW");
  const terminals = fromReview.filter((t) => SPEC_V2.terminal.includes(t.to)).map((t) => t.to);
  assert.deepEqual([...new Set(terminals)], ["CANCELLED"]);
});

test("a service account cannot act as a reviewer and a reviewer cannot act as a service", () => {
  const rt = reviewing(900_000);
  const asService = rt.step("g", "review_approve", SERVICE, T0 + HOUR, { correlationId: "r1" });
  assert.equal(asService.outcome.kind, "REFUSED");
  const rt2 = new Runtime();
  rt2.create({
    id: "h", amountMinor: 25_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "c",
  });
  const asOperator = rt2.step("h", "authorize", operator("reviewer-9", 1_000_000), T0 + MINUTE, {
    correlationId: "r2",
  });
  assert.equal(asOperator.outcome.kind, "REFUSED");
});

test("every guard named in the table is defined, and every defined guard is used", () => {
  const used = new Set(SPEC_V2.transitions.flatMap((t) => t.guards));
  for (const name of used) assert.ok(SPEC_V2.guards[name] !== undefined, `undefined guard ${name}`);
  for (const name of Object.keys(SPEC_V2.guards)) {
    assert.ok(used.has(name), `guard ${name} is defined but never used`);
  }
});

test("S04 and S05 demonstrate the guard end to end", () => {
  const s04 = SCENARIOS.find((s) => s.id === "S04")!.run();
  assert.equal(s04.finalState, "MANUAL_REVIEW");
  assert.equal(s04.providerSubmissions, 0);
  const s05 = SCENARIOS.find((s) => s.id === "S05")!.run();
  assert.equal(s05.extra["stateAfterApproval"], "AUTHORIZED");
});
