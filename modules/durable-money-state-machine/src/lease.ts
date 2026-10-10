// Leases: who is responsible for moving this entity forward, and by when.
//
// The version check and the lease answer different questions, and conflating
// them is the defect this file exists to prevent.
//
//   version check -> "did anyone move this since I read it?"   (a point)
//   lease         -> "is anyone moving this at all?"           (a duration)
//
// A process that stopped leaves the version untouched, so the version check is
// satisfied forever and the entity sits in SUBMITTED until somebody notices by
// hand. The lease is what notices.
//
// A database lock is not a substitute. Spanner's documentation says that if a
// client "remains inactive for long periods of time", Spanner "might release
// the transaction's locks and abort the transaction" -- a lock lives inside a
// transaction, and a business process that waits six hours for a provider
// cannot hold a transaction open for six hours. The lease is a row.

import { LEASE_TTL_MS } from "./spec.ts";
import { TERMINAL_OF } from "./policy.ts";
import { specFor } from "./machine.ts";
import type { Lease, Payout } from "./types.ts";

export type ClaimResult =
  | { readonly kind: "CLAIMED"; readonly payout: Payout }
  | { readonly kind: "HELD_BY_OTHER"; readonly ownerId: string; readonly expiresAtMs: number }
  | { readonly kind: "TERMINAL" };

/**
 * Take the right to advance this entity.
 *
 * Claiming is not the same as doing the work again. The new owner reads the
 * recorded state and continues from it; the recorded state is why there is
 * nothing to redo. This is the entire difference between resuming a process
 * and restarting one.
 */
export function claim(payout: Payout, ownerId: string, nowMs: number, ttlMs = LEASE_TTL_MS): ClaimResult {
  if (TERMINAL_OF(specFor(payout)).has(payout.state)) return { kind: "TERMINAL" };
  const held = payout.lease;
  if (held !== null && held.ownerId !== ownerId && held.expiresAtMs > nowMs) {
    return { kind: "HELD_BY_OTHER", ownerId: held.ownerId, expiresAtMs: held.expiresAtMs };
  }
  const lease: Lease = {
    ownerId,
    expiresAtMs: nowMs + ttlMs,
    takenAtSeq: payout.history.length - 1,
  };
  return { kind: "CLAIMED", payout: { ...payout, lease } };
}

/** Extend a lease the caller already holds. A worker that is still alive says so. */
export function renew(payout: Payout, ownerId: string, nowMs: number, ttlMs = LEASE_TTL_MS): Payout {
  const held = payout.lease;
  if (held === null || held.ownerId !== ownerId) return payout;
  return { ...payout, lease: { ...held, expiresAtMs: nowMs + ttlMs } };
}

/**
 * Give the lease back.
 *
 * A worker that shuts down cleanly should do this. Cloud Run gives it ten
 * seconds: the documentation says a SIGTERM "indicat[es] the start of a 10
 * second period before the actual shutdown occurs, at which point Cloud Run
 * sends a SIGKILL signal." Ten seconds is enough to release a lease and not
 * much else, which is an argument for making release the only cleanup a
 * shutdown handler has to perform.
 */
export function release(payout: Payout, ownerId: string): Payout {
  const held = payout.lease;
  if (held === null || held.ownerId !== ownerId) return payout;
  return { ...payout, lease: null };
}

/** Whether this entity is currently claimed by a live worker. */
export function isLeased(payout: Payout, nowMs: number): boolean {
  return payout.lease !== null && payout.lease.expiresAtMs > nowMs;
}

/**
 * The states in which nobody is expected to be holding a lease, because the
 * process is waiting on somebody outside the system.
 *
 * SUBMITTED waits on the provider. MANUAL_REVIEW waits on a person. Neither is
 * stuck merely because no worker is attached to it -- which is why staleness
 * needs its own deadline, separate from the lease.
 */
export const WAITING_STATES = ["SUBMITTED", "MANUAL_REVIEW"] as const;

export interface Stuck {
  readonly payoutId: string;
  readonly state: string;
  readonly reason: "LEASE_EXPIRED" | "WAITING_TOO_LONG";
  readonly sinceMs: number;
  readonly ageMs: number;
}

/**
 * The sweep.
 *
 * Two different kinds of stuck, and they need different answers:
 *
 *  - LEASE_EXPIRED: a worker took this entity and did not come back. Another
 *    worker may claim it and continue. Nothing is wrong with the business
 *    process; a machine died.
 *  - WAITING_TOO_LONG: the entity has sat in a waiting state past its own
 *    deadline. No worker is at fault and claiming it changes nothing. This is
 *    the case that needs a human or a lookup.
 *
 * Reporting both as "stuck" and treating them the same is how an operator ends
 * up restarting a worker to fix a provider outage.
 */
export function sweep(
  payouts: readonly Payout[], nowMs: number, waitingLimitMs: number,
): readonly Stuck[] {
  const out: Stuck[] = [];
  for (const p of payouts) {
    if (TERMINAL_OF(specFor(p)).has(p.state)) continue;
    const lease = p.lease;
    if (lease !== null && lease.expiresAtMs <= nowMs) {
      out.push({
        payoutId: p.id,
        state: p.state,
        reason: "LEASE_EXPIRED",
        sinceMs: lease.expiresAtMs,
        ageMs: nowMs - lease.expiresAtMs,
      });
      continue;
    }
    const last = p.history[p.history.length - 1]!;
    if ((WAITING_STATES as readonly string[]).includes(p.state) && nowMs - last.atMs >= waitingLimitMs) {
      out.push({
        payoutId: p.id,
        state: p.state,
        reason: "WAITING_TOO_LONG",
        sinceMs: last.atMs,
        ageMs: nowMs - last.atMs,
      });
    }
  }
  return out.sort((a, b) => (a.payoutId < b.payoutId ? -1 : a.payoutId > b.payoutId ? 1 : 0));
}
