// A definition that changes while an execution is still running.
//
// Article 13 owns specification versions and the pinning of in-flight
// entities. What is tested here is only the consequence that belongs to a
// saga: the compensation for a step the new version has deleted must still be
// runnable, which means the old version's code has to stay deployed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { run } from "../src/matrix.ts";
import { DEFINITIONS, SAGA_V2, stepByName } from "../src/saga.ts";

test("a saga carries the version it started on", () => {
  const r = run("v-pin", { version: 1 });
  assert.equal(r.record.specVersion, 1);
  assert.equal(r.definition.version, 1);
});

test("a version 2 saga runs its own steps", () => {
  const r = run("v-two", { version: 2 });
  assert.equal(r.record.state, "COMPLETED");
  assert.ok(r.record.completed.includes("schedule_delivery"));
  assert.equal(r.record.completed.includes("book_shipment"), false);
});

test("a version 2 saga compensates with its own compensation", () => {
  const r = run("v-two-comp", {
    version: 2,
    faults: [{ step: "capture_payment", direction: "forward", at: "reject" }],
  });
  assert.equal(r.record.state, "COMPENSATED");
  const names = r.world.allRecords().filter((x) => x.kind === "compensated").map((x) => x.step);
  assert.ok(names.includes("release_slot"));
});

test("a pinned version 1 saga compensates with version 1's compensation", () => {
  const r = run("v-one-comp", {
    version: 1,
    faults: [{ step: "capture_payment", direction: "forward", at: "reject" }],
  });
  const names = r.world.allRecords().filter((x) => x.kind === "compensated").map((x) => x.step);
  assert.ok(names.includes("cancel_shipment"));
  assert.equal(stepByName(SAGA_V2, "book_shipment"), undefined);
});

test("resolving a compensation against the current version loses the deleted step", () => {
  const r = run("v-drift", {
    version: 1,
    mutation: "compensate-with-current-spec",
    faults: [{ step: "capture_payment", direction: "forward", at: "reject" }],
  });
  assert.equal(r.record.state, "COMPENSATION_FAILED");
  const codes = r.record.history.map((h) => h.reasonCode);
  assert.ok(codes.includes("UNKNOWN_COMPENSATION"));
});

test("the two definitions share one state machine", () => {
  assert.deepEqual(DEFINITIONS[1].transitions, DEFINITIONS[2].transitions);
  assert.deepEqual(DEFINITIONS[1].states, DEFINITIONS[2].states);
});

test("the pivot is the same step in both versions", () => {
  assert.equal(DEFINITIONS[1].steps.find((s) => s.pivot)!.name, "capture_payment");
  assert.equal(DEFINITIONS[2].steps.find((s) => s.pivot)!.name, "capture_payment");
});
