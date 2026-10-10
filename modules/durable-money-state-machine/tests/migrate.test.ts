// Changing the machine while entities are running under the old one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { migrateToV2, migrationPlan, runningSpecVersion } from "../src/migrate.ts";
import { Runtime, SERVICE } from "../src/runtime.ts";
import { SPEC_V1, SPEC_V2 } from "../src/spec.ts";
import { SCENARIOS, T0, MINUTE, HOUR } from "../src/scenarios.ts";

function v1(id: string, amountMinor: number): Runtime {
  const rt = new Runtime();
  rt.create({
    id, amountMinor, currency: "EUR", initiatorId: "initiator-1",
    specVersion: 1, createdAtMs: T0, correlationId: "c",
  });
  return rt;
}

test("version 2 has a state version 1 does not", () => {
  assert.ok(SPEC_V2.states.includes("MANUAL_REVIEW"));
  assert.ok(!SPEC_V1.states.includes("MANUAL_REVIEW"));
});

test("the two versions disagree about what an indeterminate lookup means", () => {
  const a = SPEC_V1.transitions.find((t) => t.trigger === "lookup_indeterminate");
  const b = SPEC_V2.transitions.find((t) => t.trigger === "lookup_indeterminate");
  assert.equal(a?.to, "DECLINED");
  assert.equal(b?.to, "MANUAL_REVIEW");
});

test("an untouched draft migrates, because nothing has been decided", () => {
  const rt = v1("m1", 900_000);
  const v = migrateToV2(rt.get("m1"), T0 + MINUTE);
  assert.equal(v.kind, "MIGRATED");
  if (v.kind !== "MIGRATED") return;
  assert.equal(v.payout.specVersion, 2);
  assert.equal(v.payout.history.length, 2, "the migration itself is recorded");
  assert.equal(v.payout.history[1]?.reasonCode, "MIGRATED_V1_TO_V2");
});

test("a migrated draft is then decided by version 2's rules", () => {
  const rt = v1("m2", 900_000);
  const v = migrateToV2(rt.get("m2"), T0 + MINUTE);
  if (v.kind !== "MIGRATED") throw new Error("setup");
  rt.put(v.payout);
  rt.step("m2", "authorize", SERVICE, T0 + 2 * MINUTE, { correlationId: "auth" });
  assert.equal(rt.stateOf("m2"), "MANUAL_REVIEW", "version 2 sends this amount to a human");
});

test("an in-flight payout is pinned and finishes under the version it started on", () => {
  const rt = v1("m3", 25_000);
  rt.step("m3", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  rt.step("m3", "submit", SERVICE, T0 + 2 * MINUTE, { correlationId: "submit" });
  const v = migrateToV2(rt.get("m3"), T0 + 3 * MINUTE);
  assert.equal(v.kind, "PINNED");
  const token = rt.get("m3").callbackToken ?? "";
  rt.callback("m3", "settled", token, T0 + HOUR, "cb");
  assert.equal(rt.stateOf("m3"), "SETTLED");
  assert.equal(runningSpecVersion(rt.get("m3")), 1);
  assert.ok(rt.get("m3").history.every((r) => r.specVersion === 1));
});

test("a decision version 2 would not have taken blocks the migration", () => {
  const rt = v1("m4", 900_000);
  rt.step("m4", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  assert.equal(rt.stateOf("m4"), "AUTHORIZED", "version 1 approved it without asking anyone");
  const v = migrateToV2(rt.get("m4"), T0 + 2 * MINUTE);
  assert.equal(v.kind, "BLOCKED");
  if (v.kind !== "BLOCKED") return;
  assert.match(v.why, /review that never happened/);
});

test("a small payout version 1 approved is not blocked, because version 2 agrees", () => {
  const rt = v1("m5", 25_000);
  rt.step("m5", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  assert.equal(migrateToV2(rt.get("m5"), T0 + 2 * MINUTE).kind, "PINNED");
});

test("a finished payout keeps the version that decided it", () => {
  const rt = v1("m6", 25_000);
  rt.step("m6", "cancel", SERVICE, T0 + MINUTE, { correlationId: "x" });
  const v = migrateToV2(rt.get("m6"), T0 + 2 * MINUTE);
  assert.equal(v.kind, "PINNED");
  if (v.kind !== "PINNED") return;
  assert.match(v.why, /terminal/);
});

test("the migration never rewrites a history record", () => {
  const rt = v1("m7", 900_000);
  const before = rt.get("m7").history;
  const v = migrateToV2(rt.get("m7"), T0 + MINUTE);
  if (v.kind !== "MIGRATED") throw new Error("setup");
  assert.deepEqual(v.payout.history.slice(0, before.length), before);
});

test("a dry run reports what a migration would do without doing it", () => {
  const rt = v1("p1", 900_000);
  rt.create({
    id: "p2", amountMinor: 900_000, currency: "EUR", initiatorId: "initiator-1",
    specVersion: 1, createdAtMs: T0, correlationId: "c",
  });
  rt.step("p2", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  rt.create({
    id: "p3", amountMinor: 25_000, currency: "EUR", initiatorId: "initiator-1",
    specVersion: 1, createdAtMs: T0, correlationId: "c",
  });
  rt.step("p3", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  rt.step("p3", "submit", SERVICE, T0 + 2 * MINUTE, { correlationId: "submit" });

  const plan = migrationPlan(rt.all(), T0 + 3 * MINUTE);
  assert.deepEqual(plan.migrated, ["p1"]);
  assert.deepEqual(plan.pinned, ["p3"]);
  assert.deepEqual(plan.blocked.map((b) => b.id), ["p2"]);
  // Nothing in the store changed.
  assert.ok(rt.all().every((p) => p.specVersion === 1));
});

test("S20 and S21 are the two migration answers end to end", () => {
  const s20 = SCENARIOS.find((s) => s.id === "S20")!.run();
  assert.equal(s20.extra["migration"], "PINNED");
  assert.equal(s20.extra["ranUnder"], 1);
  const s21 = SCENARIOS.find((s) => s.id === "S21")!.run();
  assert.equal(s21.extra["migration"], "BLOCKED");
  assert.equal(s21.extra["stillUnder"], 1);
});
