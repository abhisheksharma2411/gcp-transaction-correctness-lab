import type {
  AdmissionPolicy,
  Disposition,
  Job,
  RejectReason,
  TenantId,
} from "./types.ts";

export interface QueueView {
  readonly depth: number;
  /** Age of the oldest waiting job, in virtual ms. */
  readonly oldestAgeMs: number;
  /** Jobs currently waiting, per tenant. */
  readonly perTenantDepth: ReadonlyMap<TenantId, number>;
  /**
   * Measured drain rate: worker slots divided by *observed* mean service time.
   *
   * The controller is co-located with the worker pool, so it knows the pool
   * size it was configured with and it measures how long work is actually
   * taking. That second half is what makes this adaptive: when the database
   * slows down, observed service time rises, the drain estimate falls, and the
   * controller starts refusing work before the queue has visibly grown.
   */
  readonly drainRatePerSec: number;
  /** Worker slots currently idle. */
  readonly freeSlots: number;
  /** Reservations accepted but not yet completed or expired. */
  readonly outstandingReservations: number;
}

export interface AdmissionDecision {
  readonly disposition: Extract<Disposition, "ADMITTED" | "REJECTED" | "DEFERRED">;
  readonly reason: RejectReason;
  /** What the controller believed the wait would be, for later comparison. */
  readonly projectedWaitMs: number;
}

/**
 * How long this arrival should expect to wait.
 *
 * If a slot is free and nobody is ahead, the answer is zero. Otherwise it is
 * the number of jobs that must drain before this one, divided by the rate at
 * which the system is actually draining them.
 */
export function projectWaitMs(view: QueueView): number {
  const ahead = Math.max(0, view.depth - view.freeSlots);
  if (ahead === 0) return 0;
  if (view.drainRatePerSec <= 0) return Number.POSITIVE_INFINITY;
  return (ahead / view.drainRatePerSec) * 1000;
}

/**
 * How long THIS TENANT should expect to wait, assuming the worker serves
 * tenants fairly rather than first-come-first-served.
 *
 * This distinction is the whole of fairness, and getting it wrong is subtle.
 * A per-tenant ceiling alone does not protect a small tenant: the noisy
 * neighbour legitimately fills its own allowance, the GLOBAL queue becomes
 * deep, and the global promise check then refuses everyone -- including the
 * tenant that is well inside its share. Negative control N1 caught exactly
 * that, and the first version of this controller failed it.
 *
 * Under fair service a tenant waits behind its own backlog, not behind its
 * neighbour's. So the projection uses the requesting tenant's own depth and
 * its share of the drain rate.
 */
export function projectTenantWaitMs(view: QueueView, tenant: TenantId): number {
  const tenantDepth = view.perTenantDepth.get(tenant) ?? 0;
  let active = 0;
  for (const depth of view.perTenantDepth.values()) if (depth > 0) active += 1;
  active = Math.max(1, active);

  const ahead = Math.max(0, tenantDepth - Math.floor(view.freeSlots / active));
  if (ahead === 0) return 0;

  const tenantDrainPerSec = view.drainRatePerSec / active;
  if (tenantDrainPerSec <= 0) return Number.POSITIVE_INFINITY;
  return (ahead / tenantDrainPerSec) * 1000;
}

/**
 * The admission decision, isolated so it can be tested on its own and so the
 * article can point at one function and say "this is the policy."
 *
 * Order matters and is deliberate:
 *
 *   1. Age before depth. A shallow queue that is not draining is worse than a
 *      deep one that is. Depth alone is a lagging signal once service time
 *      degrades.
 *   2. Fairness before capacity. One tenant must not be able to consume the
 *      whole protected envelope even while capacity remains, or the platform
 *      has no answer when a single large merchant runs a flash sale.
 *   3. Promise last. This is the check that turns "we are busy" into a number
 *      the caller can act on.
 *
 * `deferrable` work is offered a reservation instead of a refusal. Work that
 * must be synchronous is refused outright, because accepting it would be a
 * promise the system has already calculated it cannot keep.
 */
export function decide(
  policy: AdmissionPolicy,
  view: QueueView,
  tenant: TenantId,
  deferrable: boolean,
): AdmissionDecision {
  const projectedWaitMs = policy.fairShareProjection
    ? projectTenantWaitMs(view, tenant)
    : projectWaitMs(view);

  // Deferral is offered only while the reservation backlog is itself bounded.
  // Past that point even deferrable work is refused, because an accepted
  // reservation the system cannot honour is a worse answer than a refusal.
  const canDefer = deferrable && view.outstandingReservations < policy.maxReservations;
  const reject = (reason: RejectReason): AdmissionDecision =>
    canDefer
      ? { disposition: "DEFERRED", reason, projectedWaitMs }
      : { disposition: "REJECTED", reason, projectedWaitMs };

  if (view.oldestAgeMs > policy.maxQueueAgeMs) {
    return reject("QUEUE_FULL");
  }

  const tenantDepth = view.perTenantDepth.get(tenant) ?? 0;
  const tenantCeiling = Math.max(1, Math.floor(policy.maxQueueDepth * policy.maxTenantShare));
  if (tenantDepth >= tenantCeiling) {
    return reject("TENANT_SHARE_EXCEEDED");
  }

  if (view.depth >= policy.maxQueueDepth) {
    return reject("QUEUE_FULL");
  }

  if (projectedWaitMs > policy.promiseMs) {
    return reject("PROJECTED_WAIT_EXCEEDS_PROMISE");
  }

  return { disposition: "ADMITTED", reason: "NONE", projectedWaitMs };
}

/** Jobs whose tenant id ends in `-async` may be deferred rather than refused. */
export function isDeferrable(job: Job): boolean {
  return job.tenant.endsWith("-async");
}
