// The four layers, and which one catches what.

import { test } from "node:test";
import assert from "node:assert/strict";
import { IdempotencyStore, UniquenessViolation } from "../src/store.ts";
import { EffectLedger, SimulatedProvider } from "../src/effects.ts";
import { OperationProcessor } from "../src/processor.ts";
import { fingerprint, effectId } from "../src/fingerprint.ts";
import type { OperationContext } from "../src/types.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5);
const PAY = { amount: 2500, currency: "EUR" };

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    operationId: "op-1", businessRef: "ref-1", fingerprint: fingerprint(PAY),
    origin: "api", attempt: 1, ...over,
  };
}

test("L1 the business constraint refuses a second id for one reference", () => {
  const s = new IdempotencyStore();
  s.begin(ctx(), T0);
  assert.throws(() => s.begin(ctx({ operationId: "op-2" }), T0), UniquenessViolation);
});

test("L2 the business index survives eviction of the idempotency record", () => {
  const s = new IdempotencyStore();
  s.begin(ctx(), T0);
  s.complete("op-1", "SUCCEEDED", { ok: true }, T0);
  assert.equal(s.evictExpired(T0 + 2 * HOUR, HOUR), 1);
  assert.equal(s.get("op-1"), null, "the record is gone");
  assert.equal(s.heldBy("ref-1"), "op-1", "the constraint is not");
});

test("L3 an in-progress record is never evicted", () => {
  const s = new IdempotencyStore();
  s.begin(ctx(), T0);
  assert.equal(s.evictExpired(T0 + 1000 * HOUR, HOUR), 0);
});

test("L4 the effect ledger deduplicates on effect identity", () => {
  const l = new EffectLedger();
  const eid = effectId("op-1", "notify");
  assert.equal(l.apply(eid, "op-1", "notify", T0), "APPLIED");
  assert.equal(l.apply(eid, "op-1", "notify", T0), "DUPLICATE_SUPPRESSED");
  assert.equal(l.count, 1);
  assert.equal(l.suppressedCount, 1);
});

test("L5 one operation with two effect kinds produces two effects", () => {
  const l = new EffectLedger();
  l.apply(effectId("op-1", "notify"), "op-1", "notify", T0);
  l.apply(effectId("op-1", "provision"), "op-1", "provision", T0);
  assert.equal(l.count, 2);
  assert.equal(l.countFor("op-1"), 2);
});

test("L6 the provider recognises a key it has already seen", () => {
  const p = new SimulatedProvider();
  const first = p.call("op-1", "ok", T0);
  const second = p.call("op-1", "ok", T0);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.reference, first.reference);
  assert.equal(p.attempts, 2, "two calls were made");
});

test("L7 a timed-out provider call still happened at the provider", () => {
  const p = new SimulatedProvider();
  const lost = p.call("op-1", "unknown", T0);
  assert.equal(lost.outcome, "UNKNOWN");
  assert.equal(lost.reference, undefined, "the caller learns nothing");

  // ...but the work is recorded, which is why the retry is deduplicated and
  // why a lookup can settle it.
  const retry = p.call("op-1", "ok", T0 + 1000);
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.outcome, "SUCCEEDED");
  assert.equal(p.lookup("op-1")?.outcome, "SUCCEEDED");
});

test("L8 a provider lookup is impossible without a stable key", () => {
  const p = new SimulatedProvider();
  p.call("op-1-attempt-1", "unknown", T0);
  // The retry minted a new key, so there is nothing to ask about.
  assert.equal(p.lookup("op-1-attempt-2"), null);
});

test("L9 the processor reports which layer stopped each duplicate", () => {
  const p = new OperationProcessor({ retentionMs: HOUR });
  assert.equal(p.submit(ctx(), T0).caughtBy, null);
  assert.equal(p.submit(ctx(), T0).caughtBy, "contract");
  assert.equal(p.submit(ctx({ operationId: "op-2" }), T0).caughtBy, "business-uniqueness");
});

test("L10 after eviction the effect ledger is the only thing left", () => {
  const p = new OperationProcessor({ retentionMs: HOUR });
  p.submit(ctx(), T0);
  p.store.evictExpired(T0 + 2 * HOUR, HOUR);

  const replay = p.submit(ctx({ origin: "replay" }), T0 + 2 * HOUR);
  assert.equal(replay.decision, "FIRST", "the contract has nothing left to say");
  assert.equal(replay.caughtBy, "effect-ledger");
  assert.equal(p.effects.count, 1);
});

test("L11 an unknown outcome leaves the operation open, not guessed", () => {
  const p = new OperationProcessor({ retentionMs: HOUR, providerMode: () => "unknown" });
  const r = p.submit(ctx(), T0);
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.effectApplied, false);
  assert.equal(p.effects.count, 0);
  assert.equal(p.store.get("op-1")?.completedAtMs, null);
});

test("L12 resolution turns an unknown into a fact using the stable key", () => {
  const p = new OperationProcessor({ retentionMs: HOUR, providerMode: () => "unknown" });
  p.submit(ctx(), T0);
  const resolved = p.resolveUnknown("op-1", T0 + 30_000);
  assert.equal(resolved.outcome, "SUCCEEDED");
  assert.equal(resolved.effectApplied, true);
  assert.equal(p.effects.count, 1);
});

test("L13 resolving a settled operation is refused", () => {
  const p = new OperationProcessor({ retentionMs: HOUR });
  p.submit(ctx(), T0);
  assert.throws(() => p.resolveUnknown("op-1", T0), /not awaiting resolution/);
});

test("L14 the four tallies are counted separately", () => {
  const p = new OperationProcessor({ retentionMs: HOUR });
  for (let i = 0; i < 5; i += 1) p.submit(ctx(), T0 + i);
  assert.equal(p.tally.arrivals, 5);
  assert.equal(p.tally.admitted, 1);
  assert.equal(p.tally.providerAttempts, 1);
  assert.equal(p.tally.effects, 1);
});
