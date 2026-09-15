import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runScenario } from "../src/simulator.ts";
import { LOSE_LEADER, PARTITION_LEADER, SAFE, UNSAFE, scenario } from "../src/scenarios.ts";
import { writeRoundTrips, readRoundTrips } from "../src/latency.ts";
import type { RegionId } from "../src/types.ts";

const EVERY_FAULT = [
  { name: "healthy", over: {} },
  { name: "leader partitioned", over: { partition: PARTITION_LEADER } },
  { name: "leader region lost", over: { regionLoss: LOSE_LEADER } },
];

const BOTH_REGIONS: RegionId[] = ["us-east", "us-west"];

test("T10 no operation is ever accepted twice, under any fault and either policy", () => {
  // The article's core invariant. If this ever fails the model is wrong.
  for (const fault of EVERY_FAULT) {
    for (const app of [SAFE, UNSAFE]) {
      for (const region of BOTH_REGIONS) {
        for (const at of [1_000, 22_000, 25_000, 35_000, 50_000]) {
          const r = runScenario(scenario(`${fault.name}`, app, {
            ...fault.over,
            operations: [
              { id: "inv", atMs: at, region },
              { id: "inv", atMs: at + 500, region: region === "us-east" ? "us-west" : "us-east" },
            ],
          }));
          assert.equal(
            r.doubleCommits.length, 0,
            `double commit under ${fault.name}/${region}@${at}: ${r.doubleCommits.join(",")}`,
          );
        }
      }
    }
  }
});

test("T11 the safe policy never fulfils without confirmation", () => {
  for (const fault of EVERY_FAULT) {
    for (const region of BOTH_REGIONS) {
      const r = runScenario(scenario(fault.name, SAFE, {
        ...fault.over,
        operations: [{ id: "s", atMs: 25_000, region }],
      }));
      assert.equal(r.unconfirmedFulfilments, 0, `${fault.name}/${region}`);
      assert.equal(r.sideEffectsWithoutCommit, 0);
    }
  }
});

test("T12 the safe policy refuses rather than guessing when authority is unreachable", () => {
  const r = runScenario(scenario("partitioned minority", SAFE, {
    partition: PARTITION_LEADER,
    operations: [{ id: "g", atMs: 25_000, region: "us-east" }],
  }));
  assert.equal(r.decisions[0]!.outcome, "SAFE_MODE");
  assert.equal(r.safeModeCount, 1);
});

test("T13 the majority side keeps serving during a partition", () => {
  const r = runScenario(scenario("majority side", SAFE, {
    partition: PARTITION_LEADER,
    operations: [{ id: "m", atMs: 35_000, region: "us-west" }],
  }));
  assert.equal(r.decisions[0]!.outcome, "FULFILLED");
  assert.equal(r.safeModeCount, 0);
});

test("T14 authority moves to the second read-write region after the election window", () => {
  const during = runScenario(scenario("electing", SAFE, {
    regionLoss: LOSE_LEADER,
    operations: [{ id: "d", atMs: 22_000, region: "us-west" }],
  }));
  const after = runScenario(scenario("elected", SAFE, {
    regionLoss: LOSE_LEADER,
    operations: [{ id: "a", atMs: 35_000, region: "us-west" }],
  }));
  assert.equal(during.decisions[0]!.outcome, "SAFE_MODE", "should refuse inside the election window");
  assert.equal(after.decisions[0]!.outcome, "FULFILLED", "should serve once a new leader exists");
});

test("T15 the leader returns to the preferred region after recovery", () => {
  const r = runScenario(scenario("failback", SAFE, {
    regionLoss: LOSE_LEADER,
    operations: [{ id: "f", atMs: 50_000, region: "us-east" }],
  }));
  const late = r.leaderRegionOverTime.filter((p) => p.atMs >= 45_000);
  assert.ok(late.every((p) => p.leader === "us-east"), "leader did not fail back");
});

test("T16 operation identity survives being routed to the other region", () => {
  const r = runScenario(scenario("reroute", SAFE, {
    operations: [
      { id: "same", atMs: 1_000, region: "us-east" },
      { id: "same", atMs: 2_000, region: "us-west" },
    ],
  }));
  assert.equal(r.doubleCommits.length, 0);
  assert.ok(r.decisions.every((d) => d.outcome === "FULFILLED"), "both attempts should converge");
});

test("T17 a write outside the leader region costs an extra round trip", () => {
  // Leader-aware routing sends the session to the leader either way, so the
  // cost is structural rather than avoidable by writing locally.
  assert.equal(writeRoundTrips("us-east", "us-east"), 1);
  assert.equal(writeRoundTrips("us-west", "us-east"), 2);
});

test("T18 stale reads are servable locally, strong reads are not", () => {
  assert.equal(readRoundTrips("us-west", "us-east", false), 0);
  assert.equal(readRoundTrips("us-west", "us-east", true), 2);
  assert.equal(readRoundTrips("us-east", "us-east", true), 1);
});
