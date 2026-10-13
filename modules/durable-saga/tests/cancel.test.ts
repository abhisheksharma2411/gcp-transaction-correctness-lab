// Cancellation, and the race it can lose.

import { test } from "node:test";
import assert from "node:assert/strict";

import { T0, run } from "../src/matrix.ts";
import { DelayQueue, Orchestrator, SagaStore } from "../src/orchestrator.ts";
import { World } from "../src/participants.ts";

test("a cancellation before the pivot runs the compensation chain", () => {
  const r = run("x-before", { cancelWhileWaiting: true });
  assert.equal(r.record.state, "COMPENSATED");
  const t = r.record.history.find((h) => h.reasonCode === "CANCELLED_BEFORE_PIVOT");
  assert.notEqual(t, undefined);
});

test("a cancellation in flight while the pivot commits loses", () => {
  const r = run("x-race", { cancelDuring: "capture_payment" });
  assert.equal(r.record.state, "COMPLETED");
  assert.ok(r.refusals.some((x) => x.code === "CANCEL_LOST_THE_RACE"));
});

test("a cancellation that loses is recorded rather than dropped", () => {
  const r = run("x-record", { cancelDuring: "capture_payment" });
  const codes = r.record.history.map((h) => h.reasonCode);
  assert.ok(codes.includes("CANCEL_REQUESTED"));
  assert.ok(codes.includes("CANCEL_LOST_THE_RACE"));
});

test("a cancellation after the pivot is refused outright", () => {
  const store = new SagaStore();
  const world = new World();
  const queue = new DelayQueue();
  const o = new Orchestrator(store, world, queue, { callbackDelayMs: 1 });
  o.start("x-after", 1000, 1, T0);
  o.advance("x-after", T0);
  o.runDue(T0 + 10);
  o.advance("x-after", T0 + 20);
  assert.equal(o.stateOf("x-after"), "COMPLETED");
  assert.equal(o.cancel("x-after", T0 + 30), "refused");
  assert.deepEqual(o.refusals.map((x) => x.code), ["SAGA_FINISHED"]);
});

test("a cancellation of a saga stopped after the pivot is refused", () => {
  const store = new SagaStore();
  const world = new World();
  const queue = new DelayQueue();
  const o = new Orchestrator(store, world, queue, { callbackDelayMs: 1 });
  o.start("x-pivoted", 1000, 1, T0);
  o.advance("x-pivoted", T0);
  o.runDue(T0 + 10);
  const rec = store.get("x-pivoted");
  rec.state = "PIVOTED";
  assert.equal(o.cancel("x-pivoted", T0 + 20), "refused");
  assert.deepEqual(o.refusals.map((x) => x.code), ["CANCEL_AFTER_PIVOT"]);
});

test("the money does not move when a cancellation wins", () => {
  const r = run("x-money", { cancelWhileWaiting: true });
  assert.equal(r.world.holdState("x-money"), "voided");
  assert.equal(r.audit.live.length, 0);
});

test("the money does move when a cancellation loses", () => {
  const r = run("x-money2", { cancelDuring: "capture_payment" });
  assert.equal(r.world.holdState("x-money2"), "captured");
  assert.equal(r.audit.verdict, "COMPLETED");
});
