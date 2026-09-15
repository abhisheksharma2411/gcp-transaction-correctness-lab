import type { RegionId } from "./types.ts";

/**
 * Write latency as a count of cross-region round trips.
 *
 * Not milliseconds, deliberately. Real latency depends on the region pair and
 * would be invented if quoted here. Round trips are structural and can be
 * reasoned about honestly.
 *
 * Leader-aware routing is enabled by default and routes session creation to
 * the leader region "even if the write doesn't originate from the leader
 * region". So a write issued outside the leader region does not avoid the
 * leader; it pays to reach it.
 */
export function writeRoundTrips(from: RegionId, leader: RegionId): number {
  // One round trip for the quorum itself, plus one to reach the leader when
  // the caller is not co-located with it.
  return from === leader ? 1 : 2;
}

/** Strong reads need the leader's timestamp; stale reads do not. */
export function readRoundTrips(from: RegionId, leader: RegionId, strong: boolean): number {
  if (!strong) return 0; // servable locally
  return from === leader ? 1 : 2;
}
