// Where the state lives: an application-owned row, or an orchestration
// execution.
//
// Both drivers run the same transition table. The only variable is where the
// answer to "what is the state of this payout?" is kept.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DatabaseBackedDriver, EngineBackedDriver, runLifecycle } from "../src/drivers.ts";
import { SERVICE } from "../src/runtime.ts";
import { T0, DAY } from "../src/scenarios.ts";

const RETENTION_MS = 90 * DAY;

test("both drivers reach the same state from the same script", () => {
  const db = new DatabaseBackedDriver();
  const engine = new EngineBackedDriver();
  const a = runLifecycle(db, "x", T0);
  const b = runLifecycle(engine, "x", T0);
  assert.equal(a.finalState, b.finalState);
  assert.equal(a.steps, b.steps);
  assert.equal(a.finalState, "SUBMITTED");
});

test("after the engine's retention window, only one of them can answer", () => {
  const db = new DatabaseBackedDriver();
  const engine = new EngineBackedDriver();
  runLifecycle(db, "x", T0);
  runLifecycle(engine, "x", T0);
  engine.expireExecutions(T0 + RETENTION_MS + DAY, RETENTION_MS);
  assert.equal(db.stateOf("x"), "SUBMITTED");
  assert.equal(engine.stateOf("x"), null, "execution data is unavailable");
});

test("retention does not expire an execution before its window", () => {
  const engine = new EngineBackedDriver();
  runLifecycle(engine, "x", T0);
  assert.equal(engine.expireExecutions(T0 + RETENTION_MS - DAY, RETENTION_MS), 0);
  assert.equal(engine.stateOf("x"), "SUBMITTED");
});

test("an expired execution refuses further steps rather than inventing a state", () => {
  const engine = new EngineBackedDriver();
  runLifecycle(engine, "x", T0);
  engine.expireExecutions(T0 + RETENTION_MS + DAY, RETENTION_MS);
  const r = engine.step("x", "callback_settled", SERVICE, T0 + RETENTION_MS + DAY, {
    correlationId: "cb",
  });
  assert.equal(r.outcome.kind, "REFUSED");
  assert.equal(r.committed, false);
});

test("the engine driver keys its state by execution, not by payout", () => {
  const engine = new EngineBackedDriver();
  runLifecycle(engine, "a", T0);
  runLifecycle(engine, "b", T0);
  assert.equal(engine.executionCount, 2);
  // Asking about a payout that no execution carries has no answer, which is
  // the structural difference: the index is the engine's, not the business's.
  assert.equal(engine.stateOf("c"), null);
});

test("the database driver answers for an entity nobody is currently running", () => {
  const db = new DatabaseBackedDriver();
  runLifecycle(db, "a", T0);
  assert.equal(db.stateOf("a"), "SUBMITTED");
  assert.equal(db.stateOf("c"), null, "and says so plainly for one that does not exist");
});

test("neither driver is the state machine; the table is", () => {
  // The point of the comparison. Swapping where state lives changes the
  // operational properties and nothing about which transitions are legal.
  const db = new DatabaseBackedDriver();
  const engine = new EngineBackedDriver();
  runLifecycle(db, "x", T0);
  runLifecycle(engine, "x", T0);
  const a = db.step("x", "submit", SERVICE, T0 + 10_000, { correlationId: "again" });
  const b = engine.step("x", "submit", SERVICE, T0 + 10_000, { correlationId: "again" });
  assert.equal(a.outcome.kind, "REFUSED");
  assert.equal(b.outcome.kind, "REFUSED");
  if (a.outcome.kind !== "REFUSED" || b.outcome.kind !== "REFUSED") return;
  assert.equal(a.outcome.reasonCode, b.outcome.reasonCode);
});
