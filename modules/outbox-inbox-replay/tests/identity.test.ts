import { strict as assert } from "node:assert";
import { test } from "node:test";

import { deriveEffectId, deriveEventId, hash, makeEnvelope, orderingKeyFor } from "../src/identity.ts";

const base = {
  aggregateType: "order",
  aggregateId: "ord-1",
  sequence: 1,
  eventType: "OrderConfirmed",
  schemaVersion: 1 as const,
  recordedAtMs: 1_000,
  operationId: "op-1",
  payload: {},
};

test("I01 the event id is derived, so republishing one change yields one event id", () => {
  const first = makeEnvelope(base);
  const second = makeEnvelope({ ...base, recordedAtMs: 9_999 });
  assert.equal(first.eventId, second.eventId);
});

test("I02 a different position in the aggregate's history is a different event", () => {
  assert.notEqual(
    deriveEventId("order", "ord-1", 1, "OrderConfirmed"),
    deriveEventId("order", "ord-1", 2, "OrderConfirmed"),
  );
});

test("I03 the same sequence on a different aggregate is a different event", () => {
  assert.notEqual(
    deriveEventId("order", "ord-1", 1, "OrderConfirmed"),
    deriveEventId("order", "ord-2", 1, "OrderConfirmed"),
  );
});

test("I04 two consumers reacting to one event hold two distinct effect identities", () => {
  const envelope = makeEnvelope(base);
  assert.notEqual(
    deriveEffectId("inventory", envelope, "reserve", "sku-a"),
    deriveEffectId("notifications", envelope, "reserve", "sku-a"),
  );
});

test("I05 one consumer's two effects from one event are distinct", () => {
  const envelope = makeEnvelope(base);
  assert.notEqual(
    deriveEffectId("inventory", envelope, "reserve", "sku-a"),
    deriveEffectId("inventory", envelope, "reserve", "sku-b"),
  );
});

test("I05b effect identity survives a regenerated event id, because it never used one", () => {
  const envelope = makeEnvelope(base);
  const republished = { ...envelope, eventId: "evt-regenerated-by-a-careless-publisher" };
  assert.equal(
    deriveEffectId("inventory", envelope, "reserve", "sku-a"),
    deriveEffectId("inventory", republished, "reserve", "sku-a"),
  );
});

test("I06 the ordering key is the aggregate, not the event", () => {
  const first = makeEnvelope(base);
  const second = makeEnvelope({ ...base, sequence: 2 });
  assert.equal(orderingKeyFor(first), orderingKeyFor(second));
  assert.equal(orderingKeyFor(first), "order:ord-1");
});

test("I07 the envelope carries the operation id without re-deriving it", () => {
  const envelope = makeEnvelope({ ...base, operationId: "op-from-the-caller" });
  assert.equal(envelope.operationId, "op-from-the-caller");
});

test("I08 causation is null at the head of a chain and set afterwards", () => {
  assert.equal(makeEnvelope(base).causationId, null);
  assert.equal(makeEnvelope({ ...base, causationId: "evt-prior" }).causationId, "evt-prior");
});

test("I09 a sequence that is not a positive integer is refused", () => {
  assert.throws(() => makeEnvelope({ ...base, sequence: 0 }), /positive integer/);
  assert.throws(() => makeEnvelope({ ...base, sequence: 1.5 }), /positive integer/);
});

test("I10 the hash is stable and width-fixed", () => {
  assert.equal(hash("abc"), hash("abc"));
  assert.equal(hash("abc").length, 16);
  assert.notEqual(hash("abc"), hash("abd"));
});
