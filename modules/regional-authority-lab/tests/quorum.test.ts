import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MAJORITY,
  VOTING,
  everyMajorityPairIntersects,
  tryCommit,
  votesInRegion,
  type DurableLog,
} from "../src/quorum.ts";
import type { CommitResult, RegionId } from "../src/types.ts";

const log = (): DurableLog => new Map<string, CommitResult>();
const regions = (...r: RegionId[]) => new Set<RegionId>(r);

test("T1 the modelled topology matches the documented base multi-region shape", () => {
  // Two read-write regions with two replicas each, plus one witness.
  assert.equal(votesInRegion("us-east"), 2);
  assert.equal(votesInRegion("us-west"), 2);
  assert.equal(votesInRegion("witness"), 1);
  assert.equal(VOTING.length, 5);
  assert.equal(MAJORITY, 3);
});

test("T2 any two majorities of the voting set intersect", () => {
  // This is the whole reason a second accepted write cannot exist.
  assert.equal(everyMajorityPairIntersects(), true);
});

test("T3 a full cluster commits", () => {
  const r = tryCommit("a", "us-east", regions("us-east", "us-west", "witness"), 0, log());
  assert.equal(r.outcome, "COMMITTED");
  assert.ok(r.acks.length >= MAJORITY);
});

test("T4 a minority side cannot commit", () => {
  // The leader region alone is two votes out of five.
  const r = tryCommit("a", "us-east", regions("us-east"), 0, log());
  assert.equal(r.outcome, "NO_QUORUM");
  assert.ok(r.acks.length < MAJORITY);
});

test("T5 the non-leader region plus the witness is a majority and commits", () => {
  const r = tryCommit("a", "us-east", regions("us-west", "witness"), 0, log());
  assert.equal(r.outcome, "COMMITTED");
  assert.equal(r.acks.length, 3);
});

test("T6 losing the witness still leaves both read-write regions able to commit together", () => {
  const r = tryCommit("a", "us-east", regions("us-east", "us-west"), 0, log());
  assert.equal(r.outcome, "COMMITTED");
  assert.equal(r.acks.length, 4);
});

test("T7 a second write for the same operation is rejected, not accepted twice", () => {
  const l = log();
  assert.equal(tryCommit("dup", "us-east", regions("us-east", "us-west", "witness"), 0, l).outcome, "COMMITTED");
  assert.equal(tryCommit("dup", "us-east", regions("us-east", "us-west", "witness"), 1, l).outcome, "REJECTED_DUPLICATE");
});

test("T8 a different majority still sees the earlier commit, because majorities intersect", () => {
  const l = log();
  // Commit using east + witness.
  assert.equal(tryCommit("x", "us-east", regions("us-east", "witness"), 0, l).outcome, "COMMITTED");
  // Now a disjoint-looking side: west + witness. It must still see it.
  assert.equal(tryCommit("x", "us-east", regions("us-west", "witness"), 1, l).outcome, "REJECTED_DUPLICATE");
});

test("T9 a minority side cannot even observe, let alone accept", () => {
  const l = log();
  tryCommit("y", "us-east", regions("us-east", "us-west", "witness"), 0, l);
  const r = tryCommit("y", "us-east", regions("us-east"), 1, l);
  assert.equal(r.outcome, "NO_QUORUM");
});
