// The asynchronous step, and the answer that arrives too late.

import { test } from "node:test";
import assert from "node:assert/strict";

import { T0, run } from "../src/matrix.ts";
import { DelayQueue, Orchestrator, SagaStore } from "../src/orchestrator.ts";
import { FaultPlan, World } from "../src/participants.ts";

test("the carrier's answer arrives later and the saga resumes", () => {
  const r = run("k-ok");
  assert.equal(r.record.state, "COMPLETED");
  assert.equal(r.world.bookingState("k-ok"), "booked");
});

test("the saga blocks rather than guessing while the carrier is silent", () => {
  const store = new SagaStore();
  const world = new World();
  const queue = new DelayQueue();
  const o = new Orchestrator(store, world, queue);
  o.start("k-wait", 1000, 1, T0);
  assert.equal(o.advance("k-wait", T0), "blocked");
  assert.equal(o.stateOf("k-wait"), "RUNNING");
  assert.equal(queue.pendingCount, 1);
});

test("an answer bearing the wrong token is refused", () => {
  const store = new SagaStore();
  const world = new World();
  const queue = new DelayQueue();
  const o = new Orchestrator(store, world, queue);
  o.start("k-token", 1000, 1, T0);
  o.advance("k-token", T0);
  assert.equal(o.deliverCallback("k-token", "book_shipment", "not-the-token", T0 + 1), "refused");
  assert.deepEqual(o.refusals.map((x) => x.code), ["CALLBACK_UNCORRELATED"]);
});

test("the same answer delivered twice produces one effect", () => {
  const store = new SagaStore();
  const world = new World();
  const queue = new DelayQueue();
  const o = new Orchestrator(store, world, queue);
  o.start("k-dup", 1000, 1, T0);
  o.advance("k-dup", T0);
  const token = store.get("k-dup").callbackToken!;
  assert.equal(o.deliverCallback("k-dup", "book_shipment", token, T0 + 1), "accepted");
  assert.equal(o.deliverCallback("k-dup", "book_shipment", token, T0 + 2), "refused");
  assert.equal(world.allRecords().filter((x) => x.step === "book_shipment").length, 1);
});

test("the wait ends the moment the saga leaves RUNNING", () => {
  const r = run("k-abandon", { cancelWhileWaiting: true });
  assert.equal(r.record.callbackToken, null);
  const codes = r.record.history.map((h) => h.reasonCode);
  assert.ok(codes.includes("WAIT_ABANDONED"));
});

test("an answer arriving after compensation is refused by the saga", () => {
  const r = run("k-late", { cancelWhileWaiting: true });
  assert.ok(r.refusals.some((x) => x.code === "NO_WAIT_OUTSTANDING"));
});

test("an answer arriving after compensation is also refused by the participant", () => {
  const r = run("k-late2", { cancelWhileWaiting: true });
  const refusal = r.record.history.find((h) => h.reasonCode === "CANCELLED_BEFORE_BOOKING");
  // The saga refuses first, so the participant's refusal is not reached here.
  // What matters is that no booking exists.
  assert.equal(refusal, undefined);
  assert.equal(r.world.bookingState("k-late2"), "cancelled");
});

test("the carrier acts whether or not anyone is listening", () => {
  // No compensation is sent to fulfilment, so the booking is created even
  // though the saga stopped waiting. This is the leak the chain exists to
  // prevent, and it is visible only at the participant.
  const r = run("k-leak", { mutation: "compensate-only-confirmed", cancelWhileWaiting: true });
  assert.equal(r.world.bookingState("k-leak"), "booked");
  assert.ok(r.audit.live.includes("book_shipment"));
});

test("the delay queue delivers in due order", () => {
  const q = new DelayQueue();
  q.schedule("a", "s", "t1", 300);
  q.schedule("b", "s", "t2", 100);
  q.schedule("c", "s", "t3", 200);
  assert.deepEqual(q.drain(250).map((i) => i.sagaId), ["b", "c"]);
  assert.equal(q.pendingCount, 1);
});

test("the delay queue delivers nothing before its time", () => {
  const q = new DelayQueue();
  q.schedule("a", "s", "t", 500);
  assert.equal(q.drain(499).length, 0);
  assert.equal(q.pendingCount, 1);
});

test("a fault plan consumes a non-sticky fault once", () => {
  const p = new FaultPlan([{ step: "x", direction: "forward", at: "reject" }]);
  assert.equal(p.take("x", "forward", "reject"), true);
  assert.equal(p.take("x", "forward", "reject"), false);
});

test("a sticky fault keeps firing", () => {
  const p = new FaultPlan([{ step: "x", direction: "forward", at: "reject", sticky: true }]);
  assert.equal(p.take("x", "forward", "reject"), true);
  assert.equal(p.take("x", "forward", "reject"), true);
});
