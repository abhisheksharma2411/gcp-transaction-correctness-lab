// Schema versions: what a consumer does when it meets an event it was not
// compiled against.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { DEAD_LETTER, MINUTE, T0, TOPIC, audit, buildWorld } from "../src/scenarios.ts";

function confirm(world: ReturnType<typeof buildWorld>, orderId: string, schemaVersion: 1 | 2 | 3) {
  return world.source.confirm({
    orderId,
    operationId: `op-${orderId}`,
    lines: [{ sku: "sku-a", quantity: 1 }],
    schemaVersion,
    nowMs: T0,
  });
}

test("S01 a version the consumer knows is applied", () => {
  const world = buildWorld({ knownVersions: [1, 2] });
  confirm(world, "ord-1", 2);
  world.relay.drain(T0 + MINUTE);
  world.inventory.drain(T0 + 2 * MINUTE);
  assert.equal(world.inventory.protectedEffectCount(), 1);
});

test("S02 a version the consumer does not know is routed, not dropped and not applied", () => {
  const world = buildWorld({ knownVersions: [1, 2] });
  confirm(world, "ord-2", 3);
  world.relay.drain(T0 + MINUTE);
  const outcomes = world.inventory.drain(T0 + 2 * MINUTE);

  assert.deepEqual(outcomes, ["UNKNOWN_VERSION"]);
  assert.equal(world.inventory.protectedEffectCount(), 0);
  const dead = world.broker.deadLetterContents(DEAD_LETTER);
  assert.equal(dead.length, 1);
  assert.equal(dead[0]!.body.schemaVersion, 3);
});

test("S03 the unknown version is recorded as routed, so the verifier does not flag it as unhandled", () => {
  const world = buildWorld({ knownVersions: [1, 2] });
  confirm(world, "ord-3", 3);
  world.relay.drain(T0 + MINUTE);
  world.inventory.drain(T0 + 2 * MINUTE);
  world.notifications.drain(T0 + 2 * MINUTE);

  const unhandled = world.trace.of("unhandled-version");
  assert.equal(unhandled.length, 2);
  assert.ok(unhandled.every((u) => u.routedToDeadLetter));
  const codes = audit(world).findings.map((f) => f.code);
  assert.ok(!codes.includes("L06_UNHANDLED_SCHEMA_VERSION"));
});

test("S04 an unknown version does not block the events around it", () => {
  const world = buildWorld({ knownVersions: [1, 2] });
  confirm(world, "ord-4", 3);
  confirm(world, "ord-5", 1);
  world.relay.drain(T0 + MINUTE);
  world.inventory.drain(T0 + 2 * MINUTE);

  assert.equal(world.inventory.protectedEffectCount(), 1);
  assert.equal([...world.inventory.effects.values()][0]!.eventId, world.source.eventLog()[1]!.eventId);
});

test("S05 a consumer rolled forward to the new version replays the dead-lettered event cleanly", () => {
  const world = buildWorld({ knownVersions: [1, 2] });
  confirm(world, "ord-6", 3);
  world.relay.drain(T0 + MINUTE);
  world.inventory.drain(T0 + 2 * MINUTE);
  assert.equal(world.inventory.protectedEffectCount(), 0);

  // The deploy lands. A consumer that now understands version 3 is given the
  // same event again, from the event log rather than from the dead-letter
  // topic, because the event log is the record of what happened.
  const upgraded = buildWorld({ knownVersions: [1, 2, 3] });
  const envelope = world.source.eventLog()[0]!;
  upgraded.broker.publish(TOPIC, envelope, T0 + 3 * MINUTE, "repair");
  upgraded.inventory.drain(T0 + 4 * MINUTE);
  assert.equal(upgraded.inventory.protectedEffectCount(), 1);
});

test("S06 both consumers route independently; one being behind does not hold the other back", () => {
  const world = buildWorld({ knownVersions: [1, 2] });
  confirm(world, "ord-7", 1);
  confirm(world, "ord-8", 3);
  world.relay.drain(T0 + MINUTE);
  world.inventory.drain(T0 + 2 * MINUTE);
  world.notifications.drain(T0 + 2 * MINUTE);

  assert.equal(world.inventory.protectedEffectCount(), 1);
  assert.equal(world.notifications.protectedEffectCount(), 1);
  assert.equal(world.broker.deadLetterContents(DEAD_LETTER).length, 2);
});
