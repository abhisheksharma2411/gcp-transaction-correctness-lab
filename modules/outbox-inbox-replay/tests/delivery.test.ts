// Delivery semantics against business-effect semantics: the whole point of the
// inbox and the effect ledger.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { makeEnvelope } from "../src/identity.ts";
import { DEAD_LETTER, MINUTE, T0, TOPIC, audit, buildWorld, survivingCrash } from "../src/scenarios.ts";
import type { SchemaVersion } from "../src/types.ts";

function envelope(orderId: string, sequence: number, opts: {
  sku?: string;
  quantity?: number;
  schemaVersion?: SchemaVersion;
} = {}) {
  return makeEnvelope({
    aggregateType: "order",
    aggregateId: orderId,
    sequence,
    eventType: "OrderConfirmed",
    schemaVersion: opts.schemaVersion ?? 1,
    recordedAtMs: T0 + sequence,
    operationId: `op-${orderId}-${sequence}`,
    payload: { lines: [{ sku: opts.sku ?? "sku-a", quantity: opts.quantity ?? 1 }] },
  });
}


/** Commit a change through the source, so the lineage is real, and return its event. */
function commit(
  world: ReturnType<typeof buildWorld>,
  orderId: string,
  opts: { sku?: string; quantity?: number; schemaVersion?: SchemaVersion; atMs?: number } = {},
) {
  return world.source.confirm({
    orderId,
    operationId: `op-${orderId}`,
    lines: [{ sku: opts.sku ?? "sku-a", quantity: opts.quantity ?? 1 }],
    schemaVersion: opts.schemaVersion ?? 1,
    nowMs: opts.atMs ?? T0,
  });
}

test("D01 the same event delivered twice produces one protected effect", () => {
  const world = buildWorld();
  const e = envelope("ord-1", 1);
  world.broker.publish(TOPIC, e, T0, "test");
  world.broker.publish(TOPIC, e, T0 + 1, "test"); // a publish-side duplicate: new message id

  world.inventory.drain(T0 + MINUTE);

  assert.equal(world.inventory.protectedEffectCount(), 1);
  assert.equal(world.inventory.suppressedByInbox, 1);
  assert.equal(world.trace.of("deliver").filter((d) => d.consumer === "inventory").length, 2);
});

test("D02 an effect that lands before a lost acknowledgement is not applied twice", () => {
  const world = buildWorld();
  const e = envelope("ord-2", 1);
  world.broker.publish(TOPIC, e, T0, "test");

  const first = world.broker.pull("inventory-sub", 1, T0, "inventory");
  world.inventory.handle(first[0]!, T0, { loseAck: true });
  assert.equal(world.inventory.protectedEffectCount(), 1);

  const second = world.broker.pull("inventory-sub", 1, T0 + 1, "inventory");
  assert.equal(second.length, 1, "a failed acknowledgement produces a redelivery");
  assert.equal(world.inventory.handle(second[0]!, T0 + 1), "INBOX_HIT");
  assert.equal(world.inventory.protectedEffectCount(), 1);
});

test("D03 a consumer that dies between the effect and the acknowledgement recovers cleanly", () => {
  const world = buildWorld();
  world.broker.publish(TOPIC, envelope("ord-3", 1), T0, "test");

  const first = world.broker.pull("inventory-sub", 1, T0, "inventory");
  survivingCrash(() => world.inventory.handle(first[0]!, T0, { crashAfterEffectBeforeAck: true }));
  assert.equal(world.inventory.protectedEffectCount(), 1);
  assert.equal(world.trace.of("ack").length, 0);

  // The acknowledgement deadline expires and the message comes back.
  world.broker.nack("inventory-sub", first[0]!.messageId, T0 + 1, "inventory", "deadline expired");
  const outcomes = world.inventory.drain(T0 + 2);
  assert.deepEqual(outcomes, ["INBOX_HIT"]);
  assert.equal(world.inventory.protectedEffectCount(), 1);
});

test("D04 two consumers hold separate effect identities and neither suppresses the other", () => {
  const world = buildWorld();
  commit(world, "ord-4");
  world.relay.drain(T0 + MINUTE);

  world.inventory.drain(T0 + 2 * MINUTE);
  world.notifications.drain(T0 + 2 * MINUTE);

  assert.equal(world.inventory.protectedEffectCount(), 1);
  assert.equal(world.notifications.protectedEffectCount(), 1);
  const ids = new Set([...world.inventory.effects.keys(), ...world.notifications.effects.keys()]);
  assert.equal(ids.size, 2);
  assert.deepEqual(audit(world).findings, []);
});

