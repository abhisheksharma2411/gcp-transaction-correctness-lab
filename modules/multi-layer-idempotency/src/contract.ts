// The contract.
//
// One pure function. No clock, no store, no I/O -- everything it needs is an
// argument. That is what makes it language-neutral: a Java, Go or Kotlin
// implementation satisfies the same conformance matrix by reimplementing this
// one function, and `conformance.ts` will tell it whether it got it right.

import type { Decision, OperationContext, OperationRecord } from "./types.ts";

/**
 * What to do with an arriving copy of an operation.
 *
 * @param record      what the store holds for this operation id, or null
 * @param incoming    the arriving copy
 * @param nowMs       the instant of the decision
 * @param retentionMs how long a completed record stays authoritative
 *
 * The ordering of the checks below is the contract, not an implementation
 * detail. Three of the four orderings produce a system that is wrong in a way
 * nobody notices until it matters.
 */
export function decide(
  record: OperationRecord | null,
  incoming: OperationContext,
  nowMs: number,
  retentionMs: number,
): Decision {
  // 1. Nothing recorded.
  //
  // This is the dangerous branch, and it is dangerous precisely because it is
  // indistinguishable from a genuine first request. A record that was evicted
  // produces exactly this. See ADR-002 and the retention-expiry scenario.
  if (record === null) return "FIRST";

  if (record.operationId !== incoming.operationId) {
    throw new Error(
      `store returned record for ${record.operationId} when asked for ${incoming.operationId}`,
    );
  }

  // 2. Conflicting reuse, checked BEFORE expiry.
  //
  // While the record is in hand, the system still knows enough to refuse. Once
  // it is gone, it never will again. So a same-key/different-payload arrival is
  // a conflict even past the retention window: the weaker answer is available
  // for free later, and the stronger answer is available only now. ADR-001.
  if (record.fingerprint !== incoming.fingerprint) return "CONFLICT";

  // 3. Still running.
  //
  // Not "wait and then replay" -- that is a different, blocking contract. The
  // caller is told the work is in flight and must not start a second effect.
  // An in-progress record that is very old is a stuck operation, which is a
  // lifecycle problem and belongs to the durable-state-machine article, not
  // here. It stays IN_PROGRESS rather than silently becoming available.
  if (record.completedAtMs === null) return "IN_PROGRESS";

  // 4. Completed, but no longer authoritative.
  //
  // The record is present and past its window. A system may still refuse or
  // replay; what it must not do is pretend the window did not exist. Signalling
  // EXPIRED keeps that decision explicit at the call site.
  if (nowMs - record.completedAtMs >= retentionMs) return "EXPIRED";

  // 5. Completed and authoritative: return what was recorded, run nothing.
  return "REPLAY";
}

/** Whether a decision permits running the business logic. */
export function admits(decision: Decision): boolean {
  return decision === "FIRST" || decision === "EXPIRED";
}

/**
 * Whether a decision is safe to retry later.
 *
 * `CONFLICT` is not: the request was wrong, and sending it again will be wrong
 * in the same way. `IN_PROGRESS` is: the operation is running and the caller
 * should ask again rather than start a second one.
 */
export function retryable(decision: Decision): boolean {
  return decision === "IN_PROGRESS";
}
