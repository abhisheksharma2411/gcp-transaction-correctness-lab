// The dual-write windows: what survives a crash at each point, under each of
// the three capture strategies.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  MINUTE,
  T0,
  TOPIC,
  audit,
  buildWorld,
  crashWindow,
  survivingCrash,
} from "../src/scenarios.ts";

function confirmOne(world: ReturnType<typeof buildWorld>, crashAt: Parameters<typeof crashWindow>[1]) {
  return survivingCrash(() =>
    world.source.confirm({
      orderId: "ord-1",
      operationId: "op-1",
      lines: [{ sku: "sku-a", quantity: 2 }],
      schemaVersion: 1,
      nowMs: T0,
      crashAt,
    }),
  );
}

test("C01 a crash before commit leaves no state change and no event", () => {
  const world = buildWorld({ strategy: "outbox" });
  confirmOne(world, "before-commit");
  world.relay.drain(T0 + MINUTE);

  assert.equal(world.trace.count("commit"), 0);
  assert.equal(world.source.outbox.size, 0);
  assert.equal(world.broker.publishedMessages(TOPIC).length, 0);
  assert.deepEqual(audit(world).findings, []);
});

test("C02 publish-after-commit loses the event when the process dies in its window", () => {
  const result = crashWindow("publish-after-commit", "after-commit-before-publish");
  assert.equal(result.committed, 1);
  assert.equal(result.eventsOnTopic, 0);
  assert.equal(result.protectedEffects, 0);
  assert.deepEqual([...new Set(result.findings)], ["L01_MISSING_EVENT"]);
});

test("C02b the outbox survives the same crash, because the event committed with the change", () => {
  const result = crashWindow("outbox", "after-commit-before-publish");
  assert.equal(result.committed, 1);
  assert.equal(result.eventsOnTopic, 1);
  assert.equal(result.protectedEffects, 2);
  assert.deepEqual(result.findings, []);
});

test("C03 publish-before-commit emits a phantom event when the commit never happens", () => {
  const result = crashWindow("publish-before-commit", "before-commit");
  assert.equal(result.committed, 0);
  assert.equal(result.eventsOnTopic, 1);
  // The phantom is delivered and acted on. Nothing downstream can tell.
  assert.ok(result.protectedEffects > 0);
  assert.ok(result.findings.includes("L02_PHANTOM_EVENT"));
});

test("C04 a relay that dies after publishing and before its checkpoint republishes", () => {
  const world = buildWorld({ strategy: "outbox" });
  confirmOne(world, "none");

  survivingCrash(() => world.relay.runOnce(T0 + MINUTE, "after-publish-before-checkpoint"));
  const afterCrash = world.broker.publishedMessages(TOPIC);
  assert.equal(afterCrash.length, 1);
  assert.equal([...world.source.outbox.values()][0]!.publishedAtMs, null);

  // The lease expires and the row is claimed again.
  world.relay.drain(T0 + 2 * MINUTE);
  const afterRestart = world.broker.publishedMessages(TOPIC);
  assert.equal(afterRestart.length, 2, "the same event was published twice");
  assert.equal(afterRestart[0]!.body.eventId, afterRestart[1]!.body.eventId);
  assert.notEqual(afterRestart[0]!.messageId, afterRestart[1]!.messageId);
});

test("C05 the duplicate publish costs nothing downstream, because the effect is guarded", () => {
  const world = buildWorld({ strategy: "outbox" });
  confirmOne(world, "none");
  survivingCrash(() => world.relay.runOnce(T0 + MINUTE, "after-publish-before-checkpoint"));
  world.relay.drain(T0 + 2 * MINUTE);

  world.inventory.drain(T0 + 3 * MINUTE);
  world.notifications.drain(T0 + 3 * MINUTE);

  assert.equal(world.inventory.protectedEffectCount(), 1);
  assert.equal(world.notifications.protectedEffectCount(), 1);
  assert.ok(world.inventory.suppressedByInbox >= 1);
  assert.deepEqual(audit(world).findings, []);
});

test("C06 a lease stops a second relay from claiming a row that is in flight", () => {
  const world = buildWorld({ strategy: "outbox" });
  confirmOne(world, "none");
  const row = [...world.source.outbox.values()][0]!;
  row.leaseOwner = "relay-b";
  row.leaseExpiresAtMs = T0 + 10 * MINUTE;

  assert.equal(world.source.claimable(T0 + MINUTE).length, 0);
  assert.equal(world.source.claimable(T0 + 11 * MINUTE).length, 1);
});

test("C07 the outbox and the business row carry the same transaction id", () => {
  const world = buildWorld({ strategy: "outbox" });
  confirmOne(world, "none");
  const commit = world.trace.of("commit")[0]!;
  const write = world.trace.of("outbox-write")[0]!;
  assert.equal(commit.txId, write.txId);
});
