import type { CommitResult, RegionId, Replica } from "./types.ts";

/**
 * The documented base multi-region shape: two read-write regions with two
 * read-write replicas each, plus a witness replica in a third region. Five
 * voting replicas, so a majority is three.
 *
 * Source: instance-configurations, "Each base multi-region configuration
 * contains two regions that are designated as read-write regions, each of
 * which contains two read-write replicas" and "Spanner also places a witness
 * replica in a third region".
 */
export const REPLICAS: readonly Replica[] = [
  { id: "east-a", region: "us-east", role: "read-write", votes: true },
  { id: "east-b", region: "us-east", role: "read-write", votes: true },
  { id: "west-a", region: "us-west", role: "read-write", votes: true },
  { id: "west-b", region: "us-west", role: "read-write", votes: true },
  { id: "witness-a", region: "witness", role: "witness", votes: true },
];

export const VOTING = REPLICAS.filter((r) => r.votes);
export const MAJORITY = Math.floor(VOTING.length / 2) + 1; // 3 of 5

/**
 * The durable log, keyed by operation id. One logical database.
 *
 * Reads of this map are only permitted to a caller that has assembled a
 * majority, which is the modelling point below.
 */
export type DurableLog = Map<string, CommitResult>;

/**
 * Try to commit from a given partition of the cluster.
 *
 * `reachable` is the set of regions the committing replica can see. Two rules
 * do all the work here, and between them they make the GitHub failure mode
 * structurally unavailable:
 *
 *   1. **Majority.** A minority side cannot assemble a majority, so it cannot
 *      commit. Source: replication, "The write is committed when a majority of
 *      voting replicas (or write quorum) agree to commit the write."
 *
 *   2. **Intersection.** Any two majorities of five voting replicas share at
 *      least one member. So a side that CAN commit necessarily includes a
 *      replica that witnessed every earlier commit. It cannot accept a second
 *      write for an operation that already has a durable outcome, because it
 *      can see that outcome.
 *
 * Rule 2 is why `doubleCommits` is empty in every scenario rather than merely
 * empty in the ones that were tested. It is a property of the quorum, not of
 * the workload.
 */
export function tryCommit(
  operationId: string,
  leaderRegion: RegionId,
  reachable: ReadonlySet<RegionId>,
  atMs: number,
  log: DurableLog,
  /**
   * Negative control N2 sets this to 1 to remove the majority requirement.
   * Nothing in the library should ever pass anything but the default; it
   * exists so a test can show that removing the rule breaks the property,
   * rather than asserting that the rule matters and hoping.
   */
  requiredAcks: number = MAJORITY,
): CommitResult {
  const acks = VOTING.filter((r) => reachable.has(r.region)).map((r) => r.id);
  if (acks.length < requiredAcks) {
    return { operationId, outcome: "NO_QUORUM", acks, leaderRegion, atMs };
  }
  // Majority in hand, therefore intersecting every previous majority,
  // therefore able to see any prior durable outcome for this operation. With
  // the majority requirement removed, two disjoint sides can each believe they
  // hold authority, and neither can see the other's writes -- which is exactly
  // the failure N2 reproduces.
  const canSeePriorWrites = acks.length >= MAJORITY;
  const prior = canSeePriorWrites ? log.get(operationId) : undefined;
  if (prior) {
    return { operationId, outcome: "REJECTED_DUPLICATE", acks, leaderRegion, atMs };
  }
  const result: CommitResult = { operationId, outcome: "COMMITTED", acks, leaderRegion, atMs };
  log.set(operationId, result);
  return result;
}

/** Proof obligation for the article's claim, checked in the tests. */
export function everyMajorityPairIntersects(): boolean {
  const ids = VOTING.map((r) => r.id);
  const majorities: string[][] = [];
  const build = (start: number, acc: string[]): void => {
    if (acc.length >= MAJORITY) { majorities.push([...acc]); return; }
    for (let i = start; i < ids.length; i += 1) build(i + 1, [...acc, ids[i]!]);
  };
  build(0, []);
  for (const a of majorities) {
    for (const b of majorities) {
      if (!a.some((x) => b.includes(x))) return false;
    }
  }
  return true;
}

/** Voting replicas a region contributes. Used by tests and by the article's table. */
export function votesInRegion(region: RegionId): number {
  return VOTING.filter((r) => r.region === region).length;
}
