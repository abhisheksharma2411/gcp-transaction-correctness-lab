import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decide, projectWaitMs } from "../src/admission.ts";
import { BASE_ADMISSION } from "../src/scenarios.ts";
import { view } from "./helpers.ts";

test("T1 an idle system admits immediately and promises no wait", () => {
  const d = decide(BASE_ADMISSION, view(), "acme", false);
  assert.equal(d.disposition, "ADMITTED");
  assert.equal(d.projectedWaitMs, 0);
});

test("T2 free slots absorb waiting work, so a shallow queue still promises zero", () => {
  assert.equal(projectWaitMs(view({ depth: 5, freeSlots: 20 })), 0);
});

test("T3 projected wait is queue-ahead divided by the measured drain rate", () => {
  // 220 waiting, 20 slots free, draining 200/s => 200 ahead => 1000 ms.
  assert.equal(projectWaitMs(view({ depth: 220, freeSlots: 20, drainRatePerSec: 200 })), 1000);
});

test("T4 a stalled system projects an infinite wait rather than a small one", () => {
  assert.equal(
    projectWaitMs(view({ depth: 10, freeSlots: 0, drainRatePerSec: 0 })),
    Number.POSITIVE_INFINITY,
  );
});

test("T5 work is refused once the projected wait exceeds the promise", () => {
  // Two tenants are active, so this one's share of a 200/s drain is 100/s.
  // Its own 250 queued jobs therefore project to 2500 ms, past the 2000 ms
  // promise, while staying under both the 360 per-tenant ceiling and the
  // 600-deep global backstop -- so the promise rule is what fires.
  const d = decide(
    BASE_ADMISSION,
    view({
      depth: 500,
      freeSlots: 0,
      drainRatePerSec: 200,
      perTenantDepth: new Map([["acme", 250], ["other", 250]]),
    }),
    "acme",
    false,
  );
  assert.equal(d.disposition, "REJECTED");
  assert.equal(d.reason, "PROJECTED_WAIT_EXCEEDS_PROMISE");
});

test("T6 the age rule fires even when the queue is shallow", () => {
  // Depth 3 is far below maxQueueDepth, but it has not moved for 2 seconds.
  const d = decide(BASE_ADMISSION, view({ depth: 3, oldestAgeMs: 2000, freeSlots: 0 }), "acme", false);
  assert.equal(d.disposition, "REJECTED");
  assert.equal(d.reason, "QUEUE_FULL");
});

test("T7 age is checked before depth, so a stalled shallow queue is not mistaken for a healthy one", () => {
  const stalled = view({ depth: 1, oldestAgeMs: 99_999, freeSlots: 0 });
  assert.equal(decide(BASE_ADMISSION, stalled, "acme", false).disposition, "REJECTED");
});

test("T8 one tenant cannot exceed its share even while capacity remains", () => {
  const ceiling = Math.floor(BASE_ADMISSION.maxQueueDepth * BASE_ADMISSION.maxTenantShare);
  const d = decide(
    BASE_ADMISSION,
    view({ depth: ceiling, freeSlots: 0, perTenantDepth: new Map([["flooder", ceiling]]) }),
    "flooder",
    false,
  );
  assert.equal(d.disposition, "REJECTED");
  assert.equal(d.reason, "TENANT_SHARE_EXCEEDED");
});

test("T9 a tenant under its share is still admitted while a neighbour is being throttled", () => {
  const ceiling = Math.floor(BASE_ADMISSION.maxQueueDepth * BASE_ADMISSION.maxTenantShare);
  const v = view({ depth: ceiling, freeSlots: 20, perTenantDepth: new Map([["flooder", ceiling]]) });
  assert.equal(decide(BASE_ADMISSION, v, "neighbour", false).disposition, "ADMITTED");
});

test("T10 deferrable work is offered a reservation instead of a refusal", () => {
  const d = decide(
    BASE_ADMISSION,
    view({ depth: 500, freeSlots: 0, perTenantDepth: new Map([["bulk-async", 500]]) }),
    "bulk-async",
    true,
  );
  assert.equal(d.disposition, "DEFERRED");
});

test("T11 deferral stops once the reservation backlog reaches its bound", () => {
  // The bug E9 caught: without this bound, deferral is a way of saying yes to
  // everything and discovering later that it expired.
  const d = decide(
    BASE_ADMISSION,
    view({
      depth: 500,
      freeSlots: 0,
      perTenantDepth: new Map([["bulk-async", 500]]),
      outstandingReservations: BASE_ADMISSION.maxReservations,
    }),
    "bulk-async",
    true,
  );
  assert.equal(d.disposition, "REJECTED");
});

test("T12 every refusal carries a reason the caller can act on", () => {
  const cases = [
    view({ depth: 3, oldestAgeMs: 99_999, freeSlots: 0 }),
    view({ depth: 500, freeSlots: 0, drainRatePerSec: 200, perTenantDepth: new Map([["acme", 500]]) }),
    view({ depth: 9999, freeSlots: 0, perTenantDepth: new Map([["acme", 9999]]) }),
  ];
  for (const v of cases) {
    const d = decide(BASE_ADMISSION, v, "acme", false);
    assert.equal(d.disposition, "REJECTED");
    assert.notEqual(d.reason, "NONE");
  }
});
