// The broker model itself: the behaviours the correctness argument leans on.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Broker } from "../src/broker.ts";
import { makeEnvelope } from "../src/identity.ts";
import { Trace } from "../src/trace.ts";

const T = Date.UTC(2026, 1, 3);

function envelope(aggregateId: string, sequence: number) {
  return makeEnvelope({
    aggregateType: "order",
    aggregateId,
    sequence,
    eventType: "OrderConfirmed",
    schemaVersion: 1,
    recordedAtMs: T + sequence,
    operationId: `op-${aggregateId}-${sequence}`,
    payload: {},
  });
}

function fresh(enableOrdering: boolean) {
  const trace = new Trace();
  const broker = new Broker(trace);
  broker.createTopic("t");
  broker.createTopic("dlq");
  broker.subscribe({
    name: "s",
    topic: "t",
    enableOrdering,
    deadLetterTopic: "dlq",
    maxDeliveryAttempts: 5,
  });
  return { trace, broker };
}

test("B01 publishing one event twice yields two message ids and one event id", () => {
  const { broker } = fresh(false);
  const e = envelope("ord-1", 1);
  const a = broker.publish("t", e, T, "p");
  const b = broker.publish("t", e, T + 1, "p");
  assert.notEqual(a.messageId, b.messageId);
  assert.equal(a.body.eventId, b.body.eventId);
});

test("B02 a subscription created after a publish does not receive it", () => {
  const { broker } = fresh(false);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  broker.subscribe({
    name: "late",
    topic: "t",
    enableOrdering: false,
    deadLetterTopic: null,
    maxDeliveryAttempts: 5,
  });
  assert.equal(broker.pull("late", 10, T + 1, "c").length, 0);
  assert.equal(broker.pull("s", 10, T + 1, "c").length, 1);
});

test("B03 with ordering off, two messages for one key are outstanding together", () => {
  const { broker } = fresh(false);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  broker.publish("t", envelope("ord-1", 2), T + 1, "p");
  assert.equal(broker.pull("s", 10, T + 2, "c").length, 2);
});

test("B04 with ordering on, one key yields one message at a time", () => {
  const { broker } = fresh(true);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  broker.publish("t", envelope("ord-1", 2), T + 1, "p");
  broker.publish("t", envelope("ord-2", 1), T + 2, "p");
  const pulled = broker.pull("s", 10, T + 3, "c");
  assert.equal(pulled.length, 2, "one per key");
  assert.deepEqual(pulled.map((m) => m.orderingKey), ["order:ord-1", "order:ord-2"]);
});

test("B05 a redelivery drags the acknowledged messages after it on the same key", () => {
  const { broker } = fresh(true);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  broker.publish("t", envelope("ord-1", 2), T + 1, "p");

  const first = broker.pull("s", 1, T + 2, "c")[0]!;
  broker.ack("s", first.messageId, T + 3, "c");
  const second = broker.pull("s", 1, T + 4, "c")[0]!;
  broker.ack("s", second.messageId, T + 5, "c");
  assert.equal(broker.backlog("s"), 0);

  // The first message comes back. The second comes back with it, although it
  // was acknowledged.
  broker.loseAck("s", first.messageId, T + 6, "c");
  assert.equal(broker.backlog("s"), 2);
});

test("B06 a redelivery on one key leaves another key alone", () => {
  const { broker } = fresh(true);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  broker.publish("t", envelope("ord-2", 1), T + 1, "p");
  const pulled = broker.pull("s", 10, T + 2, "c");
  for (const m of pulled) broker.ack("s", m.messageId, T + 3, "c");

  broker.loseAck("s", pulled[0]!.messageId, T + 4, "c");
  assert.equal(broker.backlog("s"), 1);
});

test("B07 a seek replays acknowledged messages", () => {
  const { broker } = fresh(false);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  const m = broker.pull("s", 1, T + 1, "c")[0]!;
  broker.ack("s", m.messageId, T + 2, "c");
  assert.equal(broker.backlog("s"), 0);

  assert.equal(broker.seek("s", T, T + 3), 1);
  assert.equal(broker.backlog("s"), 1);
});

test("B08 a seek resets the delivery-attempt counter, restoring a spent budget", () => {
  const { broker } = fresh(false);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  for (let i = 0; i < 4; i += 1) {
    const m = broker.pull("s", 1, T + i, "c")[0]!;
    assert.equal(m.deliveryAttempt, i + 1);
    broker.nack("s", m.messageId, T + i, "c", "still failing");
  }
  // One attempt from the dead-letter topic.
  broker.seek("s", T, T + 10);
  const afterSeek = broker.pull("s", 1, T + 11, "c")[0]!;
  assert.equal(afterSeek.deliveryAttempt, 1, "the budget is back to the beginning");
});

test("B09 a dead-lettered message leaves the subscription and arrives on the dead-letter topic", () => {
  const { broker } = fresh(false);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  for (let i = 0; i < 5; i += 1) {
    const m = broker.pull("s", 1, T + i, "c")[0]!;
    broker.nack("s", m.messageId, T + i, "c", "poison");
  }
  assert.equal(broker.backlog("s"), 0);
  assert.equal(broker.deadLetterContents("dlq").length, 1);
});

test("B10 a seek does not resurrect a dead-lettered message", () => {
  const { broker } = fresh(false);
  broker.publish("t", envelope("ord-1", 1), T, "p");
  for (let i = 0; i < 5; i += 1) {
    const m = broker.pull("s", 1, T + i, "c")[0]!;
    broker.nack("s", m.messageId, T + i, "c", "poison");
  }
  assert.equal(broker.seek("s", T, T + 20), 0);
  assert.equal(broker.backlog("s"), 0);
});
