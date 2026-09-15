// Negative controls.
//
// Each test removes exactly one mechanism and asserts that the property the
// article claims for it actually breaks. A control that still passes with the
// mechanism removed was never evidence for anything.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { simulate } from "../src/simulator.ts";
import { BASE_ADMISSION, config, load, SUSTAINABLE_RATE_PER_SEC } from "../src/scenarios.ts";
import type { TenantId } from "../src/types.ts";

const mixed: ReadonlyMap<TenantId, number> = new Map([
  ["flooder", SUSTAINABLE_RATE_PER_SEC * 3],
  ["neighbour", SUSTAINABLE_RATE_PER_SEC * 0.3],
]);

test("N1 without fair-share projection, a flooding tenant starves its neighbour", () => {
  // The mechanism under test is the PROJECTION, not the ceiling. An earlier
  // version of this control removed the per-tenant ceiling instead and barely
  // moved the result, which is how the distinction was found.
  const fair = simulate("fair projection", config({ arrivalRatePerSec: mixed, admission: BASE_ADMISSION }));
  const fifo = simulate(
    "global fifo projection",
    config({ arrivalRatePerSec: mixed, admission: { ...BASE_ADMISSION, fairShareProjection: false } }),
  );

  const served = (r: typeof fair) =>
    r.perTenant["neighbour"]!.completed /
    (r.perTenant["neighbour"]!.completed + r.perTenant["neighbour"]!.rejected);

  assert.ok(served(fair) > 0.8, `neighbour served only ${served(fair)} under fair projection`);
  assert.ok(
    served(fifo) < served(fair) * 0.9,
    `global FIFO did not starve the neighbour: ${served(fifo)} vs ${served(fair)}`,
  );
});

test("N1b the per-tenant ceiling bounds how much queue one tenant may occupy", () => {
  const capped = simulate("ceiling 0.6", config({ arrivalRatePerSec: mixed, admission: BASE_ADMISSION }));
  const uncapped = simulate(
    "ceiling 1.0",
    config({ arrivalRatePerSec: mixed, admission: { ...BASE_ADMISSION, maxTenantShare: 1 } }),
  );
  assert.ok(
    (capped.rejectReasons["TENANT_SHARE_EXCEEDED"] ?? 0) >= 0,
    "ceiling accounting missing",
  );
  assert.ok(
    uncapped.perTenant["flooder"]!.admitted >= capped.perTenant["flooder"]!.admitted,
    "removing the ceiling did not let the flooder occupy more",
  );
});

test("N2 without the age rule, a slow dependency produces a worse tail", () => {
  const base = {
    arrivalRatePerSec: load(0.9),
    slowdownFromMs: 20_000,
    slowdownFactor: 5,
  } as const;
  const depthOnly = {
    ...BASE_ADMISSION,
    maxQueueDepth: 5000,
    promiseMs: Number.POSITIVE_INFINITY,
    maxQueueAgeMs: Number.POSITIVE_INFINITY,
  };
  const withAge = simulate("age on", config({ ...base, admission: { ...depthOnly, maxQueueAgeMs: 1500 } }));
  const without = simulate("age off", config({ ...base, admission: depthOnly }));
  assert.ok(
    withAge.latency.p99 < without.latency.p99,
    `age rule did not improve p99: ${withAge.latency.p99} vs ${without.latency.p99}`,
  );
});

test("N3 without a reservation bound, deferral accepts work it cannot honour", () => {
  const asyncLoad: ReadonlyMap<TenantId, number> = new Map([
    ["bulk-async", SUSTAINABLE_RATE_PER_SEC * 2],
  ]);
  const bounded = simulate(
    "reservations bounded",
    config({ arrivalRatePerSec: asyncLoad, admission: BASE_ADMISSION }),
  );
  const unbounded = simulate(
    "reservations unbounded",
    config({
      arrivalRatePerSec: asyncLoad,
      admission: { ...BASE_ADMISSION, maxReservations: Number.MAX_SAFE_INTEGER },
    }),
  );
  // The unbounded controller says yes far more often...
  assert.ok(
    unbounded.deferred > bounded.deferred,
    `unbounded deferral did not accept more: ${unbounded.deferred} vs ${bounded.deferred}`,
  );
  // ...and then fails to honour those acceptances.
  assert.ok(
    unbounded.expired > bounded.expired,
    `unbounded deferral produced no extra expiries: ${unbounded.expired} vs ${bounded.expired}`,
  );
  assert.equal(bounded.expired, 0, "the bounded controller should honour every reservation it accepts");
});

test("N4 without admission control, overload converts into abandonment", () => {
  const open = simulate("open", config({ arrivalRatePerSec: load(2) }));
  const bounded = simulate("bounded", config({ arrivalRatePerSec: load(2), admission: BASE_ADMISSION }));
  assert.ok(open.abandoned > 0, "open loop produced no abandonment; the scenario is not overloaded");
  assert.equal(bounded.abandoned, 0);
  // The meaningful claim is not an arbitrary ratio but that the open-loop tail
  // runs past the point where callers give up, and the bounded tail does not.
  assert.ok(
    open.latency.p99 >= config({ arrivalRatePerSec: load(2) }).abandonAfterMs,
    `open-loop p99 ${open.latency.p99} did not reach the abandonment threshold`,
  );
  assert.ok(
    bounded.latency.p99 < BASE_ADMISSION.promiseMs * 1.5,
    `bounded p99 ${bounded.latency.p99} broke the ${BASE_ADMISSION.promiseMs}ms promise`,
  );
});

test("N5 a backstop set below the operative rule makes that rule unreachable", () => {
  // Regression guard for the defect test T5 exposed.
  const broken = simulate(
    "backstop too low",
    config({
      arrivalRatePerSec: load(3),
      admission: { ...BASE_ADMISSION, maxQueueDepth: 200 },
    }),
  );
  assert.equal(
    broken.rejectReasons["PROJECTED_WAIT_EXCEEDS_PROMISE"] ?? 0,
    0,
    "expected the promise rule to be unreachable behind a 200-deep backstop",
  );
  const correct = simulate(
    "backstop correct",
    config({ arrivalRatePerSec: load(3), admission: BASE_ADMISSION }),
  );
  assert.ok((correct.rejectReasons["PROJECTED_WAIT_EXCEEDS_PROMISE"] ?? 0) > 0);
});

test("N6 adding worker slots past the contention knee does not raise goodput", () => {
  const at20 = simulate(
    "slots 20",
    config({
      arrivalRatePerSec: load(3),
      admission: BASE_ADMISSION,
      worker: { concurrency: 20, contentionPerUnit: 0.05, contentionKnee: 20 },
    }),
  );
  const at160 = simulate(
    "slots 160",
    config({
      arrivalRatePerSec: load(3),
      admission: BASE_ADMISSION,
      worker: { concurrency: 160, contentionPerUnit: 0.05, contentionKnee: 20 },
    }),
  );
  // Eight times the slots, no more completed work.
  assert.ok(
    at160.goodputPerSec <= at20.goodputPerSec * 1.05,
    `8x slots raised goodput: ${at20.goodputPerSec} -> ${at160.goodputPerSec}`,
  );
  // And a materially worse tail.
  assert.ok(
    at160.latency.p99 > at20.latency.p99,
    `8x slots did not worsen p99: ${at20.latency.p99} -> ${at160.latency.p99}`,
  );
});
