// Negative controls. Each removes one mechanism and asserts the property it
// claims actually breaks. A control that still passes was never evidence.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAJORITY, tryCommit, type DurableLog } from "../src/quorum.ts";
import { runScenario } from "../src/simulator.ts";
import { PARTITION_LEADER, SAFE, UNSAFE, scenario } from "../src/scenarios.ts";
import type { CommitResult, RegionId } from "../src/types.ts";

const log = (): DurableLog => new Map<string, CommitResult>();
const regions = (...r: RegionId[]) => new Set<RegionId>(r);

test("N1 without safe mode, the application fulfils what it cannot confirm", () => {
  const over = { partition: PARTITION_LEADER, operations: [{ id: "n1", atMs: 25_000, region: "us-east" as RegionId }] };
  const safe = runScenario(scenario("safe", SAFE, over));
  const unsafe = runScenario(scenario("unsafe", UNSAFE, over));

  assert.equal(safe.unconfirmedFulfilments, 0);
  assert.ok(
    unsafe.unconfirmedFulfilments > 0,
    "removing safe mode did not produce an unconfirmed fulfilment",
  );
  // And the database was blameless in both runs.
  assert.equal(safe.doubleCommits.length, 0);
  assert.equal(unsafe.doubleCommits.length, 0);
});

test("N2 without the majority requirement, two sides both accept the same operation", () => {
  // This is the control that proves quorum is what prevents split brain, and
  // not something else in the model.
  const l = log();
  const east = tryCommit("split", "us-east", regions("us-east"), 0, l, 1);
  const west = tryCommit("split", "us-east", regions("us-west"), 1, l, 1);

  assert.equal(east.outcome, "COMMITTED");
  assert.equal(west.outcome, "COMMITTED", "expected the second side to also accept without a majority rule");

  // With the rule restored, the same sequence cannot happen.
  const l2 = log();
  assert.equal(tryCommit("split", "us-east", regions("us-east"), 0, l2, MAJORITY).outcome, "NO_QUORUM");
  assert.equal(tryCommit("split", "us-east", regions("us-west"), 1, l2, MAJORITY).outcome, "NO_QUORUM");
});

test("N3 firing side effects before commit produces effects with nothing behind them", () => {
  const over = { partition: PARTITION_LEADER, operations: [{ id: "n3", atMs: 25_000, region: "us-east" as RegionId }] };
  const withEffects = runScenario(scenario("effects first", UNSAFE, over));
  const without = runScenario(scenario("effects after", { ...UNSAFE, sideEffectBeforeCommit: false }, over));

  assert.ok(withEffects.sideEffectsWithoutCommit > 0);
  assert.equal(without.sideEffectsWithoutCommit, 0);
});

test("N4 both sides of a partition answer the customer when local state is trusted", () => {
  const over = {
    partition: PARTITION_LEADER,
    operations: [
      { id: "n4", atMs: 25_000, region: "us-east" as RegionId },
      { id: "n4", atMs: 25_500, region: "us-west" as RegionId },
    ],
  };
  const safe = runScenario(scenario("safe", SAFE, over));
  const unsafe = runScenario(scenario("unsafe", UNSAFE, over));

  // Safe: nobody is told yes without authority.
  assert.equal(safe.decisions.filter((d) => d.outcome === "FULFILLED").length, 0);
  assert.equal(safe.safeModeCount, 2);

  // Unsafe: both regions say yes for one operation.
  assert.equal(unsafe.decisions.filter((d) => d.outcome === "FULFILLED").length, 2);
  assert.equal(unsafe.unconfirmedFulfilments, 2);

  // In both runs the database accepted at most one write.
  assert.equal(safe.doubleCommits.length, 0);
  assert.equal(unsafe.doubleCommits.length, 0);
});

test("N5 the witness replica is load-bearing for availability, not for safety", () => {
  // Without the witness reachable, the two read-write regions alone still
  // reach four votes and commit. With only one read-write region, they cannot.
  const l = log();
  assert.equal(tryCommit("w", "us-east", regions("us-east", "us-west"), 0, l).outcome, "COMMITTED");
  assert.equal(tryCommit("w2", "us-east", regions("us-east"), 1, log()).outcome, "NO_QUORUM");
  // The witness is what lets a single surviving read-write region form a quorum.
  assert.equal(tryCommit("w3", "us-east", regions("us-west", "witness"), 2, log()).outcome, "COMMITTED");
});
