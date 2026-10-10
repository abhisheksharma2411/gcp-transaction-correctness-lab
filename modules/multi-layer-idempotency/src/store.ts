// The idempotency store.
//
// Models a database table with a primary key on the operation id and a unique
// constraint on the protected business reference. In-memory and deterministic;
// the shape is what matters, not the engine.

import type { Decision, OperationContext, OperationRecord, Outcome } from "./types.ts";

export class UniquenessViolation extends Error {
  readonly businessRef: string;
  readonly heldBy: string;

  constructor(businessRef: string, heldBy: string) {
    super(`business reference ${businessRef} is already held by operation ${heldBy}`);
    this.businessRef = businessRef;
    this.heldBy = heldBy;
  }
}

export class IdempotencyStore {
  readonly #byOperation = new Map<string, OperationRecord>();
  /**
   * The business-uniqueness index.
   *
   * This is deliberately *not* subject to the retention window. An idempotency
   * key is a de-duplication convenience with a finite life; a business
   * constraint is a statement about the world that does not expire. Keeping
   * them separate is what stops an evicted key from becoming a second charge.
   */
  readonly #byBusinessRef = new Map<string, string>();
  #evicted = 0;
  /** Negative control only: a store with no business constraint. */
  readonly #enforceUniqueness: boolean;

  constructor(enforceUniqueness = true) {
    this.#enforceUniqueness = enforceUniqueness;
  }

  /** What the store holds, or null. Does not consider expiry; `decide` does. */
  get(operationId: string): OperationRecord | null {
    return this.#byOperation.get(operationId) ?? null;
  }

  heldBy(businessRef: string): string | null {
    return this.#byBusinessRef.get(businessRef) ?? null;
  }

  /**
   * Claim an operation id and its business reference together.
   *
   * Both in one step, because claiming the key without the constraint leaves a
   * window in which a second operation id can claim the same business thing.
   */
  begin(ctx: OperationContext, nowMs: number): OperationRecord {
    const existing = this.#byBusinessRef.get(ctx.businessRef);
    if (this.#enforceUniqueness && existing !== undefined && existing !== ctx.operationId) {
      throw new UniquenessViolation(ctx.businessRef, existing);
    }
    const record: OperationRecord = {
      operationId: ctx.operationId,
      businessRef: ctx.businessRef,
      fingerprint: ctx.fingerprint,
      startedAtMs: nowMs,
      completedAtMs: null,
      outcome: null,
      response: undefined,
      effectIds: [],
      arrivals: [],
    };
    this.#byOperation.set(ctx.operationId, record);
    this.#byBusinessRef.set(ctx.businessRef, ctx.operationId);
    return record;
  }

  complete(operationId: string, outcome: Outcome, response: unknown, nowMs: number): void {
    const r = this.#byOperation.get(operationId);
    if (r === undefined) throw new Error(`cannot complete unknown operation ${operationId}`);
    if (r.completedAtMs !== null && r.outcome !== "UNKNOWN") {
      throw new Error(`operation ${operationId} already completed as ${r.outcome}`);
    }
    r.completedAtMs = nowMs;
    r.outcome = outcome;
    r.response = response;
  }

  recordArrival(operationId: string, origin: OperationContext["origin"], decision: Decision, atMs: number): void {
    this.#byOperation.get(operationId)?.arrivals.push({ origin, atMs, decision });
  }

  /**
   * Physically remove completed records past their window.
   *
   * This is the TTL a real table would have, and running it is what turns a
   * duplicate into something indistinguishable from a first request. The
   * business-reference index is deliberately left intact.
   */
  evictExpired(nowMs: number, retentionMs: number): number {
    let n = 0;
    for (const [id, r] of this.#byOperation) {
      if (r.completedAtMs !== null && nowMs - r.completedAtMs >= retentionMs) {
        this.#byOperation.delete(id);
        n += 1;
      }
    }
    this.#evicted += n;
    return n;
  }

  get evictedCount(): number {
    return this.#evicted;
  }

  all(): readonly OperationRecord[] {
    return [...this.#byOperation.values()];
  }
}
