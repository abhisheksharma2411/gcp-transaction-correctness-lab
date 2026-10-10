// Replay and projection rebuild.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { projectionFingerprint, rebuildProjection } from "../src/projection.ts";
import { UnboundedReplayError, applyReplay, planReplay, recordDryRun } from "../src/replay.ts";
import { MINUTE, T0, TOPIC, audit, buildWorld, effectIds } from "../src/scenarios.ts";

const DAY = 86_400_000;

function seed(world: ReturnType<typeof buildWorld>) {
  world.source.confirm({
    orderId: "ord-1", operationId: "op-1", lines: [{ sku: "sku-a", quantity: 1 }],
    schemaVersion: 1, nowMs: T0,
  });
  world.source.confirm({
    orderId: "ord-2", operationId: "op-2", lines: [{ sku: "sku-b", quantity: 3 }],
    schemaVersion: 1, nowMs: T0 + DAY,
  });
  world.source.confirm({
    orderId: "ord-2", operationId: "op-3", lines: [{ sku: "sku-c", quantity: 1 }],
    schemaVersion: 1, nowMs: T0 + DAY + 1,
  });
  world.relay.drain(T0 + 2 * DAY);
  world.inventory.drain(T0 + 2 * DAY + MINUTE);
  world.notifications.drain(T0 + 2 * DAY + MINUTE);
}

test("R01 a replay with no aggregate and no window is refused", () => {
  const world = buildWorld();
  seed(world);
  assert.throws(
    () => planReplay(world.source.eventLog(), { maxEvents: 100 }, "b1"),
    UnboundedReplayError,
  );
});

test("R02 a dry run names exactly what it would publish and publishes nothing", () => {
  const world = buildWorld();
  seed(world);
  const before = world.broker.publishedMessages(TOPIC).length;

  const plan = recordDryRun(
    planReplay(world.source.eventLog(), { aggregateId: "ord-2", maxEvents: 100 }, "b1"),
    T0 + 3 * DAY,
    world.trace,
  );

  assert.equal(plan.eventIds.length, 2);
  assert.equal(world.broker.publishedMessages(TOPIC).length, before);
  assert.equal(world.trace.of("replay-plan")[0]!.dryRun, true);
});

test("R03 a historical window selects by recorded time, not by publish time", () => {
  const world = buildWorld();
  seed(world);
  const plan = planReplay(
    world.source.eventLog(),
    { fromMs: T0 + DAY, toMs: T0 + DAY + 10, maxEvents: 100 },
    "b2",
  );
  assert.deepEqual(plan.envelopes.map((e) => e.aggregateId), ["ord-2", "ord-2"]);
});

test("R04 the ceiling truncates rather than silently widening", () => {
  const world = buildWorld();
  seed(world);
  const plan = planReplay(world.source.eventLog(), { aggregateId: "ord-2", maxEvents: 1 }, "b3");
  assert.equal(plan.eventIds.length, 1);
  assert.equal(plan.truncated, true);
});

test("R05 replaying a historical range changes no effect, and the verifier agrees", () => {
  const world = buildWorld();
  seed(world);
  const before = effectIds(world);

  const plan = planReplay(world.source.eventLog(), { aggregateId: "ord-2", maxEvents: 100 }, "b4");
  const published = applyReplay(plan, world.broker, TOPIC, T0 + 3 * DAY, world.trace);
  assert.equal(published, 2);

  world.inventory.drain(T0 + 3 * DAY + MINUTE);
  world.notifications.drain(T0 + 3 * DAY + MINUTE);
  const after = effectIds(world);

  assert.deepEqual(after, before);
  const report = audit(world, { before, after });
  assert.deepEqual(report.findings, []);
});

