// Leases: the thing that notices a process that stopped.
//
// Every test here is about the gap the version check cannot see. A worker that
// died leaves the entity untouched, so nothing about the stored row is
// suspicious. The only evidence is that somebody claimed responsibility and
// did not come back.

import { test } from "node:test";
import assert from "node:assert/strict";

import { claim, renew, release, isLeased, sweep } from "../src/lease.ts";
import { Runtime, SERVICE, worker } from "../src/runtime.ts";
import { LEASE_TTL_MS, REVIEW_DEADLINE_MS } from "../src/spec.ts";
import { SCENARIOS, T0, MINUTE, HOUR } from "../src/scenarios.ts";

function submitted(crashAt?: "after-commit-before-actions"): Runtime {
  const rt = new Runtime();
  rt.create({
    id: "l", amountMinor: 25_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "c",
  });
  rt.step("l", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  rt.step("l", "submit", SERVICE, T0 + 2 * MINUTE, {
    correlationId: "submit", ...(crashAt === undefined ? {} : { crashAt }),
  });
  return rt;
}

test("a live lease belongs to one owner", () => {
  const rt = submitted();
  const p = rt.get("l");
  const first = claim(p, "worker-a", T0 + 3 * MINUTE);
  assert.equal(first.kind, "CLAIMED");
  if (first.kind !== "CLAIMED") return;
  const second = claim(first.payout, "worker-b", T0 + 4 * MINUTE);
  assert.equal(second.kind, "HELD_BY_OTHER");
});

test("an expired lease may be taken by anyone", () => {
  const rt = submitted();
  const first = claim(rt.get("l"), "worker-a", T0 + 3 * MINUTE);
  assert.equal(first.kind, "CLAIMED");
  if (first.kind !== "CLAIMED") return;
  const second = claim(first.payout, "worker-b", T0 + 3 * MINUTE + LEASE_TTL_MS + 1);
  assert.equal(second.kind, "CLAIMED");
});

test("renewing extends only the holder's own lease", () => {
  const rt = submitted();
  const held = claim(rt.get("l"), "worker-a", T0 + 3 * MINUTE);
  if (held.kind !== "CLAIMED") throw new Error("setup");
  const renewed = renew(held.payout, "worker-a", T0 + 4 * MINUTE);
  assert.equal(renewed.lease?.expiresAtMs, T0 + 4 * MINUTE + LEASE_TTL_MS);
  const notRenewed = renew(held.payout, "worker-b", T0 + 9 * MINUTE);
  assert.equal(notRenewed.lease?.expiresAtMs, held.payout.lease?.expiresAtMs);
});

test("releasing a lease is the only cleanup a shutdown handler has to do", () => {
  const rt = submitted();
  const held = claim(rt.get("l"), "worker-a", T0 + 3 * MINUTE);
  if (held.kind !== "CLAIMED") throw new Error("setup");
  const freed = release(held.payout, "worker-a");
  assert.equal(freed.lease, null);
  assert.equal(isLeased(freed, T0 + 3 * MINUTE), false);
  // Somebody else's release is a no-op, not a theft.
  assert.notEqual(release(held.payout, "worker-b").lease, null);
});

test("a terminal entity cannot be claimed", () => {
  const rt = new Runtime();
  rt.create({
    id: "t", amountMinor: 25_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "c",
  });
  rt.step("t", "cancel", SERVICE, T0 + MINUTE, { correlationId: "x" });
  assert.equal(claim(rt.get("t"), "worker-a", T0 + 2 * MINUTE).kind, "TERMINAL");
});

// --- the stuck record -------------------------------------------------------

test("the version check cannot see a worker that stopped", () => {
  const rt = submitted("after-commit-before-actions");
  const before = rt.get("l");
  // Hours later. Nothing has changed, and nothing about the row says so.
  const later = T0 + 6 * HOUR;
  assert.equal(rt.get("l").version, before.version);
  assert.equal(rt.get("l").state, "SUBMITTED");
  assert.equal(sweep([rt.get("l")], later, REVIEW_DEADLINE_MS).length, 1,
    "the lease is the only thing that can report this");
});

test("the sweep separates a dead worker from a slow provider", () => {
  // One entity whose worker crashed holding the lease.
  const crashed = submitted("after-commit-before-actions");
  const crashedStuck = sweep(crashed.all(), T0 + 2 * MINUTE + LEASE_TTL_MS + 1, REVIEW_DEADLINE_MS);
  assert.equal(crashedStuck[0]?.reason, "LEASE_EXPIRED");

  // One entity simply waiting on a provider: no lease, nothing wrong.
  const waiting = submitted();
  assert.equal(waiting.get("l").lease, null, "a handed-off entity holds no lease");
  assert.equal(sweep(waiting.all(), T0 + 3 * MINUTE, REVIEW_DEADLINE_MS).length, 0);
});

test("a waiting state that outlives its deadline is reported without a lease", () => {
  const rt = new Runtime();
  rt.create({
    id: "r", amountMinor: 900_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "c",
  });
  rt.step("r", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  assert.equal(rt.stateOf("r"), "MANUAL_REVIEW");
  assert.equal(sweep(rt.all(), T0 + HOUR, REVIEW_DEADLINE_MS).length, 0);
  const overdue = sweep(rt.all(), T0 + REVIEW_DEADLINE_MS + 2 * MINUTE, REVIEW_DEADLINE_MS);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0]?.reason, "WAITING_TOO_LONG");
});