test("D05 an out-of-order arrival is held, not applied, and lands once its predecessor has", () => {
  const world = buildWorld({ enableOrdering: false });
  commit(world, "ord-5", { sku: "sku-a", atMs: T0 });
  commit(world, "ord-5", { sku: "sku-b", atMs: T0 + 1 });

  // Published in the wrong order on purpose. On a subscription without
  // ordering enabled, and across ordering keys even with it, this is normal.
  const log = world.source.eventLog();
  world.broker.publish(TOPIC, log[1]!, T0 + 10, "test");
  world.broker.publish(TOPIC, log[0]!, T0 + 11, "test");

  const outcomes = world.inventory.drain(T0 + MINUTE);
  assert.ok(outcomes.includes("DEFERRED"), "the gap was noticed");
  assert.equal(world.inventory.highWater.get("ord-5"), 2);
  const applied = [...world.inventory.effects.values()].map((e) => e.subject).sort();
  assert.deepEqual(applied, ["sku-a", "sku-b"]);
  const codes = audit(world).findings.map((f) => f.code);
  assert.deepEqual(codes.filter((c) => c !== "L04_UNDELIVERED"), []);
});

test("D06 a stale event that has already been superseded is acknowledged and does nothing", () => {
  const world = buildWorld({ enableOrdering: false });
  world.broker.publish(TOPIC, envelope("ord-6", 1, { sku: "sku-a" }), T0, "test");
  world.broker.publish(TOPIC, envelope("ord-6", 2, { sku: "sku-b" }), T0 + 1, "test");
  world.inventory.drain(T0 + MINUTE);
  assert.equal(world.inventory.protectedEffectCount(), 2);

  // Sequence 1 arrives again, long after sequence 2 has been applied.
  world.broker.publish(TOPIC, envelope("ord-6", 1, { sku: "sku-a" }), T0 + 2, "test");
  const outcomes = world.inventory.drain(T0 + 2 * MINUTE);
  assert.ok(outcomes.includes("INBOX_HIT") || outcomes.includes("STALE"));
  assert.equal(world.inventory.protectedEffectCount(), 2);
});

test("D07 per-key ordering converts an out-of-order arrival into a stalled key", () => {
  // With ordering enabled, only one message per key is outstanding at a time.
  // A successor that cannot be applied yet therefore blocks its own
  // predecessor, spends the delivery budget, and dies in the dead-letter topic
  // -- after which the predecessor applies, leaving the aggregate behind.
  const world = buildWorld({ enableOrdering: true });
  commit(world, "ord-7", { sku: "sku-a", atMs: T0 });
  commit(world, "ord-7", { sku: "sku-b", atMs: T0 + 1 });

  const log = world.source.eventLog();
  world.broker.publish(TOPIC, log[1]!, T0 + 10, "test");
  world.broker.publish(TOPIC, log[0]!, T0 + 11, "test");

  world.inventory.drain(T0 + MINUTE);

  const dead = world.broker.deadLetterContents(DEAD_LETTER);
  assert.equal(dead.length, 1, "the successor exhausted its budget while waiting");
  assert.equal(dead[0]!.body.sequence, 2);
  const applied = [...world.inventory.effects.values()].map((e) => e.subject);
  assert.deepEqual(applied, ["sku-a"], "only the predecessor was applied");
  assert.equal(world.inventory.highWater.get("ord-7"), 1);
  // Ordering did not rescue the aggregate; it made the loss loud instead of silent.
  const codes = audit(world).findings.map((f) => f.code);
  assert.ok(codes.includes("L10_DEAD_LETTER_UNRESOLVED"));
});

test("D08 a poison event exhausts its delivery budget and lands in the dead-letter topic", () => {
  const world = buildWorld();
  world.broker.publish(TOPIC, envelope("ord-8", 1, { quantity: 0 }), T0, "test");

  world.inventory.drain(T0 + MINUTE);

  assert.equal(world.inventory.protectedEffectCount(), 0);
  const dead = world.broker.deadLetterContents(DEAD_LETTER);
  assert.equal(dead.length, 1);
  assert.equal(dead[0]!.body.aggregateId, "ord-8");
  const deadLetterTrace = world.trace.of("dead-letter");
  assert.equal(deadLetterTrace.length, 1);
  assert.match(deadLetterTrace[0]!.reason, /non-positive quantity/);
});

test("D09 the delivery budget is spent on attempts, and the floor is five", () => {
  const world = buildWorld();
  world.broker.publish(TOPIC, envelope("ord-9", 1, { quantity: -1 }), T0, "test");
  world.inventory.drain(T0 + MINUTE);
  const attempts = world.trace.of("deliver").filter((d) => d.consumer === "inventory");
  assert.equal(attempts.length, 5);
  assert.deepEqual(attempts.map((a) => a.deliveryAttempt), [1, 2, 3, 4, 5]);
});

test("D10 a subscription below the documented minimum delivery attempts is refused", () => {
  assert.throws(
    () =>
      buildWorld({ maxDeliveryAttempts: 3 }),
    /at least 5/,
  );
});

test("D11 a poison event blocks nothing else once it has been dead-lettered", () => {
  const world = buildWorld();
  world.broker.publish(TOPIC, envelope("ord-10", 1, { quantity: 0 }), T0, "test");
  world.broker.publish(TOPIC, envelope("ord-11", 1, { sku: "sku-c" }), T0 + 1, "test");

  world.inventory.drain(T0 + MINUTE);

  assert.equal(world.inventory.protectedEffectCount(), 1);
  assert.equal([...world.inventory.effects.values()][0]!.subject, "sku-c");
});
