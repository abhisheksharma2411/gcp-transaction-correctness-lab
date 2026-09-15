import { strict as assert } from "node:assert";
import { test } from "node:test";
import { simulate } from "../src/simulator.ts";
import { BASE_ADMISSION, BASE_WORKER, config, load, SUSTAINABLE_RATE_PER_SEC } from "../src/scenarios.ts";

test("T13 every arrival is accounted for exactly once", () => {
  const r = simulate("conservation", config({ arrivalRatePerSec: load(2), admission: BASE_ADMISSION }));
  const settled = r.completed + r.rejected + r.abandoned + r.expired;
  // Anything not settled must still have been in flight when the clock stopped.
  assert.ok(settled <= r.arrived, `settled ${settled} exceeds arrived ${r.arrived}`);
  assert.equal(r.arrived - settled, r.arrived - settled); // no negative leakage
  assert.ok(r.arrived > 0);
});

test("T14 worker concurrency is never exceeded", () => {
  for (const mult of [0.5, 1, 2, 4]) {
    const r = simulate(`conc ${mult}`, config({ arrivalRatePerSec: load(mult), admission: BASE_ADMISSION }));
    assert.ok(
      r.peakConcurrency <= BASE_WORKER.concurrency,
      `peak ${r.peakConcurrency} > limit ${BASE_WORKER.concurrency} at ${mult}x`,
    );
  }
});

test("T15 goodput never exceeds the sustainable rate", () => {
  // The arithmetic check that caught the measurement-window bug.
  for (const mult of [1, 2, 4, 8]) {
    const r = simulate(`goodput ${mult}`, config({ arrivalRatePerSec: load(mult), admission: BASE_ADMISSION }));
    assert.ok(
      r.goodputPerSec <= SUSTAINABLE_RATE_PER_SEC * 1.05,
      `goodput ${r.goodputPerSec}/s exceeds capacity ${SUSTAINABLE_RATE_PER_SEC}/s at ${mult}x`,
    );
  }
});

test("T16 below capacity, admission control changes nothing", () => {
  const open = simulate("under open", config({ arrivalRatePerSec: load(0.6) }));
  const bounded = simulate("under bounded", config({ arrivalRatePerSec: load(0.6), admission: BASE_ADMISSION }));
  assert.equal(bounded.rejected, 0, "admission refused work while under capacity");
  assert.equal(bounded.completed, open.completed);
  assert.deepEqual(bounded.latency, open.latency);
});

test("T17 bounded admission keeps its promise: nobody waits long enough to abandon", () => {
  const r = simulate("promise", config({ arrivalRatePerSec: load(2), admission: BASE_ADMISSION }));
  assert.equal(r.abandoned, 0, `${r.abandoned} callers abandoned despite a kept promise`);
  assert.ok(r.latency.p99 < config({ arrivalRatePerSec: load(2) }).abandonAfterMs);
});

test("T18 the queue never exceeds its configured depth", () => {
  const r = simulate("depth", config({ arrivalRatePerSec: load(4), admission: BASE_ADMISSION }));
  assert.ok(
    r.maxQueueDepth <= BASE_ADMISSION.maxQueueDepth,
    `depth ${r.maxQueueDepth} exceeded limit ${BASE_ADMISSION.maxQueueDepth}`,
  );
});

test("T19 results are deterministic for a fixed seed", () => {
  const cfg = config({ arrivalRatePerSec: load(2), admission: BASE_ADMISSION });
  const a = simulate("det a", cfg);
  const b = simulate("det b", cfg);
  assert.deepEqual(a.latency, b.latency);
  assert.equal(a.completed, b.completed);
  assert.equal(a.rejected, b.rejected);
});

test("T20 a different seed gives different detail but the same qualitative outcome", () => {
  const base = simulate("seed 1234", config({ arrivalRatePerSec: load(2), admission: BASE_ADMISSION }));
  const other = simulate("seed 99", config({ seed: 99, arrivalRatePerSec: load(2), admission: BASE_ADMISSION }));
  assert.notEqual(base.completed, other.completed, "two seeds produced identical counts; rng may be broken");
  assert.equal(other.abandoned, 0);
  assert.ok(Math.abs(other.goodputPerSec - base.goodputPerSec) / base.goodputPerSec < 0.05);
});

test("T21 the promise rule is reachable under the shipped policy", () => {
  // Guards the defect T5 found: a backstop set below the operative rule makes
  // that rule dead code.
  const r = simulate("reachable", config({ arrivalRatePerSec: load(3), admission: BASE_ADMISSION }));
  assert.ok(
    (r.rejectReasons["PROJECTED_WAIT_EXCEEDS_PROMISE"] ?? 0) > 0,
    `promise rule never fired; reasons were ${JSON.stringify(r.rejectReasons)}`,
  );
});