test("a terminal entity is never reported as stuck", () => {
  const rt = submitted();
  const token = rt.get("l").callbackToken ?? "";
  rt.callback("l", "settled", token, T0 + HOUR, "cb");
  assert.equal(sweep(rt.all(), T0 + 400 * 86_400_000, REVIEW_DEADLINE_MS).length, 0);
});

// --- recovery ---------------------------------------------------------------

test("a second worker may take over and the entity is not submitted twice", () => {
  const rt = submitted();
  const taken = rt.step("l", "submit", worker("worker-b"), T0 + 3 * MINUTE, { correlationId: "x" });
  assert.equal(taken.outcome.kind, "REFUSED");
  assert.equal(rt.provider.submissionCount, 1);
});

test("recovery re-arms the deadline a crashed worker never set", () => {
  const rt = submitted("after-commit-before-actions");
  assert.equal(rt.timers.pendingCount, 0, "the crash happened before the timer was armed");
  const outcome = rt.recover("l", "worker-b", T0 + 2 * MINUTE + LEASE_TTL_MS + 1);
  assert.equal(outcome, "RECOVERED");
  assert.equal(rt.timers.pendingCount, 1, "the deadline now exists because the state requires it");
  assert.equal(rt.provider.submissionCount, 0, "recovery resumes; it does not repeat the action");
});

test("recovery is refused while another worker's lease is live", () => {
  const rt = submitted("after-commit-before-actions");
  assert.equal(rt.recover("l", "worker-b", T0 + 3 * MINUTE), "HELD_BY_OTHER");
});

test("recovering twice is harmless", () => {
  const rt = submitted("after-commit-before-actions");
  const t = T0 + 2 * MINUTE + LEASE_TTL_MS + 1;
  rt.recover("l", "worker-b", t);
  rt.recover("l", "worker-b", t + 1);
  assert.equal(rt.timers.pendingCount, 1);
  assert.equal(rt.timers.duplicateCreateCount, 1, "the second arming was refused by name");
});

test("S17 is the whole argument in one scenario", () => {
  const t = SCENARIOS.find((s) => s.id === "S17")!.run();
  assert.equal(t.extra["stuckBefore"], 0);
  assert.equal(t.extra["stuckAfter"], 1);
  assert.equal(t.extra["stuckReason"], "LEASE_EXPIRED");
  assert.equal(t.extra["outcome"], "RECOVERED");
  assert.equal(t.extra["rearmed"], 1);
});