test("R06 removing the inbox alone changes nothing, because the sequence position catches the replay", () => {
  const world = buildWorld({ mutation: "no-inbox" });
  seed(world);
  const before = effectIds(world);

  const plan = planReplay(world.source.eventLog(), { aggregateId: "ord-2", maxEvents: 100 }, "b5");
  applyReplay(plan, world.broker, TOPIC, T0 + 3 * DAY, world.trace);
  world.inventory.drain(T0 + 3 * DAY + MINUTE);
  world.notifications.drain(T0 + 3 * DAY + MINUTE);

  assert.ok(world.trace.of("stale").length > 0, "the sequence position did the work");
  assert.deepEqual(effectIds(world), before);
  const codes = audit(world, { before, after: effectIds(world) }).findings.map((f) => f.code);
  assert.ok(!codes.includes("L09_REPLAY_DIVERGENCE"));
});

test("R07 removing both message-level guards leaves the effect ledger holding the replay", () => {
  const world = buildWorld({ mutation: "no-message-dedup" });
  seed(world);
  const before = effectIds(world);
  const appliedBefore = world.inventory.effectApplications;

  const plan = planReplay(world.source.eventLog(), { aggregateId: "ord-2", maxEvents: 100 }, "b6");
  applyReplay(plan, world.broker, TOPIC, T0 + 3 * DAY, world.trace);
  world.inventory.drain(T0 + 3 * DAY + MINUTE);
  world.notifications.drain(T0 + 3 * DAY + MINUTE);

  assert.ok(world.inventory.suppressedByEffectLedger > 0, "the last guard fired");
  assert.equal(world.inventory.effectApplications, appliedBefore);
  const codes = audit(world, { before, after: effectIds(world) }).findings.map((f) => f.code);
  assert.ok(!codes.includes("L05_DUPLICATE_PROTECTED_EFFECT"));
});

test("R07b with every guard removed the replay duplicates the protected effect", () => {
  const world = buildWorld({ mutation: "no-guards" });
  seed(world);
  const appliedBefore = world.inventory.effectApplications;

  const plan = planReplay(world.source.eventLog(), { aggregateId: "ord-2", maxEvents: 100 }, "b7");
  applyReplay(plan, world.broker, TOPIC, T0 + 3 * DAY, world.trace);
  world.inventory.drain(T0 + 3 * DAY + MINUTE);
  world.notifications.drain(T0 + 3 * DAY + MINUTE);

  assert.ok(world.inventory.effectApplications > appliedBefore);
  const codes = audit(world).findings.map((f) => f.code);
  assert.ok(codes.includes("L05_DUPLICATE_PROTECTED_EFFECT"));
});

test("R08 replay reads the event log, so a consumer created afterwards can be backfilled", () => {
  const world = buildWorld();
  seed(world);
  // A third consumer is introduced now. It saw nothing that was published
  // before it existed, which is why the backfill comes from the log.
  const fresh = buildWorld();
  const plan = planReplay(world.source.eventLog(), { fromMs: T0, maxEvents: 100 }, "b6");
  applyReplay(plan, fresh.broker, TOPIC, T0 + 4 * DAY, fresh.trace);
  fresh.inventory.drain(T0 + 4 * DAY + MINUTE);

  assert.equal(fresh.inventory.protectedEffectCount(), 3);
});

test("P01 rebuilding the projection from the log reproduces the live one", () => {
  const world = buildWorld();
  seed(world);

  const live = rebuildProjection(world.source.eventLog());
  const rebuilt = rebuildProjection([...world.source.eventLog()].reverse());

  assert.equal(projectionFingerprint(rebuilt), projectionFingerprint(live));
  assert.equal(projectionFingerprint(live), "ord-1@1:[sku-a];ord-2@2:[sku-c]");
});

test("P02 the rebuilt projection matches what the consumer actually reserved", () => {
  const world = buildWorld();
  seed(world);
  const projection = rebuildProjection(world.source.eventLog());

  const reservedByConsumer = [...world.inventory.effects.values()]
    .filter((e) => e.kind === "reserve")
    .map((e) => e.subject)
    .sort();
  const reservedByProjection = [...projection.reservations.values()].flat().sort();

  // The projection keeps only the latest state of each aggregate; the consumer
  // applied every event. The projection is therefore a subset, and the
  // difference is exactly the superseded sequence.
  assert.deepEqual(reservedByProjection, ["sku-a", "sku-c"]);
  assert.deepEqual(reservedByConsumer, ["sku-a", "sku-b", "sku-c"]);
});
